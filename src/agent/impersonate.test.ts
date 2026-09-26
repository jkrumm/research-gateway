import { describe, it, expect } from 'bun:test'

// Same boot convention as fetch-chain.test.ts: impersonate.ts imports `../lib/log.js`, which
// pulls in env.ts, which parses process.env at import time and throws without secrets — so the
// module graph is pulled in with a dynamic import AFTER these are set.
process.env['API_SECRET'] ??= 'test-secret'
process.env['IU_BASE_URL'] ??= 'https://example.invalid/v1'
process.env['IU_API_KEY'] ??= 'test-key'
process.env['TAVILY_API_KEY'] ??= 'test-key'

const { _test } = await import('./impersonate.js')

// Only the memoization race around the lazy `impit` client load is tested here — the client's
// own `.fetch` touches a native binding and the network, same category as
// impersonate-memory.test.ts's header comment (ytdlp.ts/pdf.ts/human-solve.ts: untested by
// convention, exercised live). `_test.reset()` clears the module-level singleton before each
// case so tests don't leak the memoized promise into each other.

describe('getImpitClient memoization', () => {
  it('shares ONE load across two concurrent first callers instead of racing two imports', async () => {
    _test.reset()

    const [a, b] = await Promise.all([_test.getImpitClient(), _test.getImpitClient()])

    expect(_test.loadAttempts).toBe(1)
    // Both callers must observe the exact same settled value (both the real client, or both
    // `null` if the native binding is unavailable in this environment) — never two independently
    // constructed clients.
    expect(a).toBe(b)
  })

  it('reuses the memoized promise on a later, non-concurrent call — still only one load', async () => {
    _test.reset()

    await _test.getImpitClient()
    await _test.getImpitClient()

    expect(_test.loadAttempts).toBe(1)
  })
})
