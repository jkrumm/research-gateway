import type { tavily, TavilyExtractResponse } from '@tavily/core'
import type { RetrievalLedger } from '../ledger.js'
import type { HostGate } from '../host-gate.js'
import type { ImpersonationMemory } from '../impersonate.js'

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
  'browser',
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
  /**
   * Normalized terms (line-filter.ts `normalizeTerms`) for fetchPage's `lines` parameter. Applied
   * in the origin stage's raw branch to a line-oriented body (CSV/TSV/plain text/JSON-lines),
   * BEFORE the TEXT_CAP cut, so the filter sees the whole bounded-read body. Ignored for
   * every other kind of body.
   */
  lineFilter?: readonly string[]
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
   * (see fetch-chain/human.ts, reached through rescue.ts). Absent takes the stage out of the chain
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
  tavilyExtract?: (urls: string[], options?: Parameters<ReturnType<typeof tavily>['extract']>[1]) => Promise<TavilyExtractResponse>
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
  /**
   * Injectable replacement for the SSRF guard (`lib/ssrf.ts`'s `assertPublicHttpUrl`) — same
   * test-seam convention as `tavilyExtract`/`impersonatedFetch` above: production never sets
   * this. Exists for tests that must exercise a real hostname (`resolveSite` is keyed on the
   * actual host, so a site-adapter fixture like arXiv's HTML→PDF fallback can't use a TEST-NET
   * literal instead) without making a real DNS lookup on every hop.
   */
  assertPublicUrl?: (url: string) => Promise<void>
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
