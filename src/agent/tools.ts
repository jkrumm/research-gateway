import { tool } from 'ai'
import type { Tool } from 'ai'
import { z } from 'zod'
import { tavily } from '@tavily/core'
import { parseHTML } from 'linkedom'
import { Readability } from '@mozilla/readability'
import { env } from '../env.js'
import { assertPublicHttpUrl } from '../lib/ssrf.js'
import { log } from '../lib/log.js'
import { reportTavilyUsage, reportSonarUsage } from '../lib/usage.js'
import { normalizeText, capText, TEXT_CAP } from './extract.js'
import { buildDirectSourceTools } from './direct-sources.js'
import { sonarSearch, type SonarContextSize } from './sonar.js'
import { resolveSite } from './site-adapters.js'
import type { RetrievalLedger } from './ledger.js'

const tvly = tavily({ apiKey: env.TAVILY_API_KEY })

// Per-job usage accumulator. `buildTools` is called once per WORKER (see worker.ts), and a
// job fans out many workers in parallel (run.ts's dispatchRound), so this state can't live
// in a tool-local closure the way the searched/fetched dedup maps do — it has to be keyed
// by jobId at module scope, shared across every worker of every concurrent job the process
// is running. Nothing in this file is ever told a job has finished (run.ts/run-job.ts own
// that lifecycle and are out of scope for this change), so entries are pruned
// opportunistically by age instead of on job completion.
interface JobMeterEntry<T> {
  total: T
  lastSeenAt: number
  flushTimer: ReturnType<typeof setTimeout> | null
}

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

// Builds a per-job accumulator with the prune-and-debounce behaviour described above. One
// instance per billed backend, each owning its own map so a job that used both (Sonar
// primary, Tavily fallback) reports two independent rows.
function createJobMeter<T>(args: {
  add: (prev: T | undefined, delta: T) => T
  flush: (jobId: string, total: T) => void
}): { add: (jobId: string, delta: T) => void; read: (jobId: string) => T | undefined } {
  const entries = new Map<string, JobMeterEntry<T>>()

  // Same running total the debounced flush reports, readable synchronously so a finishing
  // job can put its own search spend in its result (see run.ts). Deliberately does NOT
  // clear the entry: the debounced flush may still be pending, and the age-based prune
  // already owns cleanup.
  const read = (jobId: string): T | undefined => entries.get(jobId)?.total

  const add = (jobId: string, delta: T): void => {
    const now = Date.now()
    for (const [id, entry] of entries) {
      if (now - entry.lastSeenAt > STALE_JOB_MS) {
        if (entry.flushTimer) clearTimeout(entry.flushTimer)
        entries.delete(id)
      }
    }

    const existing = entries.get(jobId)
    if (existing?.flushTimer) clearTimeout(existing.flushTimer)

    const entry: JobMeterEntry<T> = {
      total: args.add(existing?.total, delta),
      lastSeenAt: now,
      flushTimer: null,
    }
    entry.flushTimer = setTimeout(() => {
      entry.flushTimer = null
      args.flush(jobId, entry.total)
    }, CREDIT_FLUSH_DEBOUNCE_MS)
    // .unref() so a pending flush can never hold the process open — same pattern as
    // job-store.ts's _sweepTimer.
    if (typeof entry.flushTimer.unref === 'function') entry.flushTimer.unref()

    entries.set(jobId, entry)
  }

  return { add, read }
}

// Credits a Tavily call actually billed — ground truth from the response's `usage.credits`
// (see buildFetchPageTool below), not a hardcoded rate table that would drift the moment
// Tavily repriced a tier.
const meterTavily = createJobMeter<number>({
  add: (prev, delta) => (prev ?? 0) + delta,
  flush: (jobId, credits) => void reportTavilyUsage({ jobId, credits }),
})

function addTavilyCredits(jobId: string, credits: number): void {
  if (credits <= 0) return
  meterTavily.add(jobId, credits)
}

export interface SonarTotals {
  costUsd: number
  inputTokens: number
  outputTokens: number
  searchCalls: number
  searchQueries: number
}

// Perplexity prices each call itself and returns the USD in `usage.cost`, so unlike the
// Tavily meter this one accumulates money rather than an uncosted credit count.
const meterSonar = createJobMeter<SonarTotals>({
  add: (prev, delta) => ({
    costUsd: (prev?.costUsd ?? 0) + delta.costUsd,
    inputTokens: (prev?.inputTokens ?? 0) + delta.inputTokens,
    outputTokens: (prev?.outputTokens ?? 0) + delta.outputTokens,
    searchCalls: (prev?.searchCalls ?? 0) + delta.searchCalls,
    searchQueries: (prev?.searchQueries ?? 0) + delta.searchQueries,
  }),
  flush: (jobId, total) =>
    void reportSonarUsage({ jobId, model: env.SONAR_MODEL, ...total }),
})

// Per-job search spend, readable when a job finishes so it can travel in the job's own
// result instead of only reaching argo. Without this the only way to price a single run was
// to difference argo's cumulative counter between jobs — which works exactly as long as no
// two jobs overlap, i.e. not at RESEARCH_MAX_CONCURRENCY > 1, and never for a client.
export interface JobSearchSpend {
  sonarCostUsd: number
  sonarCalls: number
  tavilyCredits: number
}

export function readSearchSpend(jobId: string): JobSearchSpend {
  const sonar = meterSonar.read(jobId)
  return {
    sonarCostUsd: sonar?.costUsd ?? 0,
    sonarCalls: sonar?.searchCalls ?? 0,
    tavilyCredits: meterTavily.read(jobId) ?? 0,
  }
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

// What `searchWeb` hands the model, identical across backends so the worker prompt and the
// grounding rules never have to know which one answered. `published` is Sonar-only — Tavily
// does not date its results — and is omitted rather than nulled when absent.
interface SearchOutput {
  answer: string | null
  results: Array<{ title: string; url: string; content: string; published?: string }>
}

// A search result is a candidate, not a consulted source: it is recorded on the ledger as
// `snippet`, NOT `retrieved`. That distinction is load-bearing — a claim resting on a
// snippet is capped at `medium` confidence (see ground.ts), while only a page actually read
// can carry `high`. It is also what keeps Sonar honest: its URLs enter at the same tier as
// any other search hit, so nothing Perplexity asserts can be cited as verified.
async function searchViaSonar(args: {
  query: string
  contextSize: SonarContextSize
  maxResults: number
  ledger: RetrievalLedger
  jobId: string
}): Promise<SearchOutput> {
  const r = await sonarSearch({
    query: args.query,
    contextSize: args.contextSize,
    maxResults: args.maxResults,
  })

  meterSonar.add(args.jobId, {
    costUsd: r.usage.costUsd,
    inputTokens: r.usage.inputTokens,
    outputTokens: r.usage.outputTokens,
    searchCalls: 1,
    searchQueries: r.usage.searchQueries,
  })

  log('tool.searchWeb', {
    jobId: args.jobId,
    query: args.query,
    via: 'sonar',
    contextSize: args.contextSize,
    results: r.results.length,
    costUsd: r.usage.costUsd,
  })

  return {
    // Sonar's synthesized answer is deliberately dropped — see the header comment in
    // sonar.ts. `null` keeps the shape identical to the Tavily path.
    answer: null,
    results: r.results.map((x) => {
      if (x.snippet.length > 0) args.ledger.recordSnippet(x.url)
      return {
        title: x.title,
        url: x.url,
        content: x.snippet,
        ...(x.published ? { published: x.published } : {}),
      }
    }),
  }
}

async function searchViaTavily(args: {
  query: string
  searchDepth: 'basic' | 'advanced'
  maxResults: number
  ledger: RetrievalLedger
  jobId: string
}): Promise<SearchOutput> {
  // `timeout` is SECONDS in @tavily/core (default 60) — not milliseconds.
  const r = await tvly.search(args.query, {
    searchDepth: args.searchDepth,
    // Same fan-out dial as the Sonar path, so a fallback mid-job doesn't silently change
    // how many candidates a worker is weighing.
    maxResults: args.maxResults,
    includeAnswer: true,
    timeout: 30,
    // Ground truth for billing: Tavily's own credit cost for THIS call, which varies by
    // searchDepth (basic vs advanced).
    includeUsage: true,
  })
  // A response that resolved is a call that was billed — count it even if the search itself
  // came back empty. A call that throws (never resolves) is NOT counted: whether Tavily
  // billed a request it never answered is unknown, and undercounting is the safer direction
  // for a cost figure.
  addTavilyCredits(args.jobId, r.usage?.credits ?? 0)
  log('tool.searchWeb', {
    jobId: args.jobId,
    query: args.query,
    via: 'tavily',
    searchDepth: args.searchDepth,
    results: r.results.length,
  })

  return {
    answer: r.answer ?? null,
    results: r.results.map((x) => {
      const c = x.content ?? ''
      if (c.length > 0) args.ledger.recordSnippet(x.url)
      return {
        title: x.title,
        url: x.url,
        content: c.length > 1_000 ? c.slice(0, 1_000) + '...' : c,
      }
    }),
  }
}

function buildSearchWebTool(args: {
  searchDepth: 'basic' | 'advanced'
  contextSize: SonarContextSize
  maxResults: number
  maxSearches: number
  ledger: RetrievalLedger
  jobId: string
}): AnyTool {
  const { searchDepth, contextSize, maxResults, maxSearches, ledger, jobId } = args

  // Per-run search dedup, mirroring fetchPage's. Search is a metered resource on either
  // backend, and a re-issued identical query returns identical results — so it burns budget
  // for nothing.
  const searched = new Map<string, SearchOutput>()

  // Per-WORKER budget: `buildTools` is called once per worker (worker.ts), so this closure
  // counts exactly one worker's searches. Only BILLED searches count — a cache hit is free
  // and a failure that reached no backend bought nothing. See DepthProfile.maxSearches for
  // why this is enforced here instead of asked for in the prompt.
  let spent = 0

  // Sonar first, Tavily as a per-call fallback. The fallback is not redundancy theatre: a
  // Perplexity outage, a 429 against IU's shared account tier, or IU re-routing Sonar
  // through a normalizing gateway (which empties `search_results`) would otherwise take
  // search down entirely — and Tavily is already wired up as fetchPage's Extract path, so
  // the second backend costs nothing to keep available. It does silently move spend back
  // onto the personal key, which is why every fallback is logged as such.
  const backends: Array<'sonar' | 'tavily'> =
    env.SEARCH_PROVIDER === 'sonar' ? ['sonar', 'tavily'] : ['tavily']

  return tool({
    description:
      'Search the web to find candidate sources. Returns result snippets with URLs, and a publication date where the backend provides one.',
    inputSchema: z.object({
      query: z.string().describe('The search query'),
    }),
    // Search depth/context is set by the job's research depth, not chosen per-call: a `deep`
    // job must search deeply. Exposing it let the model silently downgrade and halve the
    // sources a deep pass found.
    execute: async ({ query }) => {
      const cacheKey = `${searchDepth}:${contextSize}:${maxResults}:${query.trim().toLowerCase()}`
      const cached = searched.get(cacheKey)
      if (cached !== undefined) {
        log('tool.searchWeb', { jobId, query, via: 'cache' })
        return cached
      }

      if (spent >= maxSearches) {
        log('tool.searchWeb', { jobId, query, via: 'budget', spent, maxSearches })
        return {
          error: `search budget exhausted (${maxSearches} searches used). Do not search again — read the most promising pages you have already found with fetchPage, and report anything still unresolved in openGaps.`,
          results: [],
        }
      }

      // Counted once per attempt, before any backend runs — a Sonar failure that falls back
      // to Tavily is ONE search from the worker's point of view, and a search that fails on
      // every backend still spends budget. Not charging failures would hand a worker stuck
      // in a failure loop unlimited retries, which is the exact behaviour the worker prompt
      // warns against ("do NOT retry it in a loop").
      spent++

      // A search failure must degrade to a tool-visible error, never throw: an uncaught
      // throw here propagates out of the agent loop and kills the whole worker, losing every
      // digest it had gathered. fetchPage/libraryDocs already follow this pattern.
      let lastError = 'no search backend configured'
      for (const backend of backends) {
        try {
          const out =
            backend === 'sonar'
              ? await searchViaSonar({ query, contextSize, maxResults, ledger, jobId })
              : await searchViaTavily({ query, searchDepth, maxResults, ledger, jobId })
          // Only successes are cached — a transient failure must not permanently poison a query.
          searched.set(cacheKey, out)
          return out
        } catch (err) {
          lastError = String(err)
          log('tool.searchWeb', { jobId, query, via: backend, error: lastError })
        }
      }

      return { error: `search failed: ${lastError}`, results: [] }
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

      // Some hosts need a different address, a different reader, or both (site-adapters.ts).
      // Everything below fetches `fetchUrl`; everything the ledger and the caller see stays
      // `url`, because that is what a citation will name.
      const site = resolveSite(url)
      const fetchUrl = site.fetchUrl
      if (fetchUrl !== url) log('tool.fetchPage', { jobId, url, via: 'rewrite', fetchUrl })

      // SSRF guard — refuse any non-public URL before making any fetch. Guards the address
      // actually dialled, not the one asked for.
      try {
        await assertPublicHttpUrl(fetchUrl)
      } catch (err) {
        ledger.recordFailed(url, `refused: ${String(err)}`)
        log('tool.fetchPage', { jobId, url, via: 'refused' })
        return { url, error: `refused: ${String(err)}` }
      }

      // Primary: fetch + linkedom + readability
      let rdReason: 'thin' | 'threw' = 'thin'
      let rdChars = 0
      try {
        const res = await safeFetch(fetchUrl, jobId)
        if (res.ok) {
          const html = await res.text()
          const { document } = parseHTML(html)
          // A site adapter reads its own markup; anything else, and any adapter that does
          // not recognise what it got, falls through to Readability unchanged.
          const adapted = site.extract ? site.extract(document as never) : null
          const article = adapted
            ? null
            : new Readability(document as unknown as ConstructorParameters<typeof Readability>[0]).parse()
          const raw = adapted ?? article?.textContent?.trim()
          const text = raw ? normalizeText(raw) : raw
          rdChars = text?.length ?? 0
          if (text && text.length >= 200) {
            fetched.add(url)
            ledger.recordRetrieved(url)
            log('tool.fetchPage', { jobId, url, via: adapted ? 'site-adapter' : 'readability', chars: text.length })
            return { url, text: capText(text, TEXT_CAP) }
          }
        }
      } catch {
        // fetch or linkedom failed — fall through to Tavily Extract
        rdReason = 'threw'
      }

      // Fallback: Tavily Extract
      try {
        const ex = await tvly.extract([fetchUrl], {
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

export function buildTools(args: {
  ledger: RetrievalLedger
  jobId?: string
  searchDepth?: 'basic' | 'advanced'
  contextSize?: SonarContextSize
  maxResults?: number
  maxSearches?: number
}): Record<string, AnyTool> {
  const { ledger, searchDepth = 'basic', contextSize = 'low', maxResults = 5, maxSearches = 4 } = args
  const jid = args.jobId ?? '-'
  const tools: Record<string, AnyTool> = {
    searchWeb: buildSearchWebTool({
      searchDepth,
      contextSize,
      maxResults,
      maxSearches,
      ledger,
      jobId: jid,
    }),
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
