import { tavily } from '@tavily/core'
import { env } from '../../env.js'
import { capText, TEXT_CAP } from '../extract.js'
import { resolveSite } from '../site-adapters.js'
import { log } from '../../lib/log.js'
import { getActiveSpan } from '../../lib/otel.js'
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
// `createContext` below, then read and mutated (the `sawBlock`/`originDecisiveBlock`/
// `isPdfBody`/`rdReason`/`rdChars` flags) by whichever stage runs next. Deliberately a plain
// mutable object rather than a class: each stage is a free function `(ctx) => Promise<
// FetchChainResult | null>`, and this is the one thing they all close over.
export interface ChainContext {
  /** The URL asked for — what the ledger recorded and what a citation will name. */
  readonly url: string
  /** The URL actually dialled. Differs from `url` only when a site adapter rewrites it. */
  readonly fetchUrl: string
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
   * human-driven browser can succeed where the automated rungs could not. */
  sawBlock: boolean
  /** Set once step 1 hits a DECISIVE block verdict — a JS renderer cannot pass a challenge a
   * plain fetch already failed, so render is skipped for THIS chain specifically (independent
   * of the cooldown-based skip, which only kicks in on a LATER chain once noteBlocked has run). */
  originDecisiveBlock: boolean
  isPdfBody: boolean
  rdReason: 'thin' | 'threw'
  rdChars: number
  /** Whether a stage should be skipped BEFORE it is attempted — a static per-host policy entry
   * (site-adapters.ts's evidence bar applies the same way here: a table entry needs a
   * measurement) or a live cooldown this process already recorded for the host. `render` is
   * also skipped while the host is in cooldown — lightpanda cannot pass a JS challenge either,
   * so a render attempt during cooldown spends the same reputation for the same certain miss. */
  stageSkipReason: (stage: ChainStage) => string | null
  fail: (error: string) => FetchChainResult
  done: (via: FetchStep, text: string) => FetchChainResult
}

export function createContext(url: string, opts: FetchChainOptions): ChainContext {
  const jobId = opts.jobId ?? '-'
  const renderBaseUrl = opts.renderBaseUrl ?? env.LIGHTPANDA_URL
  const hostGate = opts.hostGate ?? defaultHostGate
  const tavilyExtract = opts.tavilyExtract ?? tvly.extract
  const impersonatedFetcher: Fetcher = opts.impersonatedFetch ?? defaultImpersonatedFetch
  const impersonationMemory: ImpersonationMemory = opts.impersonationMemory ?? defaultImpersonationMemory
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

  return {
    url,
    fetchUrl,
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
    renderBaseUrl,
    budget,
    budgetMs,
    chainStartedAt,
    budgetReason,
    attempts,
    sawBlock: false,
    originDecisiveBlock: false,
    isPdfBody: false,
    rdReason: 'thin',
    rdChars: 0,
    stageSkipReason,
    fail,
    done,
  }
}
