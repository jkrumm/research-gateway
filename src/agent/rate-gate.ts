// A serialized, floored-interval call gate — export.arxiv.org's own rate policy (1 request /
// 3s, ONE connection) and Semantic Scholar's unauthenticated tier need exactly this shape:
// every call through the gate waits for both the previous call to have SETTLED and the
// minimum interval since the previous call's start to have elapsed, before it may run.
//
// Process-wide, not per-worker or per-job: every worker of every concurrent job shares the
// one arXiv/S2 gateway process, so the gate itself must be a single shared instance (see
// `direct-sources.ts`'s `arxivGate`/`semanticScholarGate`).
//
// Dependency-free by design (same convention as `ledger.ts`/`round.ts`) so it is unit-testable
// without booting the env-parsing chain.
export function createRateGate(minIntervalMs: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let chain: Promise<void> = Promise.resolve()
  let lastRunAt = 0
  return function gated<T>(fn: () => Promise<T>): Promise<T> {
    const runAfter = chain.then(async () => {
      // The interval is counted from the previous request's START, not the previous
      // request's END — stamped here, immediately before this call's own fn() runs.
      const wait = lastRunAt + minIntervalMs - Date.now()
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
      lastRunAt = Date.now()
      return fn()
    })
    // The queue advances only once fn() has SETTLED, not merely once the wait has elapsed —
    // chaining on the wait alone (the bug this fixes) let two calls' fn()s run concurrently
    // whenever the first was slow, defeating the "one connection" half of the policy. It must
    // still advance when fn() rejects, or a single failed call would wedge every later call
    // behind it for the rest of the process — the rejection itself still reaches the caller
    // via `runAfter`, only the CHAIN's own continuation swallows it.
    chain = runAfter.then(
      () => {},
      () => {},
    )
    return runAfter
  }
}
