// Pure per-host learning state for the impersonation rung (impersonate.ts): which hosts 403 a
// plain fetch but read fine through the impersonated fetch. Split from impersonate.ts so it can
// be tested without importing env (impersonate.ts logs, and log.ts pulls in env.ts).


// Same safety-valve cap as host-gate.ts's MAX_HOSTS — a real job's host set is a few dozen at
// most; this guards only against unbounded growth over a long-lived process.
const MAX_LEARNED_HOSTS = 1000
// A day: long enough that a job's later chains for the same host all benefit, short enough
// that a host whose block was lifted (or whose impersonation defense caught up) is re-probed
// with a plain fetch again eventually rather than paying the impersonation rung forever.
const LEARNED_TTL_MS = 24 * 60 * 60_000

export interface ImpersonationMemory {
  /** Records that a plain fetch was blocked on this host but the impersonation rung read the
   * page — later chains for this host (within the TTL) skip straight to impersonation. */
  noteWorks(host: string): void
  /** Whether this host should skip the plain-fetch probe and go straight to the impersonated
   * fetch — learned within the last `LEARNED_TTL_MS`. */
  prefers(host: string): boolean
  /** Drops a learned preference — the host blocked the impersonated fetch too, so there is
   * nothing left to gain from skipping the plain fetch on the next chain. */
  noteFailed(host: string): void
}

export interface ImpersonationMemoryDeps {
  now?: () => number
}

// Dependency-free by design (clock injected) so it is unit-testable without a shared,
// process-wide map leaking learned state between test cases — same convention as
// host-gate.ts's `createHostGate`.
export function createImpersonationMemory(deps?: ImpersonationMemoryDeps): ImpersonationMemory {
  const now = deps?.now ?? (() => Date.now())
  const learnedHosts = new Map<string, number>() // host -> learnedAt

  function evictOldestIfFull(): void {
    if (learnedHosts.size < MAX_LEARNED_HOSTS) return
    let oldestHost: string | null = null
    let oldestAt = Infinity
    for (const [host, learnedAt] of learnedHosts) {
      if (learnedAt < oldestAt) {
        oldestAt = learnedAt
        oldestHost = host
      }
    }
    if (oldestHost) learnedHosts.delete(oldestHost)
  }

  return {
    noteWorks(host) {
      if (!learnedHosts.has(host)) evictOldestIfFull()
      learnedHosts.set(host, now())
    },
    prefers(host) {
      const learnedAt = learnedHosts.get(host)
      if (learnedAt === undefined) return false
      // A negative age (the clock stepping backward — a system clock adjustment, an injected
      // test clock misused) must never read as "within the TTL": that check alone (`age <
      // LEARNED_TTL_MS`) is trivially true for any negative age, which would make a host learned
      // moments "in the future" relative to a since-rewound clock stay preferred forever.
      const age = now() - learnedAt
      return age >= 0 && age < LEARNED_TTL_MS
    },
    noteFailed(host) {
      learnedHosts.delete(host)
    },
  }
}

// One memory shared by every chain that doesn't inject its own — real production wants ONE
// learned-preference map across every worker of every concurrent job, same reasoning as
// fetch-chain.ts's `defaultHostGate`.
export const defaultImpersonationMemory: ImpersonationMemory = createImpersonationMemory()
