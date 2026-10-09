import { tavily } from '@tavily/core'
import { env } from '../../env.js'
import { capText, TEXT_CAP } from '../extract.js'
import { fitDocumentText } from '../paragraph-filter.js'
import { resolveSite } from '../site-adapters.js'
import { log } from '../../lib/log.js'
import { getActiveSpan } from '../../lib/otel.js'
import { assertPublicHttpUrl } from '../../lib/ssrf.js'
import type { RetrievalLedger } from '../ledger.js'
import { policyFor, type ChainStage, type HostPolicy } from '../host-policy.js'
import { createHostGate, type HostGate } from '../host-gate.js'
import { impersonatedFetch as defaultImpersonatedFetch, defaultImpersonationMemory, type ImpersonationMemory } from '../impersonate.js'
import { hostOf, type Fetcher } from './net.js'
import type { FetchAttempt, FetchChainOptions, FetchChainResult, FetchStep } from './types.js'

// Readability output shorter than this is treated as a miss rather than an answer. It is
// the boundary between "this page has content" and "this page has a cookie banner".
export const MIN_USABLE_CHARS = 200

// Status codes worth reading a body sample for and running through classifyBlock — a plain
// 500 or 502 is a server error, not evidence of anti-bot blocking, so it is left as `HTTP
// ${status}` exactly as before rather than spending a bounded read on it.
export const BLOCK_CHECK_STATUSES = new Set([401, 403, 429, 503])

// The subset of BLOCK_CHECK_STATUSES that makes the impersonation rung worth trying — 429 is
// excluded on purpose: a rate limit means "slow down", and firing a second client at the same
// origin immediately is exactly wrong (fetch-chain.ts's header comment on the rung's ordering).
export const IMPERSONATE_ELIGIBLE_STATUSES = new Set([401, 403, 503])

// Bound on the body sample read for a block check — challenge.ts only scans the first 20,000
// chars anyway; this is generous headroom for encoding overhead while still capping the read
// well below a real page's size.
export const BLOCK_SAMPLE_BYTES = 64 * 1024

// Total wall-clock budget for ONE fetchPage call, across every fallback in the chain. Each
// step already has its own timeout (safeFetch 10s/hop, lightpanda 60s, Tavily 30s, yt-dlp
// 45s), but nothing bounded their SUM: a URL whose plain fetch, render AND extract all
// degraded serially chained those budgets together (measured 2026-09-23: tool.fetchPage p95
// 137s, max ~1,134s). This signal aborts the chain as a whole. It is NOT a job/worker
// deadline — only the per-fetchPage HTTP chain is bounded (rules/agent-limits.md).
const FETCH_CHAIN_BUDGET_MS = 90_000

const tvly = tavily({ apiKey: env.TAVILY_API_KEY })

// One gate shared by every chain that doesn't inject its own — real production wants a single
// per-host cap across every worker of every concurrent job (host-gate.ts's header comment).
const defaultHostGate = createHostGate()

// A signal that never aborts — what the human-solve stage gets when the caller passed no
// `opts.signal` of its own, so `req.signal` is always a real AbortSignal the solver can attach
// to, never `undefined`.
export const NEVER_ABORT: AbortSignal = new AbortController().signal

/**
 * Records one attempt and returns its elapsed ms, so a step reads as a single expression AND
 * callers that also need to report the timing elsewhere (onRender, below) use the exact same
 * number rather than a second `performance.now()` call that could disagree with it.
 */
export function attempt(
  attempts: FetchAttempt[],
  step: FetchStep,
  startedAt: number,
  outcome: { ok: boolean; chars?: number; error?: string; blocked?: string },
): number {
  const ms = Math.round(performance.now() - startedAt)
  attempts.push({ step, ...outcome, ms })
  return ms
}

// Shared, explicit state a chain run threads through every stage — built once per call by
// `createContext` below, then read by whichever stage runs next. Deliberately a plain object
// rather than a class: each stage is a free function `(ctx) => Promise<FetchChainResult |
// null>`, and this is the one thing they all close over. The stage flags below
// (`sawBlock`/`originDecisiveBlock`/`isPdfBody`/`rdReason`/`rdChars`/`dialUrl`/`sparseOrigin`) are `readonly`
// on this interface — every write goes through one of the named `mark*`/`note*`/`useFallbackUrl`
// methods instead of a bare field assignment, so `grep -rn 'ctx\.\(sawBlock\|originDecisiveBlock\|
// isPdfBody\|rdReason\|rdChars\|dialUrl\) =' src/agent/fetch-chain/` finds nothing outside this
// file: a write site is always a named call, never an assignment a reader could miss.
export interface ChainContext {
  /** The URL asked for — what the ledger recorded and what a citation will name. */
  readonly url: string
  /** The URL actually dialled. Differs from `url` only when a site adapter rewrites it. */
  readonly fetchUrl: string
  /** The address the LATER stages (render, extract/Tavily, human, wayback) should dial right
   * now. Starts equal to `fetchUrl` and switches to `site.fallbackUrl` once origin.ts has
   * observed `fetchUrl` answer 404/410 (`useFallbackUrl()`) — a later stage that kept dialling
   * `fetchUrl` after that point would just repeat the same 404 every one of them already knows
   * about. `url` (the ledger/citation name) never changes; only this does. */
  readonly dialUrl: string
  readonly host: string
  readonly jobId: string
  readonly site: ReturnType<typeof resolveSite>
  readonly policy: HostPolicy
  readonly opts: FetchChainOptions
  readonly ledger: RetrievalLedger
  readonly hostGate: HostGate
  readonly tavilyExtract: NonNullable<FetchChainOptions['tavilyExtract']>
  readonly impersonatedFetcher: Fetcher
  readonly impersonationMemory: ImpersonationMemory
  /** The SSRF guard every `safeFetch` hop (and the top-level pre-flight check in
   * fetch-chain.ts) runs a URL through. Defaults to the real `lib/ssrf.ts` check —
   * `opts.assertPublicUrl` is the test-only override (types.ts's header comment). */
  readonly assertPublicUrl: (url: string) => Promise<void>
  readonly renderBaseUrl: string | undefined
  /** One budget for the WHOLE chain (see FETCH_CHAIN_BUDGET_MS), aborted into every network
   * step. Combines `opts.signal` (the job/tool abort) on top of it — cancelling the job must
   * also cancel an in-flight chain — but is NOT itself the budget: the human-solve stage gets
   * `opts.signal` alone, unwrapped, since it must outlive this. */
  readonly budget: AbortSignal
  readonly budgetMs: number
  readonly chainStartedAt: number
  readonly budgetReason: string
  readonly attempts: FetchAttempt[]
  /** Set once this chain has direct or inherited evidence the host is blocking us — the human
   * stage (between Tavily and Wayback) only runs when there is a reason to believe a
   * human-driven browser can succeed where the automated rungs could not. Write via
   * `markBlocked()`. */
  readonly sawBlock: boolean
  /** Set once step 1 hits a DECISIVE block verdict — a JS renderer cannot pass a challenge a
   * plain fetch already failed, so render is skipped for THIS chain specifically (independent
   * of the cooldown-based skip, which only kicks in on a LATER chain once noteBlocked has run).
   * Write via `markDecisiveOriginBlock()`. */
  readonly originDecisiveBlock: boolean
  /** Write via `markPdfBody()`. */
  readonly isPdfBody: boolean
  /** Why step 1's Readability/site-adapter reading fell through — `'thin'` (the default: it ran
   * and produced too little text, or was never asked at all — see `rdChars`) or `'threw'` (it
   * threw before producing any text). Write via `noteReadabilityMiss(reason, chars)`. */
  readonly rdReason: 'thin' | 'threw'
  /** Chars step 1's reading produced, meaningless when it never ran (`extract.ts`'s header
   * comment). Write via `noteReadabilityMiss(reason, chars)`. */
  readonly rdChars: number
  /** The live origin read `readOriginHtml` rejected as sparse (a Readability sliver of a big
   * page with no JSON-LD) so render/Tavily could try for the real page. Kept as the last resort:
   * when every later stage fails, the chain returns this instead of escalating to human solve,
   * Wayback or a failure — a sparse page is not a block, and a fresh sliver beats an archived
   * copy or nothing. Write via `keepSparseOrigin()`. */
  readonly sparseOrigin: { step: FetchStep; text: string; dialledUrl: string } | null
  /** Sets `sparseOrigin`. Origin-only. Keeps the longer of two reads — the origin pipeline can
   * run twice (plain, then impersonate). */
  keepSparseOrigin: (step: FetchStep, text: string, dialledUrl: string) => void
  /** Sets `sawBlock`. The one flag written from more than one module (origin.ts's block
   * verdicts, render.ts's 200-challenge check, and origin.ts's `runOriginStage` for a skipped
   * or two-independent-marker-less-blocks chain) — so it stays a context method rather than
   * becoming module-local anywhere. */
  markBlocked: () => void
  /** Sets `originDecisiveBlock`. Only step 1 (origin.ts) ever calls this — a render-stage block
   * is discovered too late to skip render FOR THIS CHAIN (that is what `originDecisiveBlock`
   * exists to do), so render.ts only ever calls `markBlocked()`, never this. */
  markDecisiveOriginBlock: (decisive: boolean) => void
  /** Sets `isPdfBody`. Origin-only (a PDF is identified while reading step 1's body). */
  markPdfBody: () => void
  /** Switches `dialUrl` to `site.fallbackUrl` — a no-op when the site has none. Called once, by
   * origin.ts, the moment it decides to retry the fallback address after a 404/410 against
   * `fetchUrl`; every stage that runs after that point reads `dialUrl`, not `fetchUrl`. */
  useFallbackUrl: () => void
  /** Sets `rdReason` and `rdChars` together — the pair always describes ONE observation about
   * step 1's Readability attempt (it ran and was thin, or it threw before finishing), so they
   * are written together rather than through two separately-timed calls that could disagree. */
  noteReadabilityMiss: (reason: 'thin' | 'threw', chars?: number) => void
  /** Whether a stage should be skipped BEFORE it is attempted — a static per-host policy entry
   * (site-adapters.ts's evidence bar applies the same way here: a table entry needs a
   * measurement) or a live cooldown this process already recorded for the host. `render` is
   * also skipped while the host is in cooldown — lightpanda cannot pass a JS challenge either,
   * so a render attempt during cooldown spends the same reputation for the same certain miss. */
  stageSkipReason: (stage: ChainStage) => string | null
  fail: (error: string) => FetchChainResult
  /** `dialledUrl` is the address that actually produced `text` — every call site but origin.ts
   * omits it and gets `ctx.dialUrl` (the default): the current dial address, which is
   * `fetchUrl` until origin.ts's `useFallbackUrl()` has switched it, and `site.fallbackUrl`
   * after. origin.ts is the one stage that can dial a SECOND address within a single call and
   * passes that address explicitly, so a success recorded there names the address genuinely
   * read, never the rewritten one that 404'd. `fitted` marks text a stage already ran through the
   * `lines` filter, so `done` must not select passages from it a second time. */
  done: (via: FetchStep, text: string, dialledUrl?: string, fitted?: true) => FetchChainResult
}

export function createContext(url: string, opts: FetchChainOptions): ChainContext {
  const jobId = opts.jobId ?? '-'
  const renderBaseUrl = opts.renderBaseUrl ?? env.LIGHTPANDA_URL
  const hostGate = opts.hostGate ?? defaultHostGate
  const tavilyExtract = opts.tavilyExtract ?? tvly.extract
  const impersonatedFetcher: Fetcher = opts.impersonatedFetch ?? defaultImpersonatedFetch
  const impersonationMemory: ImpersonationMemory = opts.impersonationMemory ?? defaultImpersonationMemory
  const assertPublicUrl = opts.assertPublicUrl ?? assertPublicHttpUrl
  const ledger = opts.ledger
  const attempts: FetchAttempt[] = []

  // One budget for the WHOLE chain (see FETCH_CHAIN_BUDGET_MS), aborted into every network
  // step below. Steps that cannot take an AbortSignal (Tavily Extract, the yt-dlp spawn) check
  // it directly before starting. `opts.signal` (the job/tool abort) is combined in on top of
  // it — cancelling the job must also cancel an in-flight chain — but is NOT itself the budget:
  // the human-solve stage gets `opts.signal` alone, unwrapped, since it must outlive this.
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

  const stageSkipReason = (stage: ChainStage): string | null => {
    if (policy.skip.includes(stage)) return `policy: ${policy.note ?? 'skipped by host policy'}`
    if (stage === 'origin' || stage === 'render') {
      const cd = hostGate.cooldown(host)
      if (cd) return `cooldown: ${cd.reason} (${Math.ceil((cd.until - Date.now()) / 60_000)}min remaining)`
    }
    return null
  }

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

  // The stage flags — plain local variables, never assigned to directly outside this closure.
  // Exposed on the returned object as getters (so a reader sees an ordinary `ctx.sawBlock`
  // property, same as before) plus the named `mark*`/`note*` methods below, which are the ONLY
  // functions that ever reassign them.
  let sawBlock = false
  let originDecisiveBlock = false
  let isPdfBody = false
  let rdReason: 'thin' | 'threw' = 'thin'
  let rdChars = 0
  let dialUrl = fetchUrl
  let sparseOrigin: { step: FetchStep; text: string; dialledUrl: string } | null = null

  const markBlocked = (): void => {
    sawBlock = true
  }
  const useFallbackUrl = (): void => {
    if (site.fallbackUrl) dialUrl = site.fallbackUrl
  }
  // Last write wins, like the pre-split `ctx.originDecisiveBlock = verdict.decisive`: the origin
  // pipeline can run twice (plain, then impersonate), and a decisive plain block followed by a
  // corroborating-only impersonated one must NOT keep render skipped.
  const markDecisiveOriginBlock = (decisive: boolean): void => {
    originDecisiveBlock = decisive
  }
  const keepSparseOrigin = (step: FetchStep, text: string, dialledUrl: string): void => {
    if (sparseOrigin && sparseOrigin.text.length >= text.length) return
    sparseOrigin = { step, text, dialledUrl }
  }
  const markPdfBody = (): void => {
    isPdfBody = true
  }
  // `chars` omitted keeps the last recorded count — a throw AFTER a successful extraction must
  // not erase the length render/extract log next to `rdReason`.
  const noteReadabilityMiss = (reason: 'thin' | 'threw', chars?: number): void => {
    rdReason = reason
    if (chars !== undefined) rdChars = chars
  }

  const fail = (error: string): FetchChainResult => {
    emitAttempts()
    // `fetchUrl` on the RESULT is `dialUrl`, not the closure's `fetchUrl` (the site adapter's
    // originally PLANNED address) — same reasoning as `done` below: on an origin fallback that
    // still ends in failure, the planned address already 404'd, so naming it here would say
    // this chain never got as far as the fallback it actually failed against.
    return { url, fetchUrl: dialUrl, via: null, text: null, error, attempts }
  }
  const done = (via: FetchStep, text: string, dialledUrl: string = dialUrl, fitted?: true): FetchChainResult => {
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
    //
    // `dialledUrl` defaults to `dialUrl` (the current dial address — `fetchUrl` until a
    // fallback switched it) but origin.ts passes the fallback address explicitly on a fallback
    // success too — recording `fetchUrl` there would be a FALSE retrieved claim on an address
    // that actually answered 404/410.
    if (dialledUrl !== url) ledger.recordRetrieved(dialledUrl)
    // `fetchUrl` on the RESULT is `dialledUrl`, not the closure's `fetchUrl` (the site
    // adapter's originally PLANNED address) — on an origin fallback success those two differ,
    // and probe.ts/fetch-bench.ts/tools.ts all read this field as "the URL actually dialled".
    // Reporting the planned address there would name the one that 404'd, not the one that
    // answered.
    return { url, fetchUrl: dialledUrl, via, text: capText(fitted ? text : fitDocumentText(text, opts.lineFilter, TEXT_CAP).text, TEXT_CAP), error: null, attempts }
  }

  return {
    url,
    fetchUrl,
    get dialUrl() {
      return dialUrl
    },
    host,
    jobId,
    site,
    policy,
    opts,
    ledger,
    hostGate,
    tavilyExtract,
    impersonatedFetcher,
    impersonationMemory,
    assertPublicUrl,
    renderBaseUrl,
    budget,
    budgetMs,
    chainStartedAt,
    budgetReason,
    attempts,
    get sawBlock() {
      return sawBlock
    },
    get originDecisiveBlock() {
      return originDecisiveBlock
    },
    get isPdfBody() {
      return isPdfBody
    },
    get sparseOrigin() {
      return sparseOrigin
    },
    get rdReason() {
      return rdReason
    },
    get rdChars() {
      return rdChars
    },
    markBlocked,
    markDecisiveOriginBlock,
    markPdfBody,
    keepSparseOrigin,
    useFallbackUrl,
    noteReadabilityMiss,
    stageSkipReason,
    fail,
    done,
  }
}
