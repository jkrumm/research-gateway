import { tavily, type TavilyExtractResponse } from '@tavily/core'
import { env } from '../env.js'
import { assertPublicHttpUrl } from '../lib/ssrf.js'
import { log } from '../lib/log.js'
import { getActiveSpan } from '../lib/otel.js'
import { normalizeText, capText, TEXT_CAP } from './extract.js'
import { resolveSite } from './site-adapters.js'
import { extractText, readabilityText } from './html-parse.js'
import { isRawContentType, isDefinitivelyMissing, isPdf, isPdfContentType, looksBinary } from './response-kind.js'
import { extractPdfText } from './pdf.js'
import { readBoundedBytes, readCappedText, MAX_PDF_BYTES } from './pdf-extract.js'
import { parseRenderResponse, renderUrl } from './lightpanda.js'
import { fetchYoutubeTranscript } from './ytdlp.js'
import { waybackLookupUrl, isArchiveUrl, parseSnapshotDate, archiveBanner, snapshotAgeDays } from './archive.js'
import type { RetrievalLedger } from './ledger.js'
import { describeAttempts } from './fetch-guard.js'
import { classifyBlock, describeBlock, isJavaScriptShell } from './challenge.js'
import { policyFor, type ChainStage } from './host-policy.js'
import { createHostGate, parseRetryAfter, type HostGate } from './host-gate.js'
import {
  impersonatedFetch as defaultImpersonatedFetch,
  defaultImpersonationMemory,
  type ImpersonationMemory,
} from './impersonate.js'

// The page-fetch chain, extracted from the `fetchPage` tool so it can be RUN AND MEASURED
// without an LLM in the loop.
//
// The chain has two shapes. For most URLs it is steps 1 -> 2 -> 3 (plain fetch/site-adapter/
// Readability, lightpanda, Tavily Extract). One class of URL skips straight to a fourth,
// YouTube-only step: when `resolveSite` (via a site adapter's `plan()`) marks `skipToExtract`,
// steps 1-2 are never attempted at all. YouTube is the case that forced this — steps 1-2
// don't fail on a `watch?v=` URL, they SUCCEED with ~1,731 chars of video-player chrome ("Tap
// to unmute"), which clears every quality check in this file and gets recorded as `retrieved`.
// See site-adapters.ts's header comment for the full numbers.
//
// That fourth step is yt-dlp (agent/ytdlp.ts), tried FIRST: one `-J` metadata extraction plus
// one direct GET of the caption track it names, both spawned/fetched locally rather than
// billed to Tavily. MEASURED 2026-08-06 against three videos (see ytdlp.ts's header): 3.6-4.2s
// end to end, 20k-80k chars. Tavily Extract remains the fallback for when yt-dlp fails (no
// caption track, a rate limit, a binary error) — it still recovers a video's description and
// metadata even when a transcript is unavailable, which is why the chain still ends in step 3
// for this URL class too rather than failing outright.
//
// Why it lives on its own: the chain has four steps that each recover a different failure,
// and until now the only record of which one fired was a log line inside a job. That made
// every fetch-level question ("does the renderer earn its container?", "what would adding a
// step buy?") answerable only by running the full job benchmark — 15 runs, ~90 minutes,
// ~$1.35 — which then could not resolve the answer anyway, because job-level pagesFailed
// moved 10.8% → 11.3% at cv 1.00. Fetch effects sit under the job-level noise floor.
//
// So the chain now returns a per-step trace alongside the text. `scripts/fetch-bench.ts`
// replays a fixed corpus through the deployed chain and prints which step terminated and
// with how many characters, in minutes and deterministically. The trace is additive: the
// log lines are byte-identical to what they were inside the tool, so anything that read
// them still reads them.
//
// A fifth step, the Wayback Machine, runs ONLY after step 3 (Tavily Extract) has already
// terminally failed — it is a rescue for origins that refuse this crawler outright, not a
// general alternative to fetching live. MEASURED 2026-08-17: a dpreview forum thread 403s a
// plain fetch, 403s lightpanda, AND fails Tavily Extract ("Failed to fetch url") — every step
// above fails. The same URL through `https://web.archive.org/web/9999/<url>` (see archive.ts)
// 302s to a 2023 snapshot that reads with plain Readability: 20,076 chars, 0 Tavily credits.
// It is skipped for `skipToExtract` URLs (a YouTube watch page's archived copy is player
// chrome, not a transcript — the failure Wayback exists to rescue does not apply there) and
// for URLs that are already archive.org addresses (no recursion). It does NOT run ahead of the
// `isDefinitivelyMissing` early return — a 404 origin still stops before Tavily as it does
// today; recovering dead links from the archive is a deliberate follow-up, not this change.
// A page recovered this way is recorded `retrieved`, not a new ledger tier, because it
// genuinely was read; staleness travels in-band via `archiveBanner` instead.
//
// Contract, unchanged from the tool it came from and load-bearing:
//   - It NEVER throws. Every step is a fallback inside a fallback chain; the sidecar being
//     down or Tavily rejecting must degrade this call, not kill the worker (which would lose
//     every digest that worker had gathered).
//   - The ledger always hears about the ORIGINAL url, never the rewritten one, because the
//     original is what a citation will name (site-adapters.test.ts guards this).

// The single source of truth for every step this chain can terminate on — probe.ts derives its
// `z.enum` validation from this tuple (both the `via` field and each `attempts[].step`) rather
// than hand-maintaining a second list that can silently drift out of sync with it.
export const FETCH_STEPS = [
  'raw',
  'pdf',
  'site-adapter',
  'readability',
  'impersonate',
  'lightpanda',
  'yt-dlp',
  'tavily-extract',
  'wayback',
  'human',
] as const

export type FetchStep = (typeof FETCH_STEPS)[number]

export interface FetchAttempt {
  step: FetchStep
  ok: boolean
  /** Characters of usable text this step produced. Present on success, and on a `thin` miss. */
  chars?: number
  /** Why the step did not terminate the chain. Absent when `ok`. */
  error?: string
  /** Set when this attempt was a detected anti-bot/rate-limit block — `describeBlock`'s string. */
  blocked?: string
  ms: number
}

export interface FetchChainResult {
  /** The URL asked for — what the ledger recorded and what a citation will name. */
  url: string
  /** The URL actually dialled. Differs from `url` only when a site adapter rewrites it. */
  fetchUrl: string
  /** The step that terminated the chain, or null if every step failed. */
  via: FetchStep | null
  /** Capped text, or null on total failure. */
  text: string | null
  error: string | null
  attempts: FetchAttempt[]
}

export interface FetchChainOptions {
  ledger: RetrievalLedger
  jobId?: string
  /**
   * Called with the credits Tavily billed for an Extract call — including a call that
   * returned no content, because Tavily bills the attempt, not the outcome.
   */
  onTavilyCredits?: (credits: number) => void
  /**
   * Called for EVERY lightpanda attempt this chain makes — success, parse-failure, and
   * thrown error alike — so renders are countable even though none of those three outcomes
   * terminates the chain the same way. Not called when the render step is off, since then no
   * attempt was made at all.
   */
  onRender?: (r: { ok: boolean; ms: number }) => void
  /**
   * Base URL of the rendering sidecar; falsy takes the render step out of the chain. Defaults
   * to `env.LIGHTPANDA_URL`, which is what production wants — the parameter exists so which
   * steps run is an ARGUMENT rather than ambient state. `env.ts` parses `process.env` once at
   * first import, so a test that assigns the variable and then asserts on the waterfall was
   * asserting on module load order; on the CI runner that ordering differed and the chain fell
   * through to the network. Injecting it removes the coupling instead of re-timing it.
   */
  renderBaseUrl?: string | undefined
  /**
   * Total wall-clock budget for this chain (defaults to FETCH_CHAIN_BUDGET_MS). Exists so a
   * test can exercise the budget path without waiting 90s. Only the fetch chain is bounded —
   * never the research job or worker loop.
   */
  budgetMs?: number
  /**
   * Called for EVERY yt-dlp transcript attempt this chain makes (skipToExtract URLs only) —
   * success and failure alike, mirroring `onRender` above exactly. Not called for non-video
   * URLs, since no attempt was made at all.
   */
  onYtdlp?: (r: { ok: boolean; ms: number }) => void
  /**
   * Called for EVERY Wayback rescue attempt `tryWayback` makes — a non-ok HTTP status, a
   * thin-content miss, a thrown error, and success alike — mirroring `onRender`/`onYtdlp`
   * above exactly. NOT called when the step was skipped entirely (a `skipToExtract` URL, an
   * already-archived URL, or the chain terminating before Tavily Extract even fails), since
   * then no archive request was ever made. `snapshotAgeDays` is null on every failure path and
   * on a success whose snapshot date didn't parse — only a successful rescue with a readable
   * `Memento-Datetime`/path date carries a number.
   */
  onArchive?: (r: { ok: boolean; ms: number; snapshotAgeDays: number | null }) => void
  /**
   * The job/tool abort signal — distinct from `budgetMs` above. Combined into the chain's own
   * budget signal (`AbortSignal.any`) so cancelling the job also cancels an in-flight chain,
   * but NOT threaded into the human-solve call below: a human needs minutes, not the ~90s
   * fetch-chain budget, so `humanSolve` gets `signal` directly, unwrapped.
   */
  signal?: AbortSignal | undefined
  /**
   * Pluggable human-in-the-loop solver, tried after Tavily Extract has terminally failed and
   * before Wayback, only for a host this chain has reason to believe is fingerprint-blocked
   * (see the `human` stage in `runFetchChain` below). Absent takes the stage out of the chain
   * entirely, same convention as `renderBaseUrl` for lightpanda.
   */
  humanSolve?: HumanSolve
  /** Called for EVERY human-solve attempt this chain makes — mirrors `onRender`/`onYtdlp`/`onArchive`. */
  onHuman?: (r: { ok: boolean; ms: number; mode?: string; reason?: string }) => void
  /**
   * Per-host concurrency cap + min-interval + cooldown gate. Defaults to a module-level
   * singleton (real production wants ONE shared gate across every worker of every concurrent
   * job — see host-gate.ts's header); a test injects its own so gate state never leaks
   * between test cases.
   */
  hostGate?: HostGate
  /**
   * Injectable replacement for `tvly.extract` — @tavily/core calls out over axios, not
   * `fetch`, so this file's tests (which stub `globalThis.fetch`) cannot reach it any other
   * way. Production never sets this; it exists solely for `fetch-chain.test.ts`.
   */
  tavilyExtract?: (urls: string[], options?: Parameters<typeof tvly.extract>[1]) => Promise<TavilyExtractResponse>
  /**
   * Injectable replacement for the impersonation rung's fetcher (impersonate.ts's
   * `impersonatedFetch`) — same test-seam convention as `tavilyExtract` above: production
   * never sets this (it touches a native binding and the real network); fetch-chain.test.ts
   * uses it to simulate a TLS-impersonating fetch without the native binding at all.
   */
  impersonatedFetch?: (url: string, init: { signal?: AbortSignal | undefined }) => Promise<Response>
  /**
   * Injectable replacement for impersonate.ts's process-wide learned-preference map (which
   * host needs the impersonation rung, and for how long). Defaults to a module-level singleton
   * — real production wants ONE shared memory across every worker of every concurrent job, same
   * reasoning as `hostGate` above; a test injects its own so learned state never leaks between
   * test cases.
   */
  impersonationMemory?: ImpersonationMemory
}

/** One human-solve request — the URL to open, the host it's on (for the solver's own
 * per-host policy), why this chain believes it is blocked, and the signal that cancels the
 * request (NOT the chain budget — see `FetchChainOptions.humanSolve` above). */
export interface HumanSolveRequest {
  url: string
  host: string
  reason: string
  signal: AbortSignal
}

export type HumanSolveResult =
  | {
      ok: true
      html: string
      finalUrl: string
      // 'browser' is a solver-side success with no human ever prompted (human-solver.ts relabels
      // the solver's own 'cleared' this way once it comes back through the browser-first attempt
      // — see that file's header) — 'cleared' is kept as a value for the type's own sake (the
      // zod schema in human-solve-state.ts still accepts it from the wire) but human-solver.ts
      // never returns it upward anymore.
      mode: 'solved' | 'cleared' | 'browser'
      /** The settled page's HTTP status, when the solver could read one — absent means unknown. */
      status?: number | undefined
    }
  | { ok: false; reason: string }

export type HumanSolve = (req: HumanSolveRequest) => Promise<HumanSolveResult>

const tvly = tavily({ apiKey: env.TAVILY_API_KEY })

// One gate shared by every chain that doesn't inject its own — real production wants a single
// per-host cap across every worker of every concurrent job (host-gate.ts's header comment).
const defaultHostGate = createHostGate()

// A signal that never aborts — what the human-solve stage gets when the caller passed no
// `opts.signal` of its own, so `req.signal` is always a real AbortSignal the solver can attach
// to, never `undefined`.
const NEVER_ABORT: AbortSignal = new AbortController().signal

// Readability output shorter than this is treated as a miss rather than an answer. It is
// the boundary between "this page has content" and "this page has a cookie banner".
const MIN_USABLE_CHARS = 200

// Status codes worth reading a body sample for and running through classifyBlock — a plain
// 500 or 502 is a server error, not evidence of anti-bot blocking, so it is left as `HTTP
// ${status}` exactly as before rather than spending a bounded read on it.
const BLOCK_CHECK_STATUSES = new Set([401, 403, 429, 503])

// The subset of BLOCK_CHECK_STATUSES that makes the impersonation rung worth trying — 429 is
// excluded on purpose: a rate limit means "slow down", and firing a second client at the same
// origin immediately is exactly wrong (fetch-chain.ts's header comment on the rung's ordering).
const IMPERSONATE_ELIGIBLE_STATUSES = new Set([401, 403, 503])

// Bound on the body sample read for a block check — challenge.ts only scans the first 20,000
// chars anyway; this is generous headroom for encoding overhead while still capping the read
// well below a real page's size.
const BLOCK_SAMPLE_BYTES = 64 * 1024

// Total wall-clock budget for ONE fetchPage call, across every fallback in the chain. Each
// step already has its own timeout (safeFetch 10s/hop, lightpanda 60s, Tavily 30s, yt-dlp
// 45s), but nothing bounded their SUM: a URL whose plain fetch, render AND extract all
// degraded serially chained those budgets together (measured 2026-09-23: tool.fetchPage p95
// 137s, max ~1,134s). This signal aborts the chain as a whole. It is NOT a job/worker
// deadline — only the per-fetchPage HTTP chain is bounded (rules/agent-limits.md).
const FETCH_CHAIN_BUDGET_MS = 90_000

// Whether a response is verbatim-answer or document-to-extract, and whether a status means
// "absent" rather than "not to you" — both live in response-kind.ts so they are unit-tested.

// A fetcher slot the origin rung can be run against — the plain, self-identifying bot request
// by default, or the impersonation rung's `impersonatedFetch` (see `runOrigin` below). Takes
// only a signal: the redirect mode and (for the default) the bot user-agent are fixed by the
// implementation, never per-call, so `safeFetch`'s manual-redirect loop below behaves
// identically no matter which fetcher it is driving.
type Fetcher = (url: string, init: { signal?: AbortSignal | undefined }) => Promise<Response>

const defaultFetcher: Fetcher = (url, init) =>
  fetch(url, {
    headers: { 'user-agent': 'research-gateway/0.1 (+research bot)' },
    redirect: 'manual',
    // Omitted rather than set to `undefined` — `exactOptionalPropertyTypes` treats an explicit
    // `signal: undefined` as distinct from the key being absent, and Bun's fetch types want
    // `AbortSignal | null`, never `| undefined`.
    ...(init.signal ? { signal: init.signal } : {}),
  })

// Follows redirects BY HAND so every hop can be re-validated against the SSRF guard. A
// single `fetch` with `redirect: 'follow'` would validate the first address and then follow
// a 302 to anywhere — including the metadata service. The same is true of the impersonation
// rung's fetcher: it is NEVER allowed to follow its own redirects (impersonate.ts pins
// `followRedirects: false` / `redirect: 'manual'` for exactly this reason) — `fetcher` is
// swapped, this loop and its SSRF re-check are not.
//
// Returns the final URL alongside the response: with `redirect: 'manual'` the response is
// the REDIRECT TARGET's, and callers that attribute anything to the requested URL (the
// ledger's missing tier) must attribute it to where the answer actually came from.
async function safeFetch(
  startUrl: string,
  jobId = '-',
  maxHops = 3,
  signal?: AbortSignal,
  fetcher: Fetcher = defaultFetcher,
): Promise<{ res: Response; finalUrl: string }> {
  let current = startUrl
  for (let hop = 0; ; hop++) {
    await assertPublicHttpUrl(current) // re-validate EVERY hop (initial + each redirect target)
    const res = await fetcher(current, {
      // The per-hop timeout AND the chain-wide budget: whichever fires first aborts the hop.
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    })
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (!loc) return { res, finalUrl: current }
      if (hop >= maxHops) throw new Error('too many redirects')
      const next = new URL(loc, current).toString() // resolve relative redirects
      log('tool.redirect', { jobId, from: current, to: next, status: res.status, hop: hop + 1 })
      current = next
      continue
    }
    return { res, finalUrl: current }
  }
}

// Lowercase host of a URL, or '' if it does not parse — used by the `tool.fetchPage` error
// log (Part 2 below) and by the `fetch.host` span attribute, so recurring blocked hosts are
// greppable AND groupable. That aggregation is how site-adapters.ts picks its next entry
// (see that file's header).
export function hostOf(u: string): string {
  try {
    return new URL(u).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * Records one attempt and returns its elapsed ms, so a step reads as a single expression AND
 * callers that also need to report the timing elsewhere (onRender, below) use the exact same
 * number rather than a second `performance.now()` call that could disagree with it.
 */
function attempt(
  attempts: FetchAttempt[],
  step: FetchStep,
  startedAt: number,
  outcome: { ok: boolean; chars?: number; error?: string; blocked?: string },
): number {
  const ms = Math.round(performance.now() - startedAt)
  attempts.push({ step, ...outcome, ms })
  return ms
}

export async function runFetchChain(url: string, opts: FetchChainOptions): Promise<FetchChainResult> {
  const { ledger, onTavilyCredits, onRender, onYtdlp, onArchive, onHuman } = opts
  const jobId = opts.jobId ?? '-'
  const renderBaseUrl = opts.renderBaseUrl ?? env.LIGHTPANDA_URL
  const hostGate = opts.hostGate ?? defaultHostGate
  const tavilyExtract = opts.tavilyExtract ?? tvly.extract
  const impersonatedFetcher: Fetcher = opts.impersonatedFetch ?? defaultImpersonatedFetch
  const impersonationMemory: ImpersonationMemory = opts.impersonationMemory ?? defaultImpersonationMemory
  const attempts: FetchAttempt[] = []

  // One budget for the WHOLE chain (see FETCH_CHAIN_BUDGET_MS), aborted into every network
  // step below. Steps that cannot take an AbortSignal (Tavily Extract, the yt-dlp spawn) check
  // it directly before starting. `opts.signal` (the job/tool abort) is combined in on top of
  // it — cancelling the job must also cancel an in-flight chain — but is NOT itself the budget:
  // the human-solve stage below gets `opts.signal` alone, unwrapped, since it must outlive this.
  const budgetMs = opts.budgetMs ?? FETCH_CHAIN_BUDGET_MS
  const budget = opts.signal ? AbortSignal.any([AbortSignal.timeout(budgetMs), opts.signal]) : AbortSignal.timeout(budgetMs)
  const chainStartedAt = performance.now()
  const budgetReason = `fetch chain budget exhausted after ${budgetMs}ms`

  // Some hosts need a different address, a different reader, or both (site-adapters.ts).
  // Everything below fetches `fetchUrl`; everything the ledger and the caller see stays
  // `url`, because that is what a citation will name.
  const site = resolveSite(url)
  const fetchUrl = site.fetchUrl
  const host = hostOf(fetchUrl)
  const policy = policyFor(host)
  if (fetchUrl !== url) {
    log('tool.fetchPage', { jobId, url, via: 'rewrite', fetchUrl })
    getActiveSpan().addEvent('fetch.rewrite', { url, fetchUrl })
  }

  // Whether a stage should be skipped BEFORE it is attempted — a static per-host policy entry
  // (site-adapters.ts's evidence bar applies the same way here: a table entry needs a
  // measurement) or a live cooldown this process already recorded for the host. `render` is
  // also skipped while the host is in cooldown — lightpanda cannot pass a JS challenge either,
  // so a render attempt during cooldown spends the same reputation for the same certain miss.
  const stageSkipReason = (stage: ChainStage): string | null => {
    if (policy.skip.includes(stage)) return `policy: ${policy.note ?? 'skipped by host policy'}`
    if (stage === 'origin' || stage === 'render') {
      const cd = hostGate.cooldown(host)
      if (cd) return `cooldown: ${cd.reason} (${Math.ceil((cd.until - Date.now()) / 60_000)}min remaining)`
    }
    return null
  }

  // Set once this chain has direct or inherited evidence the host is blocking us — the human
  // stage (below, between Tavily and Wayback) only runs when there is a reason to believe a
  // human-driven browser can succeed where the automated rungs could not.
  let sawBlock = false
  // Set once step 1 hits a DECISIVE block verdict — a JS renderer cannot pass a challenge a
  // plain fetch already failed, so render is skipped for THIS chain specifically (independent
  // of the cooldown-based skip above, which only kicks in on a LATER chain once noteBlocked has
  // run).
  let originDecisiveBlock = false

  // The waterfall is reported as EVENTS on whatever span is active — the caller's
  // `tool.fetchPage` span — rather than as a span of its own: one chain run is one fetch, and
  // its steps are a timeline you want to read inside it. Emitted from the two terminal
  // helpers below so every return path carries exactly the record `attempts` holds, once.
  // `getActiveSpan()` is a no-op span when there is none, so fetch-bench.ts and the tests pay
  // nothing for this.
  let eventsEmitted = false
  const emitAttempts = (): void => {
    if (eventsEmitted) return
    eventsEmitted = true
    const span = getActiveSpan()
    for (const a of attempts) {
      span.addEvent('fetch.step', {
        step: a.step,
        ok: a.ok,
        chars: a.chars,
        error: a.error?.slice(0, 200),
        ms: a.ms,
      })
    }
  }

  const fail = (error: string): FetchChainResult => {
    emitAttempts()
    return { url, fetchUrl, via: null, text: null, error, attempts }
  }
  const done = (via: FetchStep, text: string): FetchChainResult => {
    emitAttempts()
    ledger.recordRetrieved(url)
    // When an adapter rewrote the address, BOTH forms name the page that was genuinely read,
    // so both are recorded. This is not a loophole in the "ledger hears the ORIGINAL url"
    // contract — it is the same principle `normalizeUrl` already encodes ("the model
    // routinely cites the same page with a fragment, a trailing slash, or a `www.` prefix
    // that the fetch did not use — those are the SAME page and must match, or honest
    // citations get dropped"). normalizeUrl keeps the path and query, so it canNOT collapse
    // these pairs by itself: `youtu.be/<id>` vs `youtube.com/watch?v=<id>` and
    // `reddit.com/r/x` vs `old.reddit.com/r/x` are different keys to it. Without this, a
    // worker that fetched one form and cited the other has its finding stripped at the
    // worker boundary — the exact silent failure mode HANDOVER.md's rule 4 was written for.
    if (fetchUrl !== url) ledger.recordRetrieved(fetchUrl)
    return { url, fetchUrl, via, text: capText(text, TEXT_CAP), error: null, attempts }
  }

  // SSRF guard — refuse any non-public URL before making any fetch. Guards the address
  // actually dialled, not the one asked for.
  try {
    await assertPublicHttpUrl(fetchUrl)
  } catch (err) {
    ledger.recordFailed(url, `refused: ${String(err)}`)
    log('tool.fetchPage', { jobId, url, via: 'refused' })
    return fail(`refused: ${String(err)}`)
  }

  // Steps 1-2 record no attempts at all when skipped, rather than a fabricated "didn't run"
  // entry — `attempts` stays an honest record of what actually happened, and a caller reading
  // it back (fetch-bench.ts, `tool.fetchPage` logs) sees exactly one `tavily-extract` entry for
  // these URLs, not two dishonest failures in front of it.
  let rdReason: 'thin' | 'threw' = 'thin'
  let rdChars = 0

  if (site.skipToExtract) {
    log('tool.fetchPage', { jobId, url, via: 'skip-to-extract', fetchUrl })

    // ── Step yt-dlp: the real read for a video URL, tried before the paid fallback ──
    const tY = performance.now()
    // The spawn takes no AbortSignal, so check the budget before starting it. Distinguished
    // from a genuine timeout below — `budget` folds in `opts.signal`, so a CANCELLED job would
    // otherwise be misreported as "budget exhausted".
    if (budget.aborted) return fail(opts.signal?.aborted ? 'cancelled' : budgetReason)
    const ytResult = await fetchYoutubeTranscript(fetchUrl, { jobId })
    if (ytResult) {
      const ms = attempt(attempts, 'yt-dlp', tY, { ok: true, chars: ytResult.chars })
      onYtdlp?.({ ok: true, ms })
      log('tool.fetchPage', {
        jobId,
        url,
        via: 'yt-dlp',
        chars: ytResult.chars,
        source: ytResult.source,
        lang: ytResult.lang,
      })
      return done('yt-dlp', ytResult.text)
    }
    const ms = attempt(attempts, 'yt-dlp', tY, { ok: false, error: 'no transcript available' })
    onYtdlp?.({ ok: false, ms })
    log('tool.fetchPage', { jobId, url, via: 'yt-dlp', error: 'no transcript available — falling back to tavily-extract' })
    // Falls through to Step 3 (Tavily Extract) below — it still recovers a video's
    // description/metadata even when yt-dlp found no transcript.
  } else {
    // ── Step 1: plain fetch + linkedom + Readability (or a site adapter's own reader) —
    // or, for a host this process already learned needs it (`impersonationMemory.prefers`), the
    // TLS-impersonation rung directly, so a chain that already knows the plain request 403s
    // spends only ONE gated origin hit instead of two.
    //
    // `runOrigin` is the pipeline shared by both rungs — status handling, block
    // classification, pdf/raw/html/extract — parameterized by which fetcher dials the origin
    // and which `FetchStep` label an attempt/success is recorded under. It returns a terminal
    // `FetchChainResult` when the chain should stop here, or `{ terminal: null, block }` to
    // fall through: `block` is non-null only when the response landed on a status this chain
    // treats as an anti-bot signal (401/403/429/503), regardless of whether `classifyBlock`
    // found a vendor marker (idealo's bare 403 carries none) — that is what the impersonation
    // gate below keys on.
    let isPdfBody = false

    const runOrigin = async (
      fetcher: Fetcher,
      label: FetchStep,
    ): Promise<{ terminal: FetchChainResult } | { terminal: null; block: { status: number; decisive: boolean; markerless: boolean } | null }> => {
      const t1 = performance.now()
      // A SEPARATE clock from `t1` above: `t1` is `performance.now()` (monotonic, process-
      // relative — used only for the `ms` telemetry on each attempt), while `hostGate`'s
      // `noteOk`/`cooldown` bookkeeping runs on `Date.now()` (its default clock). Passed as
      // `startedAt` to every `noteOk` call this attempt makes, so a success can never clear a
      // cooldown a CONCURRENT chain set after this attempt had already begun (host-gate.ts's
      // `noteOk` staleness guard).
      const attemptStartedAt = Date.now()
      let step1: FetchStep = label
      try {
        // A definitively-absent resource stops here. Every remaining step would ask the same
        // origin the same question and be told the same thing, and the last of them bills for it.
        // Recorded as `missing`, not `failed`: the origin ANSWERED — 404/410 is definitive
        // evidence that the resource does not exist at this URL, and the only kind of
        // negative claim the ledger ever backs. See ground.ts.
        //
        // Recorded against safeFetch's FINAL url, never the requested one: with redirects
        // followed by hand, `res` is the redirect target's response, and a redirect to a 404
        // says the TARGET does not exist — the requested URL's fate is unknown, and a
        // fabricated missing record there would wrongly demote or drop claims about it.
        const { res, finalUrl } = await hostGate.run(host, policy, () => safeFetch(fetchUrl, jobId, 3, budget, fetcher), budget)
        if (isDefinitivelyMissing(res.status)) {
          const reason = `HTTP ${res.status} — the resource does not exist at this URL`
          attempt(attempts, step1, t1, { ok: false, error: reason })
          ledger.recordMissing(finalUrl, reason)
          log('tool.fetchPage', { jobId, url, via: 'missing', status: res.status })
          return { terminal: fail(reason) }
        }

        if (!res.ok) {
          if (BLOCK_CHECK_STATUSES.has(res.status)) {
            const bodySample = await readCappedText(res.body, BLOCK_SAMPLE_BYTES).catch(() => '')
            const retryAfterSec = parseRetryAfter(res.headers.get('retry-after'), Date.now())
            const verdict = classifyBlock({ status: res.status, headers: res.headers, bodySample })
            if (verdict) {
              const reason = describeBlock(verdict, res.status)
              attempt(attempts, step1, t1, { ok: false, error: reason, blocked: reason })
              hostGate.noteBlocked(host, { retryAfterSec, reason: verdict.signal, kind: 'challenge' })
              originDecisiveBlock = verdict.decisive
              sawBlock = true
              return { terminal: null, block: { status: res.status, decisive: verdict.decisive, markerless: false } }
            } else if (res.status === 429) {
              // A 429 with no vendor fingerprint is still a rate limit, not a generic error —
              // the origin told us to slow down even though classifyBlock found no WAF marker.
              // This sets a cooldown (waiting IS the right response to a rate limit) but never
              // `sawBlock` — a human solving a captcha does nothing for "you're going too fast",
              // and the call site below never even offers this status to the impersonation rung.
              const reason = 'blocked: rate limited (HTTP 429)'
              attempt(attempts, step1, t1, { ok: false, error: reason, blocked: reason })
              hostGate.noteBlocked(host, { retryAfterSec, reason: 'rate limited (HTTP 429, no vendor signature)', kind: 'rate-limit' })
              return { terminal: null, block: { status: res.status, decisive: false, markerless: false } }
            } else {
              // A 401/403/503 with NO vendor fingerprint — an ordinary "forbidden"/"unauthorized"
              // page carries no evidence of anti-bot blocking on its own, so unlike the verdict
              // branch above this does NOT call `noteBlocked` or set `sawBlock` here. It still
              // unlocks the impersonation rung below (a second, differently-fingerprinted origin
              // hit is cheap insurance against exactly this ambiguous case); the call site is
              // what decides whether two independent marker-less blocks add up to human-eligible.
              attempt(attempts, step1, t1, { ok: false, error: `HTTP ${res.status}` })
              return { terminal: null, block: { status: res.status, decisive: false, markerless: true } }
            }
          }
          attempt(attempts, step1, t1, { ok: false, error: `HTTP ${res.status}` })
          return { terminal: null, block: null }
        }

        // Read the body ONCE, as BYTES — a Response body is a stream and cannot be consumed
        // twice, and PDF detection needs the raw bytes (the `%PDF-` magic) before any text
        // decoding. This is what closes the bug this whole change fixes: the VPS fetched
        // arxiv.org/pdf/1706.03762, `res.text()` decoded 1,984,323 bytes of PDF binary as
        // UTF-8 "text", and Readability/normalizeText handed that back as a `retrieved`
        // success. Bounded by MAX_PDF_BYTES so a pathological body is never downloaded in
        // full before a decision can be made — a truncated read is treated as a miss, same as
        // any other step-1 failure, and falls through to rendering/Tavily.
        const contentType = res.headers.get('content-type')
        const { bytes, truncated } = await readBoundedBytes(res.body, MAX_PDF_BYTES)

        if (truncated) {
          // An oversized PDF still IS a PDF — the renderer (step 2) has nothing to add to a
          // document with no DOM, so skip it here exactly like the identified-PDF branch below,
          // even though pdftotext never runs against these truncated bytes.
          if (isPdfContentType(contentType)) isPdfBody = true
          attempt(attempts, step1, t1, { ok: false, error: `body exceeds ${MAX_PDF_BYTES} byte cap` })
          return { terminal: null, block: null }
        }
        if (isPdf(contentType, bytes)) {
          isPdfBody = true
          const pdf = await extractPdfText(bytes, { jobId })
          if (pdf.ok) {
            attempt(attempts, 'pdf', t1, { ok: true, chars: pdf.text.length })
            hostGate.noteOk(host, { startedAt: attemptStartedAt })
            log('tool.fetchPage', { jobId, url, via: 'pdf', chars: pdf.text.length })
            return { terminal: done('pdf', pdf.text) }
          }
          // pdftotext missing, failed, or below the text floor (a scanned PDF with no text
          // layer) — falls through to Tavily Extract, which OCRs PDFs server-side. Never a
          // reason to pass the bytes through as text.
          attempt(attempts, 'pdf', t1, { ok: false, error: pdf.error })
          log('tool.fetchPage', { jobId, url, via: 'pdf', error: pdf.error })
          return { terminal: null, block: null }
        }

        const body = new TextDecoder().decode(bytes)

        // A non-HTML body IS the answer — hand it back verbatim rather than asking an HTML
        // parser to find an article in it.
        if (isRawContentType(contentType)) {
          const raw = normalizeText(body)
          if (raw.length > 0 && !looksBinary(raw)) {
            attempt(attempts, 'raw', t1, { ok: true, chars: raw.length })
            hostGate.noteOk(host, { startedAt: attemptStartedAt })
            log('tool.fetchPage', { jobId, url, via: 'raw', chars: raw.length, contentType })
            return { terminal: done('raw', raw) }
          }
          // An empty or binary body is a miss like any other — fall through to the
          // rendering steps, which is the right answer for a URL that serves an empty JSON
          // body to a bot and a real page to a browser. `looksBinary` catches a binary
          // response (image/zip/octet-stream) served under a Content-Type this chain
          // otherwise treats as raw text, and that isPdf's magic-byte check didn't own.
          const error = raw.length === 0 ? 'empty body' : 'binary content'
          attempt(attempts, 'raw', t1, { ok: false, chars: raw.length, error })
          return { terminal: null, block: null }
        }

        // A 200 response can still BE the challenge — Cloudflare's managed-challenge
        // interstitial is served with a 200 (challenge.ts's header comment), so a
        // decisive verdict counts here even though this status is never in
        // BLOCK_CHECK_STATUSES. Checked before extraction: no point asking Readability
        // to find an article inside a "Just a moment..." interstitial.
        const verdict = classifyBlock({ status: res.status, headers: res.headers, bodySample: body })
        if (verdict) {
          const reason = describeBlock(verdict, res.status)
          attempt(attempts, step1, t1, { ok: false, error: reason, blocked: reason })
          hostGate.noteBlocked(host, { reason: verdict.signal, kind: 'challenge' })
          originDecisiveBlock = true
          sawBlock = true
          // Not gated into the impersonation rung — the caller below only offers that rung for
          // the BLOCK_CHECK_STATUSES status set (401/403/503), which never includes a 200.
          return { terminal: null, block: { status: res.status, decisive: true, markerless: false } }
        }
        if (isJavaScriptShell(body)) {
          // Not a block — the origin sent its normal anti-crawler shell (site-adapters.ts's
          // Reddit case). Rendering, not a human, is the fix, so this falls through to
          // step 2 without touching the host gate's block bookkeeping.
          attempt(attempts, step1, t1, { ok: false, error: 'js-shell' })
          return { terminal: null, block: null }
        }

        // Parsing runs in a worker pool (html-parse.ts), off the event loop — linkedom +
        // Readability are synchronous CPU work that would otherwise block /health (issue #21).
        const { via, text } = await extractText(url, body, budget)
        // The impersonation rung always records under its own label — `via` here is a site
        // adapter/Readability choice that has nothing to do with which fetcher dialled the
        // origin, and a success through impit is `via: 'impersonate'` so fetch-bench/probe can
        // count what the rung buys, never `readability`.
        step1 = label === 'impersonate' ? 'impersonate' : via
        if (label !== 'impersonate') rdChars = text?.length ?? 0
        if (text && text.length >= MIN_USABLE_CHARS && !looksBinary(text)) {
          attempt(attempts, step1, t1, { ok: true, chars: text.length })
          hostGate.noteOk(host, { startedAt: attemptStartedAt })
          log('tool.fetchPage', { jobId, url, via: step1, chars: text.length })
          return { terminal: done(step1, text) }
        }
        const error = text && looksBinary(text) ? 'binary content' : `thin (${text?.length ?? 0} chars)`
        attempt(attempts, step1, t1, { ok: false, chars: text?.length ?? 0, error })
        return { terminal: null, block: null }
      } catch (err) {
        // fetch or parse failed — fall through to the rendering steps.
        if (label !== 'impersonate') rdReason = 'threw'
        attempt(attempts, step1, t1, { ok: false, error: String(err) })
        return { terminal: null, block: null }
      }
    }

    const originSkip = stageSkipReason('origin')
    if (originSkip) {
      // The rung this chain would have run had it not been skipped — `impersonate` for a host
      // already learned to need it, `readability` otherwise — never hardcoded, so the skipped
      // attempt's `step` names the rung that was actually bypassed.
      const skippedStep: FetchStep = impersonationMemory.prefers(host) ? 'impersonate' : 'readability'
      attempt(attempts, skippedStep, performance.now(), { ok: false, error: `skipped: ${originSkip}` })
      // Human-eligible only for a POLICY skip (a table entry the host earned by measurement —
      // see host-policy.ts) or a CHALLENGE-kind cooldown (a vendor-marker verdict a human can
      // plausibly solve). A marker-less rate-limit cooldown means "slow down", not "blocked" —
      // a human solving a captcha does nothing for it, same reasoning as the 429 branch above.
      const cd = hostGate.cooldown(host)
      if (policy.skip.includes('origin') || cd?.kind === 'challenge') sawBlock = true
      log('tool.fetchPage', { jobId, url, via: 'origin-skipped', reason: originSkip })
    } else if (impersonationMemory.prefers(host)) {
      // Learned on an earlier chain this run: plain fetch 403s this host, impersonation reads
      // it — skip straight to the rung that actually works, one gated origin hit instead of two.
      const r = await runOrigin(impersonatedFetcher, 'impersonate')
      if (r.terminal) return r.terminal
      if (r.block) impersonationMemory.noteFailed(host) // blocked again — the learned preference no longer holds
    } else {
      const r = await runOrigin(defaultFetcher, 'readability')
      if (r.terminal) return r.terminal
      if (r.block && r.block.status !== 429 && IMPERSONATE_ELIGIBLE_STATUSES.has(r.block.status)) {
        // The one seam a second origin rung slots into: a plain-fetch block on a host with no
        // reason yet to believe impersonation is hopeless (ebay.com/g2.com/mpb.com's policy
        // entries skip this by leaving origin/render off the table entirely — see
        // host-policy.ts). Runs through the SAME gate/cooldown bookkeeping as the plain hit,
        // never a second ungated origin hit.
        const impersonateStartedAt = Date.now() // hostGate's clock domain — see `attemptStartedAt` above
        const ir = await runOrigin(impersonatedFetcher, 'impersonate')
        if (ir.terminal) {
          impersonationMemory.noteWorks(host)
          hostGate.noteOk(host, { startedAt: impersonateStartedAt }) // clears the cooldown the plain block just set — the host IS readable to us
          return ir.terminal
        }
        // On a VENDOR-MARKED block: `runOrigin` already ran `hostGate.noteBlocked`/set
        // `sawBlock`/`originDecisiveBlock` for THIS (impersonated) attempt — nothing further to
        // do here. On a MARKER-LESS block on BOTH rungs, neither call touched `sawBlock` or the
        // cooldown (a single forbidden page with no vendor fingerprint is too thin evidence for
        // a host-wide cooldown) — but two INDEPENDENT rungs agreeing the host is forbidden is
        // enough to let a human try, so this is the one place that sets `sawBlock` for that
        // case. Excluded on purpose: a marker-less 401 on the plain request (an auth wall a
        // captcha-solve can't fix — never human-eligible) and an impersonation-side 429 (a rate
        // limit, not a block).
        if (r.block.markerless && r.block.status !== 401 && ir.block && ir.block.status !== 429) {
          sawBlock = true
        }
      }
    }

    // ── Step 2: JavaScript rendering, self-hosted ──
    // Sits between Readability and Tavily Extract because it handles the one failure Tavily
    // cannot — a page whose text simply is not in the HTML — while Tavily remains the better
    // fallback for a page that IS static but whose structure Readability could not parse.
    // Skipped for a PDF (isPdfBody) exactly like it is skipped for a `skipToExtract` URL — a
    // JS renderer has nothing to add to a document that has no DOM. Also skipped outright when
    // step 1 hit a DECISIVE block THIS chain — lightpanda cannot pass a JS challenge a plain
    // fetch already failed, so spending a render probe on it would only cost more reputation
    // for a certain miss (independent of the cooldown-based skip below, which only applies on
    // a LATER chain once noteBlocked has actually run).
    const renderSkip = originDecisiveBlock ? 'origin challenged' : stageSkipReason('render')
    if (renderBaseUrl && !isPdfBody) {
      if (renderSkip) {
        attempt(attempts, 'lightpanda', performance.now(), { ok: false, error: `skipped: ${renderSkip}` })
        log('tool.fetchPage', { jobId, url, via: 'render-skipped', reason: renderSkip })
      } else {
        const t2 = performance.now()
        try {
          const res = await hostGate.run(
            host,
            policy,
            () =>
              fetch(renderUrl(renderBaseUrl), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ url: fetchUrl }),
                // Generous on purpose: the sidecar's own budget is a 20s queue wait plus a 35s
                // render, and it answers a saturated queue with a fast, explicit failure. This
                // only has to outlast that, so a slow render is never cut off by the caller.
                signal: AbortSignal.any([budget, AbortSignal.timeout(60_000)]),
              }),
            budget,
          )
          const parsed = parseRenderResponse(res.status, await res.json().catch(() => null))
          if (parsed.ok) {
            const text = normalizeText(parsed.text)
            // The renderer executed the page's JS and still landed on a challenge page — a
            // real browser without a human solving it gets the same interstitial a plain fetch
            // does, so this is a miss like any other, not a success-shaped failure.
            const verdict = classifyBlock({ status: 200, headers: {}, bodySample: text })
            if (verdict) {
              const reason = describeBlock(verdict, 200)
              const ms = attempt(attempts, 'lightpanda', t2, { ok: false, error: reason, blocked: reason })
              onRender?.({ ok: false, ms })
              hostGate.noteBlocked(host, { reason: verdict.signal, kind: 'challenge' })
              sawBlock = true
              log('tool.fetchPage', { jobId, url, via: 'lightpanda', error: reason })
            } else {
              const ms = attempt(attempts, 'lightpanda', t2, { ok: true, chars: text.length })
              onRender?.({ ok: true, ms })
              log('tool.fetchPage', { jobId, url, via: 'lightpanda', chars: text.length, rdReason, rdChars })
              return done('lightpanda', text)
            }
          } else {
            const ms = attempt(attempts, 'lightpanda', t2, { ok: false, error: parsed.error })
            onRender?.({ ok: false, ms })
            log('tool.fetchPage', { jobId, url, via: 'lightpanda', error: parsed.error })
          }
        } catch (err) {
          // Never fatal — the sidecar being down must degrade this step, not the job.
          const ms = attempt(attempts, 'lightpanda', t2, { ok: false, error: String(err) })
          onRender?.({ ok: false, ms })
          log('tool.fetchPage', { jobId, url, via: 'lightpanda', error: String(err) })
        }
      }
    }
  }

  // ── Step wayback (rescue): the Wayback Machine — only reached once Tavily Extract has
  // terminally failed. See the header comment for the measured evidence and the two
  // deliberate exclusions.
  const tryWayback = async (originalReason: string): Promise<FetchChainResult> => {
    // No parse/protocol re-check here: `assertPublicHttpUrl(fetchUrl)` at the top of the chain
    // already threw on anything that is not a parseable, public http(s) URL.
    if (site.skipToExtract || isArchiveUrl(fetchUrl)) return fail(originalReason)

    const tW = performance.now()
    try {
      // A wayback lookup needs a bigger redirect budget than a live fetch, because the archive
      // REPLAYS the origin's own canonicalisation redirects on top of its own snapshot-resolution
      // one. MEASURED on a Cloudy Nights topic URL: 302 (9999 -> snapshot), 301 (origin drops
      // `index.php?`), 302 (re-resolve), 301 (origin lowercases the slug), 302 (re-resolve), 200
      // — five hops, where the chain's default of 3 failed the whole rescue with "too many
      // redirects". Every hop is still re-validated against the SSRF guard inside safeFetch, so
      // this widens the budget, not the trust.
      const { res } = await safeFetch(waybackLookupUrl(fetchUrl), jobId, 8, budget)
      if (!res.ok) {
        const ms = attempt(attempts, 'wayback', tW, { ok: false, error: `HTTP ${res.status}` })
        onArchive?.({ ok: false, ms, snapshotAgeDays: null })
        return fail(originalReason)
      }
      const body = await res.text()
      // Parsing runs in the same worker pool as step 1 (html-parse.ts) — Readability only, no
      // site adapter, matching what the inline wayback step always did.
      const { text } = await readabilityText(body, budget)
      if (!text || text.length < MIN_USABLE_CHARS) {
        const ms = attempt(attempts, 'wayback', tW, { ok: false, chars: text?.length ?? 0, error: `thin (${text?.length ?? 0} chars)` })
        onArchive?.({ ok: false, ms, snapshotAgeDays: null })
        return fail(originalReason)
      }
      const isoDate = parseSnapshotDate({
        memento: res.headers.get('memento-datetime'),
        contentLocation: res.headers.get('content-location') ?? res.url,
      })
      const withBanner = archiveBanner(url, isoDate) + text
      const ms = attempt(attempts, 'wayback', tW, { ok: true, chars: withBanner.length })
      onArchive?.({ ok: true, ms, snapshotAgeDays: snapshotAgeDays(isoDate, new Date()) })
      log('tool.fetchPage', { jobId, url, via: 'wayback', chars: withBanner.length, snapshot: isoDate })
      return done('wayback', withBanner)
    } catch (err) {
      const ms = attempt(attempts, 'wayback', tW, { ok: false, error: String(err) })
      onArchive?.({ ok: false, ms, snapshotAgeDays: null })
      return fail(originalReason)
    }
  }

  // ── Step human (rescue, before Wayback): a pluggable human-in-the-loop solver. Only tried
  // when the caller wired one in (`opts.humanSolve`), the host's policy allows it, AND this
  // chain has a reason to believe a human-driven browser succeeds where the automated rungs
  // could not (`sawBlock` — a verdict this chain observed, or the origin stage being skipped
  // because a prior chain already established the host is blocking). Not for a `skipToExtract`
  // URL (YouTube's transcript is not something a human solving a captcha recovers) or an
  // already-archived URL (nothing to "solve" on an archive.org replay).
  //
  // Unlike every other step, this one does NOT run against the chain's own budget — a human
  // needs minutes, not the ~90s this chain otherwise allows end to end — so it is given
  // `opts.signal` directly (or a signal that never aborts, if the caller passed none). The
  // solver owns its own hang guard.
  const humanEligible = (): boolean =>
    opts.humanSolve !== undefined && policy.humanSolve && !policy.skip.includes('human') && sawBlock && !site.skipToExtract && !isArchiveUrl(fetchUrl)

  const tryHumanSolve = async (reason: string): Promise<FetchChainResult | null> => {
    const tH = performance.now()
    try {
      const req: HumanSolveRequest = { url: fetchUrl, host, reason, signal: opts.signal ?? NEVER_ABORT }
      const result = await opts.humanSolve!(req)
      if (!result.ok) {
        const ms = attempt(attempts, 'human', tH, { ok: false, error: result.reason })
        onHuman?.({ ok: false, ms, reason: result.reason })
        return null
      }
      // The solver runs on a different machine (the mini's console session, per human-solve.ts's
      // header) and reports back whatever URL it landed on — an SSRF guard on the ORIGINAL
      // `fetchUrl` says nothing about where a challenge/redirect chain the human clicked through
      // actually ended up. Re-validated here, before this chain treats `result.finalUrl`/`html`
      // as trustworthy, exactly like every redirect hop in `safeFetch` above. A failure here is
      // an ordinary failed human attempt — never `retrieved` — so it falls through to Wayback
      // like any other miss.
      try {
        await assertPublicHttpUrl(result.finalUrl)
      } catch {
        const reason2 = 'unsafe final url'
        const ms = attempt(attempts, 'human', tH, { ok: false, error: reason2, blocked: reason2 })
        onHuman?.({ ok: false, ms, mode: result.mode, reason: reason2 })
        return null
      }
      // A settled page can still BE a 404/410 — bin/solver.ts reads
      // `performance.getEntriesByType('navigation')[0]?.responseStatus` alongside the HTML, so a
      // definitively-missing page (MPB's German "Seite nicht gefunden", 211 chars — thin enough
      // to have cleared MIN_USABLE_CHARS at other steps but not this one) is caught here instead
      // of being recorded as a successful read. Mirrors the origin step's `isDefinitivelyMissing`
      // branch exactly: `fail`, no Wayback rescue afterward — a 404 origin stops the whole chain
      // there too. `result.status` absent/0 means unknown, never treated as missing or an error.
      if (result.status === 404 || result.status === 410) {
        const reason2 = `HTTP ${result.status} — the resource does not exist at this URL`
        const ms = attempt(attempts, 'human', tH, { ok: false, error: reason2 })
        onHuman?.({ ok: false, ms, mode: result.mode, reason: reason2 })
        ledger.recordMissing(result.finalUrl, reason2)
        log('tool.fetchPage', { jobId, url, via: 'missing', status: result.status })
        return fail(reason2)
      }
      if (result.status !== undefined && result.status >= 400) {
        const reason2 = `HTTP ${result.status}`
        const ms = attempt(attempts, 'human', tH, { ok: false, error: reason2 })
        onHuman?.({ ok: false, ms, mode: result.mode, reason: reason2 })
        return null
      }
      // Checked on the raw HTML, before parsing — same reasoning as the origin/render checks
      // above: a human solver that gave up and just returned the interstitial's markup is a
      // miss, not a success-shaped one.
      const verdict = classifyBlock({ status: 200, headers: {}, bodySample: result.html })
      if (verdict) {
        const reason2 = describeBlock(verdict, 200)
        const ms = attempt(attempts, 'human', tH, { ok: false, error: reason2, blocked: reason2 })
        onHuman?.({ ok: false, ms, mode: result.mode, reason: reason2 })
        return null
      }
      // NOT `budget` — the chain-wide budget is almost always already spent by the time a
      // multi-minute human solve resolves, and parsing against an aborted signal throws
      // immediately, discarding every solve that ever succeeds. This gets its own short-lived
      // signal instead: 30s is generous for parsing HTML already in memory, and `opts.signal`
      // (the job/tool abort, not the chain budget) still cancels it if the caller went away.
      const parseSignal = AbortSignal.any([AbortSignal.timeout(30_000), opts.signal ?? NEVER_ABORT])
      const { text } = await extractText(fetchUrl, result.html, parseSignal)
      if (!text || text.length < MIN_USABLE_CHARS || looksBinary(text)) {
        let reason2: string
        if (!text) reason2 = 'empty after parse'
        else if (looksBinary(text)) reason2 = 'binary content'
        else reason2 = `thin (${text.length} chars)`
        const ms = attempt(attempts, 'human', tH, { ok: false, chars: text?.length ?? 0, error: reason2 })
        onHuman?.({ ok: false, ms, mode: result.mode, reason: reason2 })
        return null
      }
      const ms = attempt(attempts, 'human', tH, { ok: true, chars: text.length })
      onHuman?.({ ok: true, ms, mode: result.mode })
      // Deliberately NOT hostGate.noteOk(host) — a human solving a challenge in a real browser
      // on the MacBook says nothing about whether OUR (the mini's) IP is still blocked; clearing
      // the cooldown here would make the next chain re-probe the origin from this process and
      // spend reputation on a probe the human solve gives no reason to expect will succeed.
      log('tool.fetchPage', { jobId, url, via: 'human', chars: text.length, mode: result.mode })
      return done('human', text)
    } catch (err) {
      const ms = attempt(attempts, 'human', tH, { ok: false, error: String(err) })
      onHuman?.({ ok: false, ms, reason: String(err) })
      return null
    }
  }

  // Tries the human stage (when eligible) before falling back to Wayback — the ordering the
  // header comment above describes. `budgetMs` being spent does not skip this call (the human
  // stage ignores the chain budget by design); it only affects whether `tryWayback` afterward
  // gets a real attempt or fails fast on its own `safeFetch(..., budget)` call.
  const tryHumanThenWayback = async (reason: string): Promise<FetchChainResult> => {
    if (humanEligible()) {
      const humanResult = await tryHumanSolve(reason)
      if (humanResult) return humanResult
    }
    return await tryWayback(reason)
  }

  // Tavily Extract terminally failed: record it, commit `failed` to the ledger with the whole
  // chain's story (not Tavily's generic last word — see describeAttempts), then the rescues.
  const tavilyFailed = async (reason: string): Promise<FetchChainResult> => {
    attempt(attempts, 'tavily-extract', t3, { ok: false, error: reason })
    const chain = describeAttempts(attempts, reason)
    ledger.recordFailed(url, chain)
    log('tool.fetchPage', { jobId, url, via: 'error', reason: chain, host: hostOf(fetchUrl) })
    return await tryHumanThenWayback(chain)
  }

  // ── Step 3: Tavily Extract — the only paid step, and therefore the last ──
  const t3 = performance.now()
  // A CANCELLED job (`opts.signal` itself aborted) fails fast here rather than falling into
  // human/Wayback — `budget` folds the job signal in on top of the timeout, so without this
  // check a cancelled job would be misreported as "budget exhausted" AND still spend a human
  // solve / Wayback rescue on a chain nobody is waiting for anymore. Same early-return shape as
  // any other terminal failure: no ledger write, no further steps.
  if (opts.signal?.aborted) return fail('cancelled')
  // Tavily's SDK takes a seconds `timeout`, not an AbortSignal, so the budget cannot abort an
  // in-flight extract: check it first (a paid call must not fire after the budget is spent)
  // and clamp the SDK's own timeout to whatever the budget has left.
  if (budget.aborted) return await tryHumanThenWayback(budgetReason)
  const remainingMs = budgetMs - (performance.now() - chainStartedAt)
  const tavilyTimeoutSec = Math.max(1, Math.min(30, Math.ceil(remainingMs / 1000)))
  try {
    const ex = await tavilyExtract([fetchUrl], {
      extractDepth: 'basic',
      format: 'markdown',
      timeout: tavilyTimeoutSec,
      includeUsage: true,
    })
    // The call resolved — Tavily billed it — regardless of whether this URL ends up in
    // `results` or `failedResults` below. This is what makes a failed-fetch count
    // correctly: a failed *extraction* still billed the *call* that attempted it.
    onTavilyCredits?.(ex.usage?.credits ?? 0)
    const result = ex.results[0]
    if (result) {
      const text = normalizeText(result.rawContent)
      attempt(attempts, 'tavily-extract', t3, { ok: true, chars: text.length })
      // `rdReason`/`rdChars` describe why step 1 fell through, so they are meaningless when
      // step 1 never ran — logging `thin (0 chars)` for a skipped step would read as
      // "Readability found nothing" rather than "Readability was never asked", which is the
      // same dishonesty the `attempts` array is deliberately kept free of.
      log('tool.fetchPage', {
        jobId,
        url,
        via: 'tavily-extract',
        chars: text.length,
        ...(site.skipToExtract ? { skipped: true } : { rdReason, rdChars }),
      })
      return done('tavily-extract', text)
    }
    const failed = ex.failedResults[0]
    const reason = failed?.error ?? 'Tavily extract returned no content'
    // Every step of the paid path is now exhausted — the Wayback Machine gets one rescue
    // attempt below before this URL is unverifiable for this run, and the ledger is what
    // makes it structurally ineligible as a citation source.
    return await tavilyFailed(reason)
  } catch (err) {
    return await tavilyFailed(String(err))
  }
}
