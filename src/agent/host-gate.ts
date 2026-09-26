// Process-wide per-host gate: caps concurrent origin/render hits per host, floors the
// interval between them, and tracks a cooldown once a host has told us (via a block verdict
// or a 429) that it is done answering for a while. Shared across every worker of every
// concurrent job, same reasoning as direct-sources.ts's arxivGate/semanticScholarGate — the
// downstream resource (a WAF's rate limit) is one shared ceiling, not a per-worker preference.
//
// The "start a call" decision (concurrency slot + interval wait) is serialized per host
// through a promise chain, same shape as rate-gate.ts's `chain` — but unlike rate-gate, the
// chain advances the moment a slot is GRANTED, not once the call's own work has settled, so up
// to `policy.maxConcurrency` calls run concurrently once each has cleared the interval floor.
//
// Dependency-free by design (clock/sleep injected) so it is unit-testable with a fake clock,
// same convention as ledger.ts/round.ts.

import type { HostPolicy } from './host-policy.js'

// Whether a cooldown came from a CHALLENGE (a vendor-marker verdict, or the caller's own
// policy skip — see fetch-chain.ts's origin-skip branch) or from a marker-less RATE-LIMIT
// (429, no anti-bot signature). The distinction is what decides whether the cooldown is any
// evidence a human-driven browser would fare better: a challenge is exactly what a human
// solves, a rate limit is only "slow down" and a human does nothing for it.
export type CooldownKind = 'challenge' | 'rate-limit'

export interface HostGate {
  /**
   * Runs `fn` once this host has a free concurrency slot AND the minimum interval since the
   * previous call's START has elapsed. Rejects (never wedging the queue for later callers) if
   * `signal` aborts while waiting or while `fn` runs.
   *
   * Enforcing the cooldown itself is deliberately left to the CALLER (fetch-chain.ts's
   * `stageSkipReason`) rather than done here: `run()` only serializes concurrency/interval, and
   * a caller with reason to try anyway (a rescue rung, a caller that already checked and wants
   * to probe) is not blocked out by a gate that re-checked on its own. Enforcing it here too
   * would also race the cooldown being set by a concurrent `noteBlocked` call between grant
   * and the caller's own check — the caller's stageSkipReason check right before calling `run`
   * is the smaller, already-correct surface.
   */
  run<T>(host: string, policy: HostPolicy, fn: () => Promise<T>, signal?: AbortSignal): Promise<T>
  noteBlocked(host: string, info: { retryAfterSec?: number | undefined; reason: string; kind: CooldownKind }): void
  /**
   * `startedAt` (this clock's domain, i.e. `Date.now()` unless a fake clock is injected) guards
   * against a STALE success clearing a FRESHER cooldown: with `maxConcurrency > 1`, a request
   * that started before another concurrent request discovered a block can still resolve `ok`
   * afterward — its own success predates that knowledge, so it must not wipe out the cooldown
   * the other request just set. Omit `startedAt` to clear unconditionally (a caller with no
   * concurrent-attempt ambiguity to guard against).
   */
  noteOk(host: string, opts?: { startedAt?: number }): void
  cooldown(host: string): { until: number; reason: string; strikes: number; kind: CooldownKind } | null
}

export interface HostGateDeps {
  now?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

// Escalating cooldown when a host blocks us with no Retry-After to go by: 10 min, 30 min, then
// 2h for every strike after that. Retry-After (capped at 1h, see parseRetryAfter) always wins
// when the origin gave us one.
const ESCALATION_MS = [10 * 60_000, 30 * 60_000, 2 * 60 * 60_000]
const RETRY_AFTER_CAP_SEC = 3600

// Hosts idle long enough to be forgotten rather than grow the map without bound — this is a
// safety valve, not a tuning knob; a real job's host set is a few dozen at most.
const MAX_HOSTS = 1000

interface HostState {
  active: number
  /**
   * Callers that have entered `run()` for this host but not yet released their slot — counts
   * a caller queued on the decision chain or sleeping out `minIntervalMs`, neither of which
   * bumps `active` or pushes a `releaseWaiters` entry yet. Without this, such a caller's
   * HostState could be evicted mid-wait and a second, independent state created for the same
   * host on its next `getState` call — silently doubling the effective concurrency/interval
   * ceiling for that host. Incremented at the top of `run()`, decremented in its `finally`.
   */
  pending: number
  lastStartAt: number
  decisionChain: Promise<void>
  releaseWaiters: Array<() => void>
  cooldownUntil: number
  cooldownReason: string
  cooldownKind: CooldownKind
  /** When the current cooldown was (last) set/extended by `noteBlocked` — the clock this
   * module's `now()` uses, not `performance.now()`. Drives `noteOk`'s staleness guard above. */
  cooldownSetAt: number
  strikes: number
  lastTouchedAt: number
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function abortError(signal: AbortSignal): Error {
  return (signal.reason as Error | undefined) ?? new DOMException('Aborted', 'AbortError')
}

export function createHostGate(deps?: HostGateDeps): HostGate {
  const now = deps?.now ?? (() => Date.now())
  const sleep = deps?.sleep ?? defaultSleep
  const states = new Map<string, HostState>()

  function newState(): HostState {
    return {
      active: 0,
      pending: 0,
      lastStartAt: -Infinity,
      decisionChain: Promise.resolve(),
      releaseWaiters: [],
      cooldownUntil: 0,
      cooldownReason: '',
      cooldownKind: 'rate-limit',
      cooldownSetAt: 0,
      strikes: 0,
      lastTouchedAt: now(),
    }
  }

  // Never evicts a host with an in-flight call, a caller pending on the decision chain or the
  // interval sleep, a queued waiter, or a live cooldown — all four are live state a future
  // caller still depends on (an in-flight `run()`'s release callback, a caller between `run()`'s
  // entry and its own slot grant, a queued waiter's promise, or the cooldown itself), unlike a
  // merely idle-but-touched entry. If EVERY host is in one of those states, this is a no-op and
  // the map is briefly allowed past MAX_HOSTS — the safety valve yielding to genuinely live
  // state, never silently corrupting it.
  function evictIdleIfFull(): void {
    if (states.size < MAX_HOSTS) return
    let oldestHost: string | null = null
    let oldestAt = Infinity
    for (const [host, state] of states) {
      if (state.active > 0 || state.pending > 0 || state.releaseWaiters.length > 0) continue
      if (state.cooldownUntil > now()) continue
      if (state.lastTouchedAt < oldestAt) {
        oldestAt = state.lastTouchedAt
        oldestHost = host
      }
    }
    if (oldestHost) states.delete(oldestHost)
  }

  function getState(host: string): HostState {
    let state = states.get(host)
    if (!state) {
      evictIdleIfFull()
      state = newState()
      states.set(host, state)
    }
    state.lastTouchedAt = now()
    return state
  }

  function wakeReleaseWaiters(state: HostState): void {
    const waiters = state.releaseWaiters.splice(0)
    for (const wake of waiters) wake()
  }

  function waitForRelease(state: HostState, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError(signal))
      const onRelease = (): void => {
        cleanup()
        resolve()
      }
      const onAbort = (): void => {
        cleanup()
        reject(abortError(signal!))
      }
      const cleanup = (): void => {
        const i = state.releaseWaiters.indexOf(onRelease)
        if (i >= 0) state.releaseWaiters.splice(i, 1)
        signal?.removeEventListener('abort', onAbort)
      }
      state.releaseWaiters.push(onRelease)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  function acquireSlot(state: HostState, policy: HostPolicy, signal?: AbortSignal): Promise<() => void> {
    const decided = state.decisionChain.then(async () => {
      for (;;) {
        if (signal?.aborted) throw abortError(signal)
        if (state.active < policy.maxConcurrency) break
        await waitForRelease(state, signal)
      }
      const waitMs = state.lastStartAt + policy.minIntervalMs - now()
      if (waitMs > 0) await sleep(waitMs, signal)
      if (signal?.aborted) throw abortError(signal)
      state.active++
      state.lastStartAt = now()
    })
    // The chain must advance for the NEXT waiter regardless of whether this decision
    // succeeded or the caller's signal aborted it — otherwise one aborted caller would wedge
    // every later caller behind it for the rest of the process (same reasoning as
    // rate-gate.ts's `chain` continuation).
    state.decisionChain = decided.then(
      () => {},
      () => {},
    )
    return decided.then(() => {
      let released = false
      return () => {
        if (released) return
        released = true
        state.active--
        wakeReleaseWaiters(state)
      }
    })
  }

  return {
    async run(host, policy, fn, signal) {
      const state = getState(host)
      // Counted from the moment `run()` is entered — a caller queued on `state.decisionChain`
      // or sleeping out `policy.minIntervalMs` has neither bumped `active` nor pushed a
      // `releaseWaiters` entry yet, so without this the host's state could be evicted out from
      // under it by a concurrent `getState` call on some OTHER host (see `pending` on
      // `HostState` above).
      state.pending++
      try {
        const release = await acquireSlot(state, policy, signal)
        try {
          return await fn()
        } finally {
          release()
        }
      } finally {
        state.pending--
      }
    },

    noteBlocked(host, { retryAfterSec, reason, kind }) {
      const state = getState(host)
      // Escalate the strike count only if the PREVIOUS cooldown has already expired. With
      // `maxConcurrency > 1`, several concurrent requests can all hit the same WAF within
      // milliseconds of each other — without this guard that burst reads as strikes 1, 2, 3 and
      // jumps straight to the 2h rung off a single wave of blocks, not three independent ones.
      // A block landing DURING a live cooldown still extends it (never shortens it — `max`
      // below) but does not itself add a strike.
      //
      // A Retry-After-driven block never advances the ladder either — its cooldown length comes
      // straight from the origin's own header, not from `state.strikes`, so counting it as a
      // strike would silently burn a rung: a LATER marker-less block (no Retry-After) reads
      // `state.strikes` and would otherwise skip straight to a later rung it never earned.
      const cooldownActive = now() < state.cooldownUntil
      if (retryAfterSec === undefined && !cooldownActive) state.strikes++
      const ms =
        retryAfterSec !== undefined
          ? Math.min(retryAfterSec, RETRY_AFTER_CAP_SEC) * 1000
          : ESCALATION_MS[Math.min(state.strikes - 1, ESCALATION_MS.length - 1)]! // index is always in [0, length-1]
      const candidateUntil = now() + ms
      state.cooldownUntil = cooldownActive ? Math.max(state.cooldownUntil, candidateUntil) : candidateUntil
      state.cooldownReason = reason
      // A block landing DURING a live cooldown merges its kind into the existing one rather
      // than replacing it outright — CHALLENGE wins: once a cooldown carries evidence a human
      // could help, a later marker-less rate-limit landing in the same window must not paper
      // over that evidence (it would make a chain that skips origin next time wrongly decide
      // a human is not worth trying). A fresh cooldown (not active) simply takes the new kind.
      state.cooldownKind = cooldownActive ? (state.cooldownKind === 'challenge' || kind === 'challenge' ? 'challenge' : 'rate-limit') : kind
      state.cooldownSetAt = now()
    },

    noteOk(host, opts) {
      const state = states.get(host)
      if (!state) return
      const startedAt = opts?.startedAt
      // Only clear when this success is not STALE relative to the cooldown: if the cooldown was
      // set (or last extended) AFTER this caller's own request began, some OTHER, more recent
      // request discovered the host is blocked while this one was still in flight — this success
      // predates that knowledge and must not erase it. `startedAt` omitted means the caller has
      // no such ambiguity to guard against, so it clears unconditionally (the pre-existing
      // behavior every non-fetch-chain call site still gets).
      if (startedAt !== undefined && state.cooldownSetAt > startedAt) return
      state.strikes = 0
      state.cooldownUntil = 0
      state.cooldownReason = ''
    },

    cooldown(host) {
      const state = states.get(host)
      if (!state || state.cooldownUntil <= now()) return null
      return { until: state.cooldownUntil, reason: state.cooldownReason, strikes: state.strikes, kind: state.cooldownKind }
    },
  }
}

// Seconds to wait before retrying, from a `Retry-After` header value — either delta-seconds
// (`"120"`) or an HTTP-date. Capped at 1h same as the cooldown ceiling; returns undefined for
// an absent, unparseable, or already-past value, letting the caller fall back to strike-based
// escalation.
export function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return Math.min(Number(trimmed), RETRY_AFTER_CAP_SEC)
  const dateMs = Date.parse(trimmed)
  if (Number.isNaN(dateMs)) return undefined
  const deltaSec = Math.round((dateMs - now) / 1000)
  if (deltaSec <= 0) return undefined
  return Math.min(deltaSec, RETRY_AFTER_CAP_SEC)
}
