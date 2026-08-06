// A general-purpose counting semaphore. Lifted out of `lightpanda/semaphore.ts` (which keeps
// its own copy — the sidecar is a separate build and does not import across that boundary)
// for a second caller with the same shape of problem: `agent/ytdlp.ts` bounds concurrent
// yt-dlp processes the same way the sidecar bounds concurrent renders, both because the
// downstream resource (YouTube's rate limit; the sidecar's memory limit) is not a tuning
// preference but a hard ceiling.
//
// Pure and dependency-free so it is unit-testable without booting env.ts or spawning anything.

export interface Semaphore {
  /** Resolves true once a slot is held, or false if the queue wait elapsed (nothing held). */
  acquire: () => Promise<boolean>
  /** Give a held slot back. Must be called exactly once per successful acquire. */
  release: () => void
  readonly active: number
  readonly queued: number
}

export function createSemaphore(limit: number, queueTimeoutMs: number): Semaphore {
  let active = 0
  const waiting: Array<() => void> = []

  const release = (): void => {
    active--
    const next = waiting.shift()
    if (next) next()
  }

  const acquire = (): Promise<boolean> => {
    if (active < limit) {
      active++
      return Promise.resolve(true)
    }
    return new Promise((resolve) => {
      // `settled` guards the race the timeout path would otherwise lose: a waiter can be
      // granted a slot and time out in the same tick. Granting twice would let `active` exceed
      // the limit — which is an OOM, not a glitch — and resolving twice after the splice would
      // leak a permanently held slot.
      let settled = false
      const grant = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        active++
        resolve(true)
      }
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        const at = waiting.indexOf(grant)
        if (at >= 0) waiting.splice(at, 1)
        resolve(false)
      }, queueTimeoutMs)
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
