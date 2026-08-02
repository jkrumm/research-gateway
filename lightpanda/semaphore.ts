// The render-slot semaphore. Split out of server.ts for the same reason parse.ts was: it is
// pure, dependency-free logic that decides whether this container stays inside its memory
// limit, and it should be testable without spawning a browser.
//
// What it is protecting is in lightpanda/server.ts — the short version is that a render costs
// 100-205 MB and the container has 768 MiB, so the number of simultaneous renders is not a
// tuning preference, it is the memory limit restated.

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
