import { describe, it, expect } from 'bun:test'
import { createHostGate, parseRetryAfter } from './host-gate.js'
import type { HostPolicy } from './host-policy.js'
import { DEFAULT_HOST_POLICY } from './host-policy.js'

// A fake clock where `sleep` advances simulated time immediately rather than waiting on a
// real timer — deterministic and instant, same idea as fake timers, without needing to fake
// the global Date/setTimeout for every other module loaded in the same test file.
function fakeClock() {
  let t = 0
  const now = () => t
  const sleep = (ms: number, signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    t += ms
    return new Promise((resolve, reject) => {
      if (signal) {
        const onAbort = (): void => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
        signal.addEventListener('abort', onAbort, { once: true })
      }
      resolve()
    })
  }
  return { now, sleep, advance: (ms: number) => (t += ms) }
}

function policy(overrides: Partial<HostPolicy> = {}): HostPolicy {
  return { ...DEFAULT_HOST_POLICY, ...overrides }
}

describe('HostGate.run — concurrency', () => {
  it('runs up to maxConcurrency calls in parallel and queues the rest until a release', async () => {
    const clock = fakeClock()
    const gate = createHostGate(clock)
    const p = policy({ maxConcurrency: 2, minIntervalMs: 0 })

    const order: string[] = []
    let releaseFirst: (() => void) | undefined
    let firstEntered: (() => void) | undefined
    const firstEnteredPromise = new Promise<void>((resolve) => (firstEntered = resolve))
    const first = gate
      .run(
        'h.test',
        p,
        () =>
          new Promise<void>((resolve) => {
            releaseFirst = resolve
            firstEntered?.()
          }),
      )
      .then(() => order.push('first'))
    const second = gate.run('h.test', p, async () => order.push('second'))
    // Wait until the first call has actually entered its body (releaseFirst assigned) before
    // issuing the third — the decision to grant a slot is serialized through microtasks.
    await firstEnteredPromise
    await Promise.resolve()

    let thirdStarted = false
    const third = gate.run('h.test', p, async () => {
      thirdStarted = true
      order.push('third')
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(thirdStarted).toBe(false) // both slots held by first/second — third must wait

    releaseFirst?.()
    await first
    await second
    await third
    expect(thirdStarted).toBe(true)
    expect(order).toContain('third')
  })

  it('a rejected call releases its slot rather than wedging the queue', async () => {
    const clock = fakeClock()
    const gate = createHostGate(clock)
    const p = policy({ maxConcurrency: 1, minIntervalMs: 0 })

    await expect(
      gate.run('h.test', p, async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    // The slot must have been released on throw — a second call gets to run at all.
    let ran = false
    await gate.run('h.test', p, async () => {
      ran = true
    })
    expect(ran).toBe(true)
  })

  it('an aborted waiter does not block a later caller from acquiring the freed slot', async () => {
    const clock = fakeClock()
    const gate = createHostGate(clock)
    const p = policy({ maxConcurrency: 1, minIntervalMs: 0 })

    let releaseFirst: (() => void) | null = null
    const first = gate.run('h.test', p, () => new Promise<void>((resolve) => (releaseFirst = resolve)))

    const controller = new AbortController()
    const aborted = gate.run('h.test', p, async () => {}, controller.signal)
    await Promise.resolve()
    controller.abort(new Error('cancelled'))
    await expect(aborted).rejects.toThrow()

    let thirdRan = false
    const third = gate.run('h.test', p, async () => {
      thirdRan = true
    })
    releaseFirst!()
    await first
    await third
    expect(thirdRan).toBe(true)
  })
})

describe('HostGate.run — minIntervalMs', () => {
  it('floors the interval between call STARTS, not between a call finishing and the next starting', async () => {
    const clock = fakeClock()
    const gate = createHostGate(clock)
    const p = policy({ maxConcurrency: 5, minIntervalMs: 1000 })

    const starts: number[] = []
    await gate.run('h.test', p, async () => {
      starts.push(clock.now())
    })
    await gate.run('h.test', p, async () => {
      starts.push(clock.now())
    })
    await gate.run('h.test', p, async () => {
      starts.push(clock.now())
    })

    expect(starts).toHaveLength(3)
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(1000)
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(1000)
  })
})

describe('HostGate cooldown', () => {
  it('escalates 10min -> 30min -> 2h across repeated strikes with no Retry-After', () => {
    const clock = fakeClock()
    const gate = createHostGate(clock)

    gate.noteBlocked('h.test', { reason: 'blocked: cloudflare challenge (HTTP 403)', kind: 'challenge' })
    expect(gate.cooldown('h.test')?.until).toBe(10 * 60_000)

    clock.advance(10 * 60_000 + 1)
    gate.noteBlocked('h.test', { reason: 'blocked again', kind: 'challenge' })
    expect(gate.cooldown('h.test')?.until).toBe(clock.now() + 30 * 60_000)

    clock.advance(30 * 60_000 + 1)
    gate.noteBlocked('h.test', { reason: 'blocked again', kind: 'challenge' })
    expect(gate.cooldown('h.test')?.until).toBe(clock.now() + 2 * 60 * 60_000)

    // A further strike stays capped at 2h, does not keep escalating.
    clock.advance(2 * 60 * 60_000 + 1)
    gate.noteBlocked('h.test', { reason: 'blocked again', kind: 'challenge' })
    expect(gate.cooldown('h.test')?.until).toBe(clock.now() + 2 * 60 * 60_000)
  })

  it('prefers Retry-After over strike escalation, capped at 1h', () => {
    const clock = fakeClock()
    const gate = createHostGate(clock)
    gate.noteBlocked('h.test', { retryAfterSec: 30, reason: 'rate limited', kind: 'rate-limit' })
    expect(gate.cooldown('h.test')?.until).toBe(30_000)

    gate.noteBlocked('h.test', { retryAfterSec: 999_999, reason: 'rate limited', kind: 'rate-limit' })
    expect(gate.cooldown('h.test')?.until).toBe(clock.now() + 3600_000)
  })

  it('noteOk resets strikes and clears any active cooldown', () => {
    const clock = fakeClock()
    const gate = createHostGate(clock)
    gate.noteBlocked('h.test', { reason: 'blocked', kind: 'challenge' })
    expect(gate.cooldown('h.test')).not.toBeNull()

    gate.noteOk('h.test')
    expect(gate.cooldown('h.test')).toBeNull()

    // Strikes reset — the next block starts back at the 10-minute rung, not an escalated one.
    gate.noteBlocked('h.test', { reason: 'blocked', kind: 'challenge' })
    expect(gate.cooldown('h.test')?.strikes).toBe(1)
    expect(gate.cooldown('h.test')?.until).toBe(clock.now() + 10 * 60_000)
  })

  it('returns null once the cooldown window has elapsed', () => {
    const clock = fakeClock()
    const gate = createHostGate(clock)
    gate.noteBlocked('h.test', { retryAfterSec: 10, reason: 'rate limited', kind: 'rate-limit' })
    expect(gate.cooldown('h.test')).not.toBeNull()
    clock.advance(10_001)
    expect(gate.cooldown('h.test')).toBeNull()
  })

  it('returns null for a host that was never blocked', () => {
    const gate = createHostGate()
    expect(gate.cooldown('never-seen.test')).toBeNull()
  })

  it('does not escalate strikes from concurrent WAF events landing during a live cooldown', () => {
    const clock = fakeClock()
    const gate = createHostGate(clock)

    gate.noteBlocked('h.test', { reason: 'blocked: cloudflare challenge (HTTP 403)', kind: 'challenge' })
    expect(gate.cooldown('h.test')?.strikes).toBe(1)
    expect(gate.cooldown('h.test')?.until).toBe(10 * 60_000)

    // Two more block events land within the same 10-minute window (concurrency>1 hitting the
    // same WAF at once) — must NOT add strikes or jump straight to the 2h rung.
    gate.noteBlocked('h.test', { reason: 'blocked again', kind: 'challenge' })
    gate.noteBlocked('h.test', { reason: 'blocked again', kind: 'challenge' })
    expect(gate.cooldown('h.test')?.strikes).toBe(1)
    expect(gate.cooldown('h.test')?.until).toBe(10 * 60_000)

    // Once that cooldown has actually elapsed, the NEXT block escalates normally.
    clock.advance(10 * 60_000 + 1)
    gate.noteBlocked('h.test', { reason: 'blocked again', kind: 'challenge' })
    expect(gate.cooldown('h.test')?.strikes).toBe(2)
    expect(gate.cooldown('h.test')?.until).toBe(clock.now() + 30 * 60_000)
  })

  it('does not advance the strike ladder for a Retry-After-driven block, so a later marker-less block starts at the first rung', () => {
    const clock = fakeClock()
    const gate = createHostGate(clock)

    gate.noteBlocked('h.test', { retryAfterSec: 30, reason: 'rate limited', kind: 'rate-limit' })
    expect(gate.cooldown('h.test')?.strikes).toBe(0)
    expect(gate.cooldown('h.test')?.until).toBe(30_000)

    clock.advance(30_000 + 1) // the Retry-After cooldown elapses
    gate.noteBlocked('h.test', { reason: 'blocked: cloudflare challenge (HTTP 403)', kind: 'challenge' })
    // Must land on the FIRST escalation rung (10min), not a later one a Retry-After-driven
    // block never earned.
    expect(gate.cooldown('h.test')?.strikes).toBe(1)
    expect(gate.cooldown('h.test')?.until).toBe(clock.now() + 10 * 60_000)
  })

  it('extends (never shortens) a live cooldown when a later block would resolve to an earlier expiry', () => {
    const clock = fakeClock()
    const gate = createHostGate(clock)

    gate.noteBlocked('h.test', { retryAfterSec: 600, reason: 'rate limited', kind: 'rate-limit' }) // until = 600_000
    clock.advance(60_000)
    gate.noteBlocked('h.test', { retryAfterSec: 30, reason: 'rate limited again', kind: 'rate-limit' }) // would be 90_000 alone

    expect(gate.cooldown('h.test')?.until).toBe(600_000) // the longer of the two survives
    expect(gate.cooldown('h.test')?.strikes).toBe(0) // Retry-After-driven blocks never advance the ladder
  })
})

describe('HostGate cooldown — kind merging', () => {
  it('takes the incoming kind when the cooldown was not live', () => {
    const gate = createHostGate()
    gate.noteBlocked('h.test', { reason: 'rate limited', kind: 'rate-limit' })
    expect(gate.cooldown('h.test')?.kind).toBe('rate-limit')
  })

  it('a rate-limit block landing during a live CHALLENGE cooldown does not downgrade it', () => {
    const clock = fakeClock()
    const gate = createHostGate(clock)
    gate.noteBlocked('h.test', { reason: 'blocked: cloudflare challenge (HTTP 403)', kind: 'challenge' })
    clock.advance(1_000)
    gate.noteBlocked('h.test', { reason: 'rate limited (HTTP 429, no vendor signature)', kind: 'rate-limit' })
    expect(gate.cooldown('h.test')?.kind).toBe('challenge')
  })

  it('a challenge block landing during a live RATE-LIMIT cooldown upgrades it', () => {
    const clock = fakeClock()
    const gate = createHostGate(clock)
    gate.noteBlocked('h.test', { reason: 'rate limited', kind: 'rate-limit' })
    clock.advance(1_000)
    gate.noteBlocked('h.test', { reason: 'blocked: cloudflare challenge (HTTP 403)', kind: 'challenge' })
    expect(gate.cooldown('h.test')?.kind).toBe('challenge')
  })

  it('two rate-limit blocks landing during a live rate-limit cooldown stay rate-limit', () => {
    const clock = fakeClock()
    const gate = createHostGate(clock)
    gate.noteBlocked('h.test', { reason: 'rate limited', kind: 'rate-limit' })
    clock.advance(1_000)
    gate.noteBlocked('h.test', { reason: 'rate limited again', kind: 'rate-limit' })
    expect(gate.cooldown('h.test')?.kind).toBe('rate-limit')
  })
})

describe('HostGate.noteOk — startedAt staleness guard', () => {
  it('does not clear a cooldown that was set AFTER the request began', () => {
    const clock = fakeClock()
    const gate = createHostGate(clock)
    const requestStartedAt = clock.now() // request A starts

    clock.advance(100)
    gate.noteBlocked('h.test', { reason: 'blocked by a concurrent request B', kind: 'challenge' }) // set after A started

    gate.noteOk('h.test', { startedAt: requestStartedAt }) // A's own success predates the block
    expect(gate.cooldown('h.test')).not.toBeNull()
  })

  it('clears a cooldown that was already set BEFORE the request began', () => {
    const clock = fakeClock()
    const gate = createHostGate(clock)
    gate.noteBlocked('h.test', { reason: 'blocked earlier', kind: 'challenge' })

    clock.advance(100)
    const requestStartedAt = clock.now() // a fresh request starts after the cooldown was already known
    gate.noteOk('h.test', { startedAt: requestStartedAt })
    expect(gate.cooldown('h.test')).toBeNull()
  })

  it('clears unconditionally when no startedAt is given', () => {
    const gate = createHostGate()
    gate.noteBlocked('h.test', { reason: 'blocked', kind: 'challenge' })
    gate.noteOk('h.test')
    expect(gate.cooldown('h.test')).toBeNull()
  })
})

describe('evictIdleIfFull', () => {
  it('never evicts a host with a live cooldown, even when it is the single oldest-touched host', async () => {
    const clock = fakeClock()
    const gate = createHostGate(clock)
    const p = policy({ maxConcurrency: 1, minIntervalMs: 0 })

    gate.noteBlocked('cooldown.test', { reason: 'blocked', kind: 'challenge' }) // touched + cooldown set at t=0 — oldest in the map

    for (let i = 0; i < 999; i++) {
      clock.advance(1)
      await gate.run(`idle-${i}.test`, p, async () => {})
    }
    // The 1000th host tips the map past MAX_HOSTS and forces an eviction.
    clock.advance(1)
    await gate.run('new-host.test', p, async () => {})

    expect(gate.cooldown('cooldown.test')).not.toBeNull() // survived despite being the oldest touch
  })

  it('never evicts a host with an in-flight call — an idle host is evicted instead', async () => {
    const clock = fakeClock()
    const gate = createHostGate(clock)
    const idlePolicy = policy({ maxConcurrency: 1, minIntervalMs: 0 })
    const busyPolicy = policy({ maxConcurrency: 2, minIntervalMs: 100_000 })

    // busy.test starts first (t=0), so it is the single OLDEST-touched host in the map —
    // without the active-call guard it is exactly what evictIdleIfFull would pick.
    let releaseBusy: (() => void) | undefined
    const busyEntered = new Promise<void>((resolve) => {
      void gate.run(
        'busy.test',
        busyPolicy,
        () =>
          new Promise<void>((r) => {
            releaseBusy = r
            resolve()
          }),
      )
    })
    await busyEntered

    for (let i = 0; i < 999; i++) {
      clock.advance(1)
      await gate.run(`idle-${i}.test`, idlePolicy, async () => {})
    }
    clock.advance(1)
    await gate.run('new-host.test', idlePolicy, async () => {})

    releaseBusy?.()

    // If busy.test's state had been evicted, `lastStartAt` would have reset to -Infinity and
    // this call would start immediately (a ~0 wait) despite the 100s interval floor — it must
    // still wait a substantial amount, proving `lastStartAt: 0` survived.
    const before = clock.now()
    await gate.run('busy.test', busyPolicy, async () => {})
    expect(clock.now() - before).toBeGreaterThan(50_000)
  })

  it('never evicts a host with a queued waiter', async () => {
    const clock = fakeClock()
    const gate = createHostGate(clock)
    const p = policy({ maxConcurrency: 1, minIntervalMs: 0 })

    let releaseFirst: (() => void) | undefined
    const firstEntered = new Promise<void>((resolve) => {
      void gate.run(
        'waiter.test',
        p,
        () =>
          new Promise<void>((r) => {
            releaseFirst = r
            resolve()
          }),
      )
    })
    await firstEntered
    const second = gate.run('waiter.test', p, async () => {}) // queues behind the first — a waiter
    await Promise.resolve()

    for (let i = 0; i < 999; i++) {
      clock.advance(1)
      await gate.run(`idle-${i}.test`, p, async () => {})
    }
    clock.advance(1)
    await gate.run('new-host.test', p, async () => {})

    releaseFirst?.()
    // If waiter.test's state had been evicted mid-queue, the waiter's own promise would be
    // orphaned on the deleted object and never resolve — completing at all is the proof it
    // survived.
    await second
  })

  it('never evicts a host whose caller passed the concurrency check but is still sleeping out minIntervalMs', async () => {
    // The gap `pending` closes: once the first call to a host has completed, `active` is back
    // to 0 and there is no queued waiter — a SECOND call that then hits the interval floor sits
    // in `sleep()` with neither guard raised, before `active` is incremented. Only `pending`
    // protects the host's state in that window.
    const clock = fakeClock()
    const pendingSleeps: Array<() => void> = []
    let sleepCalls = 0
    const controlledSleep = (): Promise<void> => {
      sleepCalls++
      return new Promise((resolve) => pendingSleeps.push(resolve))
    }
    const gate = createHostGate({ now: clock.now, sleep: controlledSleep })
    const p = policy({ maxConcurrency: 1, minIntervalMs: 100_000 })
    const idlePolicy = policy({ maxConcurrency: 1, minIntervalMs: 0 })

    // First call: no prior lastStartAt, so no sleep is needed — completes immediately.
    await gate.run('interval.test', p, async () => {})
    expect(sleepCalls).toBe(0)

    // Second call: the interval floor forces a sleep before `active` is incremented.
    const second = gate.run('interval.test', p, async () => {})
    for (let i = 0; i < 50 && sleepCalls === 0; i++) await Promise.resolve()
    expect(sleepCalls).toBe(1)

    for (let i = 0; i < 999; i++) {
      clock.advance(1)
      await gate.run(`idle-${i}.test`, idlePolicy, async () => {})
    }
    clock.advance(1)
    await gate.run('new-host.test', idlePolicy, async () => {})

    pendingSleeps.shift()!()
    await second

    // A third call for the same host: if `interval.test`'s state had survived the eviction
    // attempt, `lastStartAt` (just set by the second call) still forces a sleep here too. If it
    // had been evicted, `getState` would have created a FRESH state with `lastStartAt:
    // -Infinity`, and this call would proceed without ever calling `sleep` at all.
    const sleepCallsBeforeThird = sleepCalls
    const third = gate.run('interval.test', p, async () => {})
    // Bounded, not an unconditional `while` — if the fix regressed, the third call never calls
    // `sleep` at all, and an unbounded loop here would just hang until the test's own timeout.
    for (let i = 0; i < 50 && sleepCalls === sleepCallsBeforeThird; i++) await Promise.resolve()
    expect(sleepCalls).toBe(sleepCallsBeforeThird + 1)
    pendingSleeps.shift()!()
    await third
  })
})

describe('parseRetryAfter', () => {
  it('parses delta-seconds', () => {
    expect(parseRetryAfter('120', 0)).toBe(120)
  })

  it('caps delta-seconds at 3600', () => {
    expect(parseRetryAfter('7200', 0)).toBe(3600)
  })

  it('parses an HTTP-date relative to now', () => {
    const now = Date.parse('2026-09-26T00:00:00Z')
    const future = new Date(now + 45_000).toUTCString()
    expect(parseRetryAfter(future, now)).toBe(45)
  })

  it('returns undefined for a past HTTP-date, an unparseable value, or no value', () => {
    const now = Date.parse('2026-09-26T00:00:00Z')
    const past = new Date(now - 1000).toUTCString()
    expect(parseRetryAfter(past, now)).toBeUndefined()
    expect(parseRetryAfter('not a date', now)).toBeUndefined()
    expect(parseRetryAfter(null, now)).toBeUndefined()
  })
})
