// Fixture for parse-pool.test.ts's hang-guard case: receives every parse request and never
// answers it, so the pool's own hang guard is what has to notice and recover — not a
// `__hang` flag inside the production `parse-worker.ts`, which must stay free of test-only
// branches. `parse-pool.test.ts` points a pool at this file with a tiny `hangGuardMs` so the
// test does not wait out the real 60s default.
addEventListener('message', () => {
  // Deliberately silent — no postMessage, ever.
})
