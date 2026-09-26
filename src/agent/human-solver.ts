// The human-solve escalation path's orchestration, factored out from human-solve.ts so it is
// unit-testable with fakes instead of a real ssh/JXA dialog and a real bin/solver.ts spawn.
// Every I/O boundary (the dialog prompt, the local solver spawn, the cleared-mode concurrency
// slot) is an injected port; everything in this file is otherwise plain promise orchestration —
// no env import, no Bun.spawn, no clock read via `Date.now()` directly (that's `ports.now()`,
// same convention as human-solve-state.ts's `now: number` parameter).
//
// human-solve.ts is the thin adapter: it builds the real ports (ssh+JXA, Bun.spawn bin/solver.ts,
// the cleared-mode semaphore) and calls `createHumanSolver(ports)`, exporting the result as
// `humanSolver` — the only thing fetch-chain.ts (via tools.ts) ever imports.

import type { HumanSolve, HumanSolveRequest, HumanSolveResult } from './fetch-chain.js'
import type { HumanSolveState, SolveOutcome } from './human-solve-state.js'
import type { HumanSolveReason, SolverOutput } from './human-solve-state.js'

export interface HumanSolverPorts {
  /** Hang guard for the whole solve flow (dialog + local solve) — `env.HUMAN_SOLVE_WAIT_MS` in
   * production. Not a per-step budget; `solverBudgetMs` below carves the local solver's own
   * slice out of whatever is left of it. */
  waitMs: number
  /** Injected clock — real production passes `Date.now`, tests pass a controllable counter. */
  now: () => number
  log: (event: string, fields?: Record<string, unknown>) => void
  state: HumanSolveState
  /** Asks the human (ssh + JXA dialog on the MacBook in production) whether to open Screen
   * Sharing and solve a challenge. Never touches the target page itself. */
  promptUser: (req: HumanSolveRequest) => Promise<{ ok: true } | { ok: false; reason: HumanSolveReason }>
  /** Runs bin/solver.ts (spawned locally on the mini in production) in one of three modes:
   * 'warm' launches/verifies Chrome and the SSRF proxy with no tab and no page fetch; 'fetch'
   * tries the already-warm cleared cookie with no human involved; 'solve' opens the tab the
   * human is asked to click through. */
  runSolver: (mode: 'solve' | 'fetch' | 'warm', req: HumanSolveRequest, timeoutMs: number) => Promise<SolverOutput>
  /** A bounded concurrency slot for 'fetch-cleared' runs (a real semaphore in production, up to
   * `MAX_CONCURRENT_CLEARED` at once) — `false` means the wait elapsed with no slot granted. */
  acquireClearedSlot: () => Promise<boolean>
  releaseClearedSlot: () => void
}

// A hard outer safety net past bin/solver.ts's own internal deadline (it is handed the same
// budget and is expected to return its own `{ok:false, reason:'timeout'}` well before this
// margin runs out) — kept here, not folded into MIN_SOLVER_TIMEOUT_MS, because it is subtracted
// from the remaining wait budget, not a floor on it. Exported so human-solve.ts's adapter-level
// spawn (which needs the SAME number to size its own outer kill timer) never drifts from this
// one.
export const SOLVER_SAFETY_MARGIN_MS = 10_000
// Never hand the local solver a deadline so small a real Chrome round trip has no chance to
// finish before it fires.
const MIN_SOLVER_TIMEOUT_MS = 1_000
// Generous for a cold Chrome launch (CHROME_LAUNCH_WAIT_MS in bin/solver.ts is 20s) plus the
// SSRF-proxy listening probe — no tab, no human, no page fetch, so this is independent of
// `waitMs`, which budgets the parts of the flow the human actually waits on.
const WARM_TIMEOUT_MS = 25_000

/** How much of `waitMs` the local solver spawn gets, given `elapsedMs` already spent on prior
 * steps (the dialog round trip) — never less than MIN_SOLVER_TIMEOUT_MS, and always leaving
 * SOLVER_SAFETY_MARGIN_MS for this file's own hard kill to lose the race against the solver's
 * graceful timeout. */
export function solverBudgetMs(waitMs: number, elapsedMs: number): number {
  return Math.max(MIN_SOLVER_TIMEOUT_MS, waitMs - elapsedMs - SOLVER_SAFETY_MARGIN_MS)
}

// The one place a HumanSolveReason becomes a SolveOutcome — hoisted to a module const per
// review, instead of being rebuilt on every call. Every reason absent from this table (busy,
// unsafe-redirect, aborted, error, open_tab_failed) falls through to a plain 'error' outcome,
// which human-solve-state.ts's `record()` treats as a no-op: no per-host suppression, no global
// suppression. `chrome_unavailable`/`proxy_unavailable`/`dialog_error` (bin/solver.ts's Chrome or
// the SSRF proxy failing to come up, or the MacBook's JXA dialog itself erroring for a reason
// other than the human cancelling it) all map to the same
// 'local-unavailable' bucket — none of them are evidence about any PARTICULAR host, so they
// short-suppress every host globally the same way an unreachable MacBook does, never the 6h
// per-host suppression 'declined'/'unanswered'/'timeout' get.
const REASON_TO_OUTCOME: Partial<Record<HumanSolveReason, SolveOutcome>> = {
  challenge: 'cleared-challenge',
  declined: 'declined',
  unanswered: 'unanswered',
  unreachable: 'unreachable',
  timeout: 'timeout',
  chrome_unavailable: 'local-unavailable',
  proxy_unavailable: 'local-unavailable',
  dialog_error: 'local-unavailable',
}

function outcomeForResult(mode: 'solve' | 'fetch', result: HumanSolveResult): SolveOutcome | null {
  if (result.ok) return mode === 'solve' ? 'solved' : 'cleared-ok'
  if (result.reason === 'aborted') return null // a cancellation says nothing about the host
  return REASON_TO_OUTCOME[result.reason as HumanSolveReason] ?? 'error'
}

export function createHumanSolver(ports: HumanSolverPorts): HumanSolve {
  // Global: at most one 'solve' dialog on the owner's screen at a time (a plain FIFO mutex).
  let solveLock: Promise<unknown> = Promise.resolve()
  // Single-flight per host: a new call for a host chains onto whatever tail is already there
  // (or Promise.resolve() if none), so two requests for the same host never run their solver
  // step concurrently. Just the bare tail promise, keyed by host — no bounded-eviction cap:
  // a settled tail deletes ITSELF from the map the instant it settles (below), so the map only
  // ever holds hosts with a genuinely in-flight chain, which self-bounds on concurrency, never
  // on the total number of distinct hosts ever seen.
  const hostTails = new Map<string, Promise<void>>()

  // Resolves to `{ok:false, reason:'aborted'}` the instant `signal` fires, WITHOUT cancelling
  // `promise` — a queued FIFO wait (the solve lock, a host's tail chain) must keep running for
  // whoever is still behind it in line; only THIS caller's own wait is cut short. This is the
  // one aborted-guard every queued wait races against, replacing the half-dozen scattered
  // `if (signal.aborted) return` checks the pre-extraction code had at nearly every step.
  function raceAbort(signal: AbortSignal, promise: Promise<HumanSolveResult>): Promise<HumanSolveResult> {
    if (signal.aborted) return Promise.resolve({ ok: false, reason: 'aborted' })
    return new Promise((resolve) => {
      const onAbort = (): void => resolve({ ok: false, reason: 'aborted' })
      signal.addEventListener('abort', onAbort, { once: true })
      promise.then(
        (value) => {
          signal.removeEventListener('abort', onAbort)
          resolve(value)
        },
        (err) => {
          signal.removeEventListener('abort', onAbort)
          // Only a rejection that actually coincides with an abort is 'aborted' — mapping EVERY
          // throw to 'aborted' (the bug this replaces) silently swallowed real bugs elsewhere in
          // the chain (a throw from promptUser, runSolver, or state.plan/record) as an ordinary
          // cancellation, with no log line and no distinguishable outcome.
          if (signal.aborted) {
            resolve({ ok: false, reason: 'aborted' })
            return
          }
          ports.log('human_solve.unexpected_error', { error: String(err) })
          resolve({ ok: false, reason: 'error' })
        },
      )
    })
  }

  function withSolveLock(fn: () => Promise<HumanSolveResult>, signal: AbortSignal): Promise<HumanSolveResult> {
    const run = solveLock.then(fn, fn)
    solveLock = run.then(
      () => undefined,
      () => undefined,
    )
    return raceAbort(signal, run)
  }

  function runExclusiveForHost(host: string, signal: AbortSignal, fn: () => Promise<HumanSolveResult>): Promise<HumanSolveResult> {
    const prior = hostTails.get(host) ?? Promise.resolve()
    const result = prior.then(fn)
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    tail.then(() => {
      // Only remove this host's entry if nothing newer has replaced it in the meantime — a
      // second call for the same host chains onto THIS tail before it settles, and its own,
      // later entry must be the one left standing, never deleted out from under it.
      if (hostTails.get(host) === tail) hostTails.delete(host)
    })
    hostTails.set(host, tail)
    return raceAbort(signal, result)
  }

  // Races the semaphore's own (real) wait against `signal` without cancelling it — if the
  // signal wins, the slot may still be granted later; the moment it is, it's released again so
  // an aborted caller never leaks a held permit.
  async function acquireClearedSlotOrAbort(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false
    const acquirePromise = ports.acquireClearedSlot()
    let abortedFirst = false
    // Named — the SAME reference is both added and removed — so it can be removed once the
    // race settles either way. When `acquirePromise` wins (the common, non-aborted case),
    // `{ once: true }` alone never fires this listener, and it would otherwise stay attached to
    // `signal` for the rest of that signal's lifetime (a leak on a long-lived, job-level
    // AbortSignal shared across many calls).
    let resolveAbortPromise: (() => void) | undefined
    const onAbort = (): void => {
      abortedFirst = true
      resolveAbortPromise?.()
    }
    const abortPromise = new Promise<void>((resolve) => {
      resolveAbortPromise = resolve
      signal.addEventListener('abort', onAbort, { once: true })
    })
    await Promise.race([acquirePromise, abortPromise])
    signal.removeEventListener('abort', onAbort)
    if (abortedFirst) {
      void acquirePromise.then((got) => {
        if (got) ports.releaseClearedSlot()
      })
      return false
    }
    return acquirePromise
  }

  // Launch/verify Chrome and the SSRF proxy, no tab opened — run before the dialog so a
  // Chrome/proxy failure short-circuits to a suppression instead of prompting the human for a
  // browser session that was never coming up.
  async function runWarm(req: HumanSolveRequest): Promise<{ ok: true } | { ok: false; reason: HumanSolveReason }> {
    const result = await ports.runSolver('warm', req, WARM_TIMEOUT_MS)
    if (result.ok) return { ok: true }
    const outcome = REASON_TO_OUTCOME[result.reason]
    if (outcome) ports.state.record(req.host, outcome, ports.now())
    return result
  }

  async function runLocalSolver(mode: 'solve' | 'fetch', req: HumanSolveRequest, timeoutMs: number): Promise<HumanSolveResult> {
    const result = await ports.runSolver(mode, req, timeoutMs)
    if (result.ok && result.mode === 'warm') {
      // Unreachable in practice — this function never requests 'warm' — kept only so the
      // return type narrows cleanly to the page-fetching shape callers expect.
      return { ok: false, reason: 'error' }
    }
    return result
  }

  async function runCleared(req: HumanSolveRequest): Promise<HumanSolveResult> {
    const gotSlot = await acquireClearedSlotOrAbort(req.signal)
    if (!gotSlot) {
      const reason = req.signal.aborted ? 'aborted' : 'busy'
      ports.log('human_solve.done', { host: req.host, mode: 'fetch', outcome: reason })
      return { ok: false, reason }
    }

    let result: HumanSolveResult
    const startedAt = ports.now()
    try {
      ports.log('human_solve.start', { host: req.host, mode: 'fetch' })
      result = await runLocalSolver('fetch', req, solverBudgetMs(ports.waitMs, 0))
    } finally {
      // Released here — BEFORE any escalation — so a multi-minute solve below never holds a
      // cleared-mode slot another concurrent host's cheap fetch-cleared attempt is waiting on.
      ports.releaseClearedSlot()
    }

    const outcome = outcomeForResult('fetch', result)
    if (outcome) ports.state.record(req.host, outcome, ports.now())
    ports.log('human_solve.done', {
      host: req.host,
      mode: 'fetch',
      ms: ports.now() - startedAt,
      outcome: result.ok ? result.mode : result.reason,
    })

    if (!result.ok && result.reason === 'challenge') {
      // Escalate through the SAME admission decision `state.record` just updated (a
      // cleared-challenge outcome clears `clearedAt`) — never a direct bypass to runSolve,
      // which could otherwise re-solve a host `state.plan` would now call suppressed (the
      // dialog rate limit, or a suppression a concurrent attempt for another host just set).
      return attemptSolve(req)
    }
    return result
  }

  async function runSolve(req: HumanSolveRequest): Promise<HumanSolveResult> {
    const queuedAt = ports.now()
    return withSolveLock(async () => {
      // A solve that sat in the FIFO queue longer than the whole budget would otherwise still
      // run — potentially minutes after the caller stopped waiting for an answer.
      if (ports.now() - queuedAt > ports.waitMs) {
        ports.log('human_solve.done', { host: req.host, mode: 'solve', outcome: 'busy', queuedMs: ports.now() - queuedAt })
        return { ok: false, reason: 'busy' }
      }

      const startedAt = ports.now()
      ports.log('human_solve.start', { host: req.host, mode: 'solve' })

      const warm = await runWarm(req)
      if (!warm.ok) {
        ports.log('human_solve.done', { host: req.host, mode: 'solve', ms: ports.now() - startedAt, outcome: warm.reason })
        return warm
      }

      const consent = await ports.promptUser(req)
      if (!consent.ok) {
        const outcome = outcomeForResult('solve', consent)
        if (outcome) ports.state.record(req.host, outcome, ports.now())
        ports.log('human_solve.done', { host: req.host, mode: 'solve', ms: ports.now() - startedAt, outcome: consent.reason })
        return consent
      }

      const timeoutMs = solverBudgetMs(ports.waitMs, ports.now() - startedAt)
      const result = await runLocalSolver('solve', req, timeoutMs)
      const outcome = outcomeForResult('solve', result)
      if (outcome) ports.state.record(req.host, outcome, ports.now())
      ports.log('human_solve.done', {
        host: req.host,
        mode: 'solve',
        ms: ports.now() - startedAt,
        outcome: result.ok ? result.mode : result.reason,
      })
      return result
    }, req.signal)
  }

  function attemptSolve(req: HumanSolveRequest): Promise<HumanSolveResult> {
    const decision = ports.state.plan(req.host, ports.now())
    if (decision.action === 'suppressed') {
      ports.log('human_solve.suppressed', { host: req.host, reason: decision.reason })
      return Promise.resolve({ ok: false, reason: decision.reason })
    }
    if (decision.action === 'fetch-cleared') return runCleared(req)
    return runSolve(req)
  }

  return (req) => runExclusiveForHost(req.host, req.signal, () => attemptSolve(req))
}
