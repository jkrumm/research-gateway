// A general-purpose counting semaphore. Lifted out of `lightpanda/semaphore.ts` (which keeps
// its own copy — the sidecar is a separate build and does not import across that boundary)
// for a second caller with the same shape of problem: `agent/ytdlp.ts` bounds concurrent
// yt-dlp processes the same way the sidecar bounds concurrent renders, both because the
// downstream resource (YouTube's rate limit; the sidecar's memory limit) is not a tuning
// preference but a hard ceiling.
//
// Pure and dependency-free so it is unit-testable without booting env.ts or spawning anything.

export interface Semaphore {
  /**
   * Resolves true once a slot is held, or false if the queue wait elapsed OR `signal` aborted
   * before a slot came free (nothing held either way). `signal` is optional — a caller with no
   * deadline of its own (pdf-semaphore.ts's queued PDF extractions, tied to the fetch chain's
   * budget/cancel) can still be woken the moment that signal fires rather than sitting in the
   * queue silently until `queueTimeoutMs` (if any) elapses.
   */
  acquire: (signal?: AbortSignal) => Promise<boolean>
  /** Give a held slot back. Must be called exactly once per successful acquire. */
  release: () => void
  readonly active: number
  readonly queued: number
}

/**
 * `queueTimeoutMs` is OPTIONAL — omitted (or `undefined`) means a queued waiter never times
 * out on its own, only ever settling by being granted a slot or by its `acquire(signal)` call
 * aborting. This is pdf-semaphore.ts's old `createUnboundedSemaphore` contract (no caller-side
 * deadline to protect, only a cap on how many may run AT ONCE — see that file's header),
 * folded into this one function rather than kept as a second, hand-copied implementation.
 * Every existing caller passes a concrete `queueTimeoutMs` and is unaffected.
 */
export function createSemaphore(limit: number, queueTimeoutMs?: number): Semaphore {
  if (!(limit > 0)) throw new Error(`createSemaphore: limit must be a positive number, got ${limit}`)
  let active = 0
  const waiting: Array<() => void> = []

  const release = (): void => {
    // A release with nothing held (a double-release, or a caller bug) must never drive
    // `active` negative — a negative count would let `active < limit` admit MORE than the
    // limit the very next time a slot is freed for real, defeating the cap silently.
    if (active <= 0) return
    active--
    const next = waiting.shift()
    if (next) next()
  }

  const acquire = (signal?: AbortSignal): Promise<boolean> => {
    if (signal?.aborted) return Promise.resolve(false)
    if (active < limit) {
      active++
      return Promise.resolve(true)
    }
    return new Promise((resolve) => {
      // `settled` guards the races a queued waiter can lose in the same tick: granted a slot
      // and timed out, or granted a slot and its signal aborted. Granting twice would let
      // `active` exceed the limit — which is an OOM, not a glitch — and resolving twice after
      // the splice would leak a permanently held slot.
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
      const grant = (): void => {
        if (settled) return
        settled = true
        cleanup()
        active++
        resolve(true)
      }
      const giveUp = (): void => {
        if (settled) return
        settled = true
        cleanup()
        const at = waiting.indexOf(grant)
        if (at >= 0) waiting.splice(at, 1)
        resolve(false)
      }
      const onAbort = (): void => giveUp()
      if (queueTimeoutMs !== undefined) timer = setTimeout(giveUp, queueTimeoutMs)
      signal?.addEventListener('abort', onAbort, { once: true })
      waiting.push(grant)
    })
  }

  return {
    acquire,
    release,
    get active() {
      return active
    },
    get queued() {
      return waiting.length
    },
  }
}
