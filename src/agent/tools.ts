import { tool } from 'ai'
import type { Tool } from 'ai'
import { z } from 'zod'
import { tavily } from '@tavily/core'
import { env } from '../env.js'
import { log } from '../lib/log.js'
import { reportTavilyUsage, reportSonarUsage, reportRenderUsage, reportYtdlpUsage } from '../lib/usage.js'
import { reportTavilyAccountUsage } from '../lib/tavily-account.js'
import { capText, TEXT_CAP } from './extract.js'
import { buildDirectSourceTools } from './direct-sources.js'
import { sonarSearch, type SonarContextSize } from './sonar.js'
import { runFetchChain } from './fetch-chain.js'
import { normalizeUrl, type RetrievalLedger } from './ledger.js'

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

// `tavilyCredits` reads 0 for essentially all page extraction. This has been written up
// repeatedly as a wrong-field bug in this repo's own notes. It is not one — `@tavily/core`
// sends `include_usage: true` and surfaces `response.data.usage` correctly, and the zero
// comes from the API. Measured directly against api.tavily.com from the VPS on 2026-08-03,
// `@tavily/core@0.7.6`:
//
//   1 URL per extract call  -> usage.credits = 0   (4 separate calls, fresh and cached URLs)
//   2 URLs per extract call -> usage.credits = 1
//   5 URLs per extract call -> usage.credits = 1
//   search (any)            -> usage.credits = 1   (correct)
//
// `fetchPage` extracts exactly ONE url per call, so `usage.credits` is structurally always 0
// on that path, forever, no matter the volume. Ground truth exists at `GET
// https://api.tavily.com/usage`, which reported `extract_usage: 75` against `search_usage:
// 1064` at measurement time — extracts ARE billed, the per-response field just cannot see it
// at our call shape. The fix is therefore not to change how credits are read, but to count
// the thing we CAN count — extract calls — instead of letting one credit number imply it
// covers extraction. The numbers above are the answer; re-measure only if Tavily reprices.
const meterTavily = createJobMeter<{ credits: number; searchCalls: number; extractCalls: number }>({
  add: (prev, delta) => ({
    credits: (prev?.credits ?? 0) + delta.credits,
    searchCalls: (prev?.searchCalls ?? 0) + delta.searchCalls,
    extractCalls: (prev?.extractCalls ?? 0) + delta.extractCalls,
  }),
  flush: (jobId, total) => {
    void reportTavilyUsage({
      jobId,
      credits: total.credits,
      searchCalls: total.searchCalls,
      extractCalls: total.extractCalls,
    })
    // Piggybacks the account-level `GET /usage` read onto every job-scoped flush, so it
    // happens near real spend instead of on a fixed schedule — see tavily-account.ts for the
    // internal 10-min throttle that makes this safe to call on every flush. `void`: an
    // account-usage read must never delay or fail the job-scoped flush it rides in on.
    void reportTavilyAccountUsage()
  },
})

// Search path: `usage.credits` is correct here (see the table above), so a non-billing
// response (credits <= 0) genuinely means nothing was billed and is skipped.
function recordTavilySearch(jobId: string, credits: number): void {
  if (credits <= 0) return
  meterTavily.add(jobId, { credits, searchCalls: 1, extractCalls: 0 })
}

// Extract path: 0 credits is the NORMAL case (single-URL calls, per the table above), so —
// unlike recordTavilySearch — this must NOT early-return on credits <= 0. The call still
// happened and still has to be counted, or extraction volume stays invisible exactly the way
// this whole change exists to fix.
function recordTavilyExtract(jobId: string, credits: number): void {
  meterTavily.add(jobId, { credits, searchCalls: 0, extractCalls: 1 })
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

// Lightpanda renders were previously visible only in container logs (gone on redeploy). One
// meter entry per render ATTEMPT, whether it succeeded, produced thin/parse-failure content,
// or threw — see fetch-chain.ts's onRender call sites, which fire in all three cases.
const meterRender = createJobMeter<{ renders: number; failures: number; totalMs: number }>({
  add: (prev, delta) => ({
    renders: (prev?.renders ?? 0) + delta.renders,
    failures: (prev?.failures ?? 0) + delta.failures,
    totalMs: (prev?.totalMs ?? 0) + delta.totalMs,
  }),
  flush: (jobId, total) => void reportRenderUsage({ jobId, ...total }),
})

export function readRenderStats(jobId: string): { renders: number; failures: number; totalMs: number } {
  return meterRender.read(jobId) ?? { renders: 0, failures: 0, totalMs: 0 }
}

// yt-dlp calls were previously visible only in container logs. Mirrors meterRender exactly —
// one entry per call ATTEMPT (transcript fetch or video search), whether it succeeded or
// failed, fired from the two call sites that actually spawn the binary: fetchPage's
// skipToExtract step (fetch-chain.ts's onYtdlp) and findVideos (direct-sources.ts's onYtdlp).
const meterYtdlp = createJobMeter<{ calls: number; failures: number; totalMs: number }>({
  add: (prev, delta) => ({
    calls: (prev?.calls ?? 0) + delta.calls,
    failures: (prev?.failures ?? 0) + delta.failures,
    totalMs: (prev?.totalMs ?? 0) + delta.totalMs,
  }),
  flush: (jobId, total) => void reportYtdlpUsage({ jobId, ...total }),
})

export function readYtdlpStats(jobId: string): { calls: number; failures: number; totalMs: number } {
  return meterYtdlp.read(jobId) ?? { calls: 0, failures: 0, totalMs: 0 }
}

// Per-job search spend, readable when a job finishes so it can travel in the job's own
// result instead of only reaching argo. Without this the only way to price a single run was
// to difference argo's cumulative counter between jobs — which works exactly as long as no
// two jobs overlap, i.e. not at RESEARCH_MAX_CONCURRENCY > 1, and never for a client.
export interface JobSearchSpend {
  sonarCostUsd: number
  sonarCalls: number
  tavilyCredits: number
  tavilySearchCalls: number
  tavilyExtractCalls: number
}

export function readSearchSpend(jobId: string): JobSearchSpend {
  const sonar = meterSonar.read(jobId)
  const tavily = meterTavily.read(jobId)
  return {
    sonarCostUsd: sonar?.costUsd ?? 0,
    sonarCalls: sonar?.searchCalls ?? 0,
    tavilyCredits: tavily?.credits ?? 0,
    tavilySearchCalls: tavily?.searchCalls ?? 0,
    tavilyExtractCalls: tavily?.extractCalls ?? 0,
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
  recordTavilySearch(args.jobId, r.usage?.credits ?? 0)
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
  /**
   * Query BOTH backends and merge, instead of using Tavily only as a fallback. Measured on
   * the 5-query benchmark set: Sonar surfaced 36 unique domains, Tavily 45, and only 14 were
   * shared — 2-3 per query out of 12 results each. They are complementary slices of the web,
   * not substitutes, so merging roughly doubles the domain base a worker gets to choose from.
   *
   * It is NOT free: every dual search bills a Tavily credit against the personal plan, which
   * the Sonar migration existed to stop. That is why it is opt-in per round rather than a
   * global setting — see DepthProfile.dualSearchFirstRound.
   */
  dualSearch: boolean
  ledger: RetrievalLedger
  jobId: string
}): AnyTool {
  const { searchDepth, contextSize, maxResults, maxSearches, dualSearch, ledger, jobId } = args

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
      const cacheKey = `${searchDepth}:${contextSize}:${maxResults}:${dualSearch}:${query.trim().toLowerCase()}`
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
      if (dualSearch) {
        // Both backends, merged. Settled rather than awaited in sequence: they are
        // independent calls and one failing must not cost the other's results — a dual
        // search that loses Tavily is still a perfectly good Sonar search, and vice versa.
        const [sonar, tavily] = await Promise.allSettled([
          searchViaSonar({ query, contextSize, maxResults, ledger, jobId }),
          searchViaTavily({ query, searchDepth, maxResults, ledger, jobId }),
        ])
        const parts = [sonar, tavily].filter((r) => r.status === 'fulfilled').map((r) => r.value)
        if (parts.length > 0) {
          // Interleave rather than concatenate, so neither backend's tail outranks the
          // other's head — the model reads this list top-down and the first entries are the
          // ones it fetches. Dedup is by normalized URL (ledger.ts), which is what makes a
          // `www.` variant from one backend collapse onto the other's plain host.
          const seen = new Set<string>()
          const merged: SearchOutput['results'] = []
          for (let i = 0; i < maxResults; i++) {
            for (const part of parts) {
              const hit = part.results[i]
              if (!hit) continue
              const key = normalizeUrl(hit.url)
              if (seen.has(key)) continue
              seen.add(key)
              merged.push(hit)
            }
          }
          const out: SearchOutput = { answer: null, results: merged }
          log('tool.searchWeb', {
            jobId,
            query,
            via: 'dual',
            backends: parts.length,
            merged: merged.length,
            deduped: parts.reduce((n, p) => n + p.results.length, 0) - merged.length,
          })
          searched.set(cacheKey, out)
          return out
        }
        log('tool.searchWeb', { jobId, query, via: 'dual', error: 'both backends failed' })
      }

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
      'Fetch the main text content of a URL. Uses Mozilla Readability for clean article extraction; falls back to a JavaScript renderer and then Tavily Extract if readability fails or returns thin content. For a YouTube video URL this returns the full spoken transcript of the video.',
    inputSchema: z.object({
      url: z.string().describe('The URL to fetch'),
    }),
    execute: async ({ url }) => {
      if (fetched.has(url)) {
        log('tool.fetchPage', { jobId, url, via: 'cache' })
        return { url, text: 'Already fetched earlier in this conversation — reuse the previous result for this URL.' }
      }

      // The chain itself lives in fetch-chain.ts so it can be replayed and measured without
      // an LLM in the loop (scripts/fetch-bench.ts). This tool owns only what is specific to
      // being a tool: the per-run dedup above, and turning the result into a model-facing
      // shape. The chain never throws and records the ledger itself.
      const result = await runFetchChain(url, {
        ledger,
        jobId,
        onTavilyCredits: (credits) => recordTavilyExtract(jobId, credits),
        onRender: (r) => meterRender.add(jobId, { renders: 1, failures: r.ok ? 0 : 1, totalMs: r.ms }),
        onYtdlp: (r) => meterYtdlp.add(jobId, { calls: 1, failures: r.ok ? 0 : 1, totalMs: r.ms }),
      })

      if (result.text === null) return { url, error: result.error ?? 'fetch failed' }
      fetched.add(url)
      return { url, text: result.text }
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
  dualSearch?: boolean
}): Record<string, AnyTool> {
  const {
    ledger,
    searchDepth = 'basic',
    contextSize = 'low',
    maxResults = 5,
    maxSearches = 4,
    dualSearch = false,
  } = args
  const jid = args.jobId ?? '-'
  const tools: Record<string, AnyTool> = {
    searchWeb: buildSearchWebTool({
      searchDepth,
      contextSize,
      maxResults,
      maxSearches,
      dualSearch,
      ledger,
      jobId: jid,
    }),
    fetchPage: buildFetchPageTool(ledger, jid),
    // Deterministic source-of-truth lookups (registries, GitHub). Registered before the
    // optional libraryDocs tool so tools/list order stays stable across configurations.
    ...buildDirectSourceTools(ledger, jid, (r) =>
      meterYtdlp.add(jid, { calls: 1, failures: r.ok ? 0 : 1, totalMs: r.ms }),
    ),
  }

  const libraryDocsTool = buildLibraryDocsTool(ledger, jid)
  if (libraryDocsTool) {
    tools['libraryDocs'] = libraryDocsTool
  }

  return tools
}
