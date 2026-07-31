import { tool } from 'ai'
import type { Tool } from 'ai'
import { z } from 'zod'
import { tavily } from '@tavily/core'
import { parseHTML } from 'linkedom'
import { Readability } from '@mozilla/readability'
import { env } from '../env.js'
import { assertPublicHttpUrl } from '../lib/ssrf.js'
import { log } from '../lib/log.js'
import { reportTavilyUsage } from '../lib/usage.js'
import { normalizeText, capText, TEXT_CAP } from './extract.js'
import { buildDirectSourceTools } from './direct-sources.js'
import type { RetrievalLedger } from './ledger.js'

const tvly = tavily({ apiKey: env.TAVILY_API_KEY })

// Per-job Tavily credit accumulator. `buildTools` is called once per WORKER (see
// worker.ts), and a job fans out many workers in parallel (run.ts's dispatchRound), so
// this state can't live in a tool-local closure the way the searched/fetched dedup maps
// do — it has to be keyed by jobId at module scope, shared across every worker of every
// concurrent job the process is running. Nothing in this file is ever told a job has
// finished (run.ts/run-job.ts own that lifecycle and are out of scope for this change),
// so entries are pruned opportunistically by age instead of on job completion.
interface JobCreditState {
  credits: number
  lastSeenAt: number
  flushTimer: ReturnType<typeof setTimeout> | null
}
const jobCredits = new Map<string, JobCreditState>()

// Pruning is safe even though a deep job now runs ~28min (HANDOVER.md, re-measured
// post-fan-out-rewrite): `lastSeenAt` is refreshed on every credit added, so an active
// job's entry keeps sliding forward and is never pruned mid-flight. This bound only
// catches entries that have genuinely gone quiet — reusing JOB_TTL_MINUTES ties it to
// the same "definitely abandoned" horizon job-store.ts already uses for jobs themselves,
// rather than a fresh magic number.
const STALE_JOB_MS = env.JOB_TTL_MINUTES * 60_000

// A deep run fetches 200+ pages, each a Tavily-Extract fallback call plus however many
// searches — firing an argo POST per call would be 100-200+ POSTs/job, all upserting the
// SAME row (source_id is per-job, not per-call), across up to RESEARCH_MAX_CONCURRENCY
// jobs at once. Only the trailing (i.e. final, cumulative) value carries information, so
// the POST is debounced behind this per-job timer instead: every new credit resets it,
// and it fires once the job's Tavily calls actually stop — reporting the running total
// at that point, which becomes the job's true final total once no further calls arrive.
const CREDIT_FLUSH_DEBOUNCE_MS = 3_000

function pruneStaleJobCredits(now: number): void {
  for (const [id, entry] of jobCredits) {
    if (now - entry.lastSeenAt > STALE_JOB_MS) {
      if (entry.flushTimer) clearTimeout(entry.flushTimer)
      jobCredits.delete(id)
    }
  }
}

// Records credits a Tavily call actually billed (ground truth from the response's
// `usage.credits` — see buildSearchWebTool/buildFetchPageTool below) and schedules a
// debounced report of the job's cumulative total (see CREDIT_FLUSH_DEBOUNCE_MS above).
// argo upserts on source_id, so each flush just overwrites the last one rather than
// double-counting.
function addTavilyCredits(jobId: string, credits: number): void {
  if (credits <= 0) return
  const now = Date.now()
  pruneStaleJobCredits(now)

  const existing = jobCredits.get(jobId)
  if (existing?.flushTimer) clearTimeout(existing.flushTimer)

  const entry: JobCreditState = {
    credits: (existing?.credits ?? 0) + credits,
    lastSeenAt: now,
    flushTimer: null,
  }
  entry.flushTimer = setTimeout(() => {
    entry.flushTimer = null
    void reportTavilyUsage({ jobId, credits: entry.credits })
  }, CREDIT_FLUSH_DEBOUNCE_MS)
  // .unref() so a pending flush can never hold the process open — same pattern as
  // job-store.ts's _sweepTimer.
  if (typeof entry.flushTimer.unref === 'function') entry.flushTimer.unref()

  jobCredits.set(jobId, entry)
}

async function safeFetch(startUrl: string, jobId = '-', maxHops = 3): Promise<Response> {
  let current = startUrl
  for (let hop = 0; ; hop++) {
    await assertPublicHttpUrl(current) // re-validate EVERY hop (initial + each redirect target)
    const res = await fetch(current, {
      headers: { 'user-agent': 'research-gateway/0.1 (+research bot)' },
      signal: AbortSignal.timeout(10_000),
      redirect: 'manual',
    })
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (!loc) return res
      if (hop >= maxHops) throw new Error('too many redirects')
      const next = new URL(loc, current).toString() // resolve relative redirects
      log('tool.redirect', { jobId, from: current, to: next, status: res.status, hop: hop + 1 })
      current = next
      continue
    }
    return res
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = Tool<any, any>

function buildSearchWebTool(
  defaultSearchDepth: 'basic' | 'advanced',
  ledger: RetrievalLedger,
  jobId = '-',
): AnyTool {
  // Per-run search dedup, mirroring fetchPage's. Tavily credits are a hard-limited resource
  // (exceeding the key's cap fails the search outright), and a re-issued identical query
  // returns identical results — so it burns credit for nothing.
  const searched = new Map<string, unknown>()

  return tool({
    description:
      'Search the web to find candidate sources. Returns an answer summary and result snippets.',
    inputSchema: z.object({
      query: z.string().describe('The search query'),
    }),
    // Search depth is set by the job's research depth, not chosen per-call: a `deep` job
    // must search deeply. Exposing it let the model silently downgrade to basic and halve
    // the sources a deep pass found.
    execute: async ({ query }) => {
      const depth = defaultSearchDepth
      const cacheKey = `${depth}:${query.trim().toLowerCase()}`
      const cached = searched.get(cacheKey)
      if (cached !== undefined) {
        log('tool.searchWeb', { jobId, query, searchDepth: depth, via: 'cache' })
        return cached
      }

      // A search failure must degrade to a tool-visible error, never throw: an uncaught
      // throw here propagates out of the agent loop and kills the whole worker, losing
      // every digest it had gathered. fetchPage/libraryDocs already follow this pattern.
      // `timeout` is SECONDS in @tavily/core (default 60) — not milliseconds.
      try {
        const r = await tvly.search(query, {
          searchDepth: depth,
          maxResults: 5,
          includeAnswer: true,
          timeout: 30,
          // Ground truth for billing: Tavily's own credit cost for THIS call, which
          // varies by searchDepth (basic vs advanced). Reading it beats hardcoding a
          // rate table that would drift the moment Tavily repriced a tier.
          includeUsage: true,
        })
        // A response that resolved is a call that was billed — count it even if the
        // search itself came back empty. A call that throws below (never resolves)
        // is NOT counted: whether Tavily billed a request it never answered is
        // unknown, and undercounting is the safer direction for a cost figure.
        addTavilyCredits(jobId, r.usage?.credits ?? 0)
        log('tool.searchWeb', { jobId, query, searchDepth: depth, results: r.results.length })
        const out = {
          answer: r.answer ?? null,
          // A search result is a candidate, not a consulted source: it is recorded on the
          // ledger as `snippet`, NOT `retrieved`. That distinction is load-bearing — a
          // claim resting on a snippet is capped at `medium` confidence (see ground.ts),
          // while only a page actually read can carry `high`.
          results: r.results.map((x) => {
            const c = x.content ?? ''
            if (c.length > 0) ledger.recordSnippet(x.url)
            return {
              title: x.title,
              url: x.url,
              content: c.length > 1_000 ? c.slice(0, 1_000) + '...' : c,
            }
          }),
        }
        // Only successes are cached — a transient failure must not permanently poison a query.
        searched.set(cacheKey, out)
        return out
      } catch (err) {
        log('tool.searchWeb', { jobId, query, searchDepth: depth, error: String(err) })
        return { error: `search failed: ${String(err)}`, results: [] }
      }
    },
  })
}

function buildFetchPageTool(ledger: RetrievalLedger, jobId = '-'): AnyTool {
  // Per-run dedup: a URL fetched once is not fetched again. Re-fetching wastes network,
  // readability/Tavily-extract work, and budget; the model already has the content above.
  const fetched = new Set<string>()

  return tool({
    description:
      'Fetch the main text content of a URL. Uses Mozilla Readability for clean article extraction; falls back to Tavily Extract if readability fails or returns thin content.',
    inputSchema: z.object({
      url: z.string().describe('The URL to fetch'),
    }),
    execute: async ({ url }) => {
      if (fetched.has(url)) {
        log('tool.fetchPage', { jobId, url, via: 'cache' })
        return { url, text: 'Already fetched earlier in this conversation — reuse the previous result for this URL.' }
      }

      // SSRF guard — refuse any non-public URL before making any fetch
      try {
        await assertPublicHttpUrl(url)
      } catch (err) {
        ledger.recordFailed(url, `refused: ${String(err)}`)
        log('tool.fetchPage', { jobId, url, via: 'refused' })
        return { url, error: `refused: ${String(err)}` }
      }

      // Primary: fetch + linkedom + readability
      let rdReason: 'thin' | 'threw' = 'thin'
      let rdChars = 0
      try {
        const res = await safeFetch(url, jobId)
        if (res.ok) {
          const html = await res.text()
          const { document } = parseHTML(html)
          const article = new Readability(document as unknown as ConstructorParameters<typeof Readability>[0]).parse()
          const raw = article?.textContent?.trim()
          const text = raw ? normalizeText(raw) : raw
          rdChars = text?.length ?? 0
          if (text && text.length >= 200) {
            fetched.add(url)
            ledger.recordRetrieved(url)
            log('tool.fetchPage', { jobId, url, via: 'readability', chars: text.length })
            return { url, text: capText(text, TEXT_CAP) }
          }
        }
      } catch {
        // fetch or linkedom failed — fall through to Tavily Extract
        rdReason = 'threw'
      }

      // Fallback: Tavily Extract
      try {
        const ex = await tvly.extract([url], {
          extractDepth: 'basic',
          format: 'markdown',
          timeout: 30,
          includeUsage: true,
        })
        // The call resolved — Tavily billed it — regardless of whether this URL ends
        // up in `results` or `failedResults` below. This is what makes the 49
        // failed-fetch case in a recent deep run count correctly: a failed *extraction*
        // still billed the *call* that attempted it.
        addTavilyCredits(jobId, ex.usage?.credits ?? 0)
        const result = ex.results[0]
        if (result) {
          fetched.add(url)
          ledger.recordRetrieved(url)
          const text = normalizeText(result.rawContent)
          log('tool.fetchPage', { jobId, url, via: 'tavily-extract', chars: text.length, rdReason, rdChars })
          return { url, text: capText(text, TEXT_CAP) }
        }
        const failed = ex.failedResults[0]
        const reason = failed?.error ?? 'Tavily extract returned no content'
        // Both fetch paths are now exhausted — this URL is unverifiable for this run, and
        // the ledger is what makes it structurally ineligible as a citation source.
        ledger.recordFailed(url, reason)
        log('tool.fetchPage', { jobId, url, via: 'error' })
        return { url, error: reason }
      } catch (err) {
        ledger.recordFailed(url, String(err))
        log('tool.fetchPage', { jobId, url, via: 'error' })
        return { url, error: String(err) }
      }
    },
  })
}

function buildLibraryDocsTool(ledger: RetrievalLedger, jobId = '-'): AnyTool | null {
  if (!env.CONTEXT7_API_KEY) return null

  const apiKey = env.CONTEXT7_API_KEY

  return tool({
    description:
      'Look up curated documentation for a specific library or framework. Use this first for any question about a library API, version, or usage pattern — it is the most accurate source for library-specific questions.',
    inputSchema: z.object({
      library: z.string().describe('The library or framework name, e.g. "elysia" or "ai sdk"'),
      topic: z
        .string()
        .describe('The specific topic or API to look up, e.g. "generateText stopWhen"'),
    }),
    execute: async ({ library, topic }) => {
      try {
        const { Context7 } = await import('@upstash/context7-sdk')
        const c7 = new Context7({ apiKey })

        // searchLibrary(query, libraryName) — resolve the library id
        const libs = await c7.searchLibrary(topic, library)
        const topLib = libs[0]
        if (!topLib) {
          log('tool.libraryDocs', { jobId, library, topic, ok: false })
          return { error: `No library found matching "${library}"` }
        }

        // getContext(query, libraryId) — fetch relevant docs
        const docs = await c7.getContext(topic, topLib.id)
        if (!docs || docs.length === 0) {
          log('tool.libraryDocs', { jobId, library, topic, ok: false })
          return { error: `No documentation found for "${library}" on topic "${topic}"` }
        }

        const text = docs.map((d) => `## ${d.title}\n${d.content}`).join('\n\n')
        // Context7's `source` is a URL *or* an opaque snippet identifier. Only real URLs
        // belong in the report's sources — the rest would be uncheckable by a reader.
        for (const d of docs) {
          if (d.source?.startsWith('http')) ledger.recordRetrieved(d.source)
        }

        log('tool.libraryDocs', { jobId, library, topic, ok: true })
        return { library: topLib.name, libraryId: topLib.id, text: capText(text, TEXT_CAP) }
      } catch (err) {
        log('tool.libraryDocs', { jobId, library, topic, ok: false })
        return { error: String(err) }
      }
    },
  }) as AnyTool
}

export function buildTools(
  ledger: RetrievalLedger,
  jobId: string | undefined,
  searchDepth: 'basic' | 'advanced' = 'basic',
): Record<string, AnyTool> {
  const jid = jobId ?? '-'
  const tools: Record<string, AnyTool> = {
    searchWeb: buildSearchWebTool(searchDepth, ledger, jid),
    fetchPage: buildFetchPageTool(ledger, jid),
    // Deterministic source-of-truth lookups (registries, GitHub). Registered before the
    // optional libraryDocs tool so tools/list order stays stable across configurations.
    ...buildDirectSourceTools(ledger, jid),
  }

  const libraryDocsTool = buildLibraryDocsTool(ledger, jid)
  if (libraryDocsTool) {
    tools['libraryDocs'] = libraryDocsTool
  }

  return tools
}
