import { describe, it, expect, afterEach } from 'bun:test'
import { createHostGate } from './host-gate.js'
import type { HumanSolveRequest, FetchChainOptions } from './fetch-chain.js'

// Same boot convention as otel-spans.test.ts: fetch-chain.ts imports env.ts, which parses
// process.env at import time and throws without secrets — so the module graph is pulled in
// with a dynamic import AFTER these are set, rather than by a hoisted static import.
// `??=` so a real environment is never clobbered.
process.env['API_SECRET'] ??= 'test-secret'
process.env['IU_BASE_URL'] ??= 'https://example.invalid/v1'
process.env['IU_API_KEY'] ??= 'test-key'
process.env['TAVILY_API_KEY'] ??= 'test-key'

const { runFetchChain, hostOf } = await import('./fetch-chain.js')
const { createLedger } = await import('./ledger.js')
const { _test: parseTest } = await import('./html-parse.js')
const { createImpersonationMemory, defaultImpersonationMemory } = await import('./impersonate.js')

// @tavily/core calls out over axios, not `fetch` (see fetch-chain.ts's `tavilyExtract` option
// header comment) — stubbing globalThis.fetch cannot reach it. Every test below that reaches
// step 3 injects this instead of touching the network with the fake `TAVILY_API_KEY` above.
function stubTavilyFail(errorMsg = 'stubbed: no tavily in tests'): NonNullable<FetchChainOptions['tavilyExtract']> {
  return async (urls) => ({
    results: [],
    failedResults: urls.map((u) => ({ url: u, error: errorMsg })),
    responseTime: 0,
    requestId: 'test',
  })
}

// The impersonation rung's own fetcher is a separate injectable seam (impersonate.ts's
// `impersonatedFetch`, wired through `FetchChainOptions.impersonatedFetch`) — production never
// sets it, and every test below that can reach a 401/403/503 block must inject SOMETHING here,
// or the chain falls through to the REAL `impersonatedFetch`, which touches the native impit
// binding and the real network. Tests that don't care about the rung use this: an immediate
// failure that puts the chain back on exactly the path it took before the rung existed.
function stubImpersonateUnavailable(): NonNullable<FetchChainOptions['impersonatedFetch']> {
  return async () => {
    throw new Error('stub: impersonation not available in this test')
  }
}

// TEST-NET-3: a literal, public, non-routable IP — the SSRF guard passes it without a DNS
// query and nothing here touches the network (same reason as otel-spans.test.ts).
const PAGE = 'https://203.0.113.20/page'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

function stubFetch(handler: (url: string) => Response): void {
  globalThis.fetch = ((input: unknown) => Promise.resolve(handler(String(input)))) as typeof fetch
}

// A fetch that never settles on its own: it only rejects when the caller's signal aborts. This
// is the pathological case the budget exists for — a degraded origin that would otherwise chain
// the per-step timeouts (10s + 60s + 30s + wayback) into minutes.
function stubHangingFetch(): void {
  globalThis.fetch = ((_input: unknown, init?: { signal?: AbortSignal | null }) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      if (signal?.aborted) {
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
        return
      }
      signal?.addEventListener(
        'abort',
        () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError')),
        { once: true },
      )
    })) as unknown as typeof fetch
}

const long = 'Paragraph with enough real words to read as article content and clear the two-hundred character floor.'
const htmlPage = () =>
  `<html><head><title>Test</title></head><body><article><h1>Heading</h1>${Array.from(
    { length: 30 },
    (_, i) => `<p>${i} ${long}</p>`,
  ).join('')}</article></body></html>`

describe('fetch chain budget', () => {
  it('aborts a hanging chain and returns the failure shape once the budget is spent', async () => {
    stubHangingFetch()
    const started = performance.now()
    const result = await runFetchChain(PAGE, { ledger: createLedger(), budgetMs: 100 })
    const elapsed = performance.now() - started

    // The failure shape, not a throw: via null, text null, an error naming the budget. The
    // budget is the WHOLE point — the call must land promptly rather than after the per-step
    // timeouts stack up into minutes.
    expect(result.via).toBeNull()
    expect(result.text).toBeNull()
    expect(result.error).toContain('budget exhausted')
    expect(elapsed).toBeLessThan(5_000)
  })
})

describe('off-main-thread parsing', () => {
  it('parses HTML in the worker pool and returns the extracted text', async () => {
    const before = parseTest.dispatched
    stubFetch(
      () => new Response(htmlPage(), { status: 200, headers: { 'content-type': 'text/html' } }),
    )

    const result = await runFetchChain(PAGE, { ledger: createLedger() })

    expect(result.via).toBe('readability')
    expect(result.text).toContain('real words to read as article content')
    // `dispatched` moved: the parse actually left the main thread, not just ran inline.
    expect(parseTest.dispatched).toBeGreaterThan(before)
  })
})

describe('challenge detection + host gate', () => {
  it('classifies a decisive cloudflare block on a 403, skips lightpanda for this chain, and records a cooldown', async () => {
    stubFetch(
      () => new Response('<title>Just a moment...</title>', { status: 403, headers: { 'cf-mitigated': 'challenge', 'content-type': 'text/html' } }),
    )
    const hostGate = createHostGate()

    const result = await runFetchChain(PAGE, {
      ledger: createLedger(),
      renderBaseUrl: 'https://198.51.100.9', // TEST-NET-2 — never dialled, origin is blocked decisively first
      hostGate,
      tavilyExtract: stubTavilyFail(),
      impersonatedFetch: stubImpersonateUnavailable(),
    })

    const originAttempt = result.attempts.find((a) => a.step === 'readability')
    expect(originAttempt?.error).toMatch(/^blocked: cloudflare/)
    expect(originAttempt?.blocked).toMatch(/^blocked: cloudflare/)

    const renderAttempt = result.attempts.find((a) => a.step === 'lightpanda')
    expect(renderAttempt?.error).toBe('skipped: origin challenged')

    expect(hostGate.cooldown(hostOf(PAGE))).not.toBeNull()
  })

  it('skips the origin on a second call to the same host during its cooldown, without dialling it again', async () => {
    let originCalls = 0
    stubFetch((u) => {
      if (u === PAGE) originCalls++
      return new Response('<title>Just a moment...</title>', { status: 403, headers: { 'cf-mitigated': 'challenge', 'content-type': 'text/html' } })
    })
    const hostGate = createHostGate()
    const tavilyExtract = stubTavilyFail()
    const impersonatedFetch = stubImpersonateUnavailable()

    await runFetchChain(PAGE, { ledger: createLedger(), hostGate, tavilyExtract, impersonatedFetch })
    expect(originCalls).toBe(1)

    const second = await runFetchChain(PAGE, { ledger: createLedger(), hostGate, tavilyExtract, impersonatedFetch })
    const originAttempt = second.attempts.find((a) => a.step === 'readability')
    expect(originAttempt?.error).toMatch(/^skipped: cooldown/)
    expect(originCalls).toBe(1) // the origin was not dialled again while in cooldown
  })

  it('invokes the human-solve stage after tavily fails, once this chain has seen a block', async () => {
    stubFetch(() => new Response('Access denied', { status: 403, headers: { 'cf-mitigated': 'challenge', 'content-type': 'text/html' } }))

    let humanCalls = 0
    const humanSolve = async (req: HumanSolveRequest) => {
      humanCalls++
      expect(req.url).toBe(PAGE)
      expect(req.reason).toContain('tavily')
      return { ok: true as const, html: htmlPage(), finalUrl: PAGE, mode: 'solved' as const }
    }
    const hostGate = createHostGate()

    const result = await runFetchChain(PAGE, {
      ledger: createLedger(),
      hostGate,
      tavilyExtract: stubTavilyFail(),
      impersonatedFetch: stubImpersonateUnavailable(),
      humanSolve,
    })

    expect(humanCalls).toBe(1)
    expect(result.via).toBe('human')
    expect(result.text).toContain('real words to read as article content')
    // A human solve on the MacBook says nothing about whether the mini's OWN IP is unblocked —
    // the cooldown the plain 403 set stays standing, unlike a successful impersonation.
    expect(hostGate.cooldown(hostOf(PAGE))).not.toBeNull()
  })

  it('recovers a human solve that resolves after the chain budget has already expired', async () => {
    // The bug this guards: `tryHumanSolve` used to parse the solved HTML against the CHAIN's
    // own budget signal, which a multi-minute human solve always outlives — so a successful
    // solve was thrown away the moment `extractText` saw an already-aborted signal. `budgetMs`
    // here is tiny and the solver takes longer than it on purpose.
    stubFetch(() => new Response('<title>Just a moment...</title>', { status: 403, headers: { 'cf-mitigated': 'challenge', 'content-type': 'text/html' } }))
    const humanSolve = async () => {
      await new Promise((resolve) => setTimeout(resolve, 100))
      return { ok: true as const, html: htmlPage(), finalUrl: PAGE, mode: 'solved' as const }
    }

    const result = await runFetchChain(PAGE, {
      ledger: createLedger(),
      hostGate: createHostGate(),
      tavilyExtract: stubTavilyFail(),
      impersonatedFetch: stubImpersonateUnavailable(),
      humanSolve,
      budgetMs: 50,
    })

    expect(result.via).toBe('human')
    expect(result.text).toContain('real words to read as article content')
  })

  it('does not invoke human-solve for a plain HTTP error carrying no block signature', async () => {
    stubFetch(() => new Response('Internal Server Error', { status: 500 }))

    let humanCalls = 0
    const humanSolve = async () => {
      humanCalls++
      return { ok: false as const, reason: 'must not be called' }
    }

    const result = await runFetchChain(PAGE, {
      ledger: createLedger(),
      hostGate: createHostGate(),
      tavilyExtract: stubTavilyFail(),
      humanSolve,
    })

    expect(humanCalls).toBe(0)
    expect(result.via).not.toBe('human')
  })

  it('flags a 200 managed-challenge interstitial as blocked rather than a readability success', async () => {
    stubFetch(
      () =>
        new Response('<html><head><title>Just a moment...</title></head><body>Verify you are human by completing the action below.</body></html>', {
          status: 200,
          headers: { server: 'cloudflare', 'content-type': 'text/html' },
        }),
    )

    const result = await runFetchChain(PAGE, {
      ledger: createLedger(),
      hostGate: createHostGate(),
      tavilyExtract: stubTavilyFail(),
    })

    const originAttempt = result.attempts.find((a) => a.step === 'readability')
    expect(originAttempt?.ok).toBe(false)
    expect(originAttempt?.blocked).toMatch(/^blocked: cloudflare/)
    expect(result.via).not.toBe('readability')
  })
})

describe('TLS impersonation rung', () => {
  // Separate HOSTS for (a)/(b)/(c), and every one distinct from PAGE above: the learning state
  // (`noteImpersonationWorks` / `prefersImpersonation`) lives in impersonate.ts's own
  // process-wide map, not in the per-test `hostGate` — reusing a host across these tests would
  // leak a learned preference from one test into the next. (d) deliberately reuses (a)'s host,
  // since it exists to prove the learned preference from (a) is what fires.
  const IMPERSONATE_PAGE = 'https://203.0.113.21/page'
  const RATE_LIMITED_PAGE = 'https://203.0.113.22/page'
  const CHALLENGE_PAGE = 'https://203.0.113.23/page'

  it('(a) falls through to impersonation on a markerless 403 and reads the page, clearing the cooldown', async () => {
    stubFetch(() => new Response('Access Denied', { status: 403 })) // no vendor marker — idealo's shape
    let impersonateCalls = 0
    const impersonatedFetch: NonNullable<FetchChainOptions['impersonatedFetch']> = async () => {
      impersonateCalls++
      return new Response(htmlPage(), { status: 200, headers: { 'content-type': 'text/html' } })
    }
    const hostGate = createHostGate()

    const result = await runFetchChain(IMPERSONATE_PAGE, {
      ledger: createLedger(),
      hostGate,
      tavilyExtract: stubTavilyFail(),
      impersonatedFetch,
    })

    expect(impersonateCalls).toBe(1)
    expect(result.via).toBe('impersonate')
    expect(result.text).toContain('real words to read as article content')
    // The impersonated fetch succeeded — the host IS readable to us, so the cooldown the plain
    // 403 set is cleared rather than left standing.
    expect(hostGate.cooldown(hostOf(IMPERSONATE_PAGE))).toBeNull()
  })

  it('(b) never calls the impersonation rung on a 429 — retrying immediately is the wrong fix for a rate limit', async () => {
    stubFetch(() => new Response('Slow down', { status: 429 }))
    let impersonateCalls = 0
    const impersonatedFetch: NonNullable<FetchChainOptions['impersonatedFetch']> = async () => {
      impersonateCalls++
      throw new Error('must not be called')
    }

    const result = await runFetchChain(RATE_LIMITED_PAGE, {
      ledger: createLedger(),
      hostGate: createHostGate(),
      tavilyExtract: stubTavilyFail(),
      impersonatedFetch,
    })

    expect(impersonateCalls).toBe(0)
    expect(result.via).not.toBe('impersonate')
  })

  it('(c) still ends up blocked when the impersonation rung hits the same challenge, and human-solve stays eligible', async () => {
    stubFetch(
      () => new Response('<title>Just a moment...</title>', { status: 403, headers: { 'cf-mitigated': 'challenge', 'content-type': 'text/html' } }),
    )
    let impersonateCalls = 0
    const impersonatedFetch: NonNullable<FetchChainOptions['impersonatedFetch']> = async () => {
      impersonateCalls++
      return new Response('<title>Just a moment...</title>', {
        status: 403,
        headers: { 'cf-mitigated': 'challenge', 'content-type': 'text/html' },
      })
    }
    let humanCalls = 0
    const humanSolve = async () => {
      humanCalls++
      return { ok: false as const, reason: 'stub: not solved' }
    }

    const result = await runFetchChain(CHALLENGE_PAGE, {
      ledger: createLedger(),
      renderBaseUrl: 'https://198.51.100.9', // TEST-NET-2 — never dialled, origin is blocked decisively first
      hostGate: createHostGate(),
      tavilyExtract: stubTavilyFail(),
      impersonatedFetch,
      humanSolve,
    })

    expect(impersonateCalls).toBe(1)
    const impersonateAttempt = result.attempts.find((a) => a.step === 'impersonate')
    expect(impersonateAttempt?.blocked).toMatch(/^blocked: cloudflare/)
    const renderAttempt = result.attempts.find((a) => a.step === 'lightpanda')
    expect(renderAttempt?.error).toBe('skipped: origin challenged')
    expect(humanCalls).toBe(1) // eligible — sawBlock was set
    expect(result.via).toBeNull()
  })

  it('(d) skips the plain fetch entirely on a host already learned in (a), going straight to impersonation', async () => {
    let plainCalls = 0
    stubFetch(() => {
      plainCalls++
      return new Response('Access Denied', { status: 403 })
    })
    let impersonateCalls = 0
    const impersonatedFetch: NonNullable<FetchChainOptions['impersonatedFetch']> = async () => {
      impersonateCalls++
      return new Response(htmlPage(), { status: 200, headers: { 'content-type': 'text/html' } })
    }

    const result = await runFetchChain(IMPERSONATE_PAGE, {
      ledger: createLedger(),
      hostGate: createHostGate(),
      tavilyExtract: stubTavilyFail(),
      impersonatedFetch,
    })

    expect(impersonateCalls).toBe(1)
    expect(plainCalls).toBe(0) // the plain fetch was never dialled — impersonation ran directly
    expect(result.via).toBe('impersonate')
  })

  it('injects an isolated impersonationMemory so learned state does not leak into the default, process-wide one', async () => {
    const ISOLATED_PAGE = 'https://203.0.113.27/page'
    stubFetch(() => new Response('Access Denied', { status: 403 }))
    const impersonatedFetch: NonNullable<FetchChainOptions['impersonatedFetch']> = async () =>
      new Response(htmlPage(), { status: 200, headers: { 'content-type': 'text/html' } })
    const isolatedMemory = createImpersonationMemory()

    await runFetchChain(ISOLATED_PAGE, {
      ledger: createLedger(),
      hostGate: createHostGate(),
      tavilyExtract: stubTavilyFail(),
      impersonatedFetch,
      impersonationMemory: isolatedMemory,
    })

    expect(isolatedMemory.prefers(hostOf(ISOLATED_PAGE))).toBe(true) // learned on the injected instance
    expect(defaultImpersonationMemory.prefers(hostOf(ISOLATED_PAGE))).toBe(false) // never touched the shared default
  })
})

describe('human-solve SSRF guard', () => {
  it('rejects a human-solve result whose finalUrl resolves to a private address, without recording it retrieved', async () => {
    const HUMAN_SSRF_PAGE = 'https://203.0.113.28/page'
    stubFetch(() => new Response('<title>Just a moment...</title>', { status: 403, headers: { 'cf-mitigated': 'challenge', 'content-type': 'text/html' } }))

    const humanSolve = async (req: HumanSolveRequest) => ({
      ok: true as const,
      html: htmlPage(),
      finalUrl: 'http://169.254.169.254/latest/meta-data/', // cloud metadata — never a legitimate final URL
      mode: 'solved' as const,
    })
    const ledger = createLedger()

    const result = await runFetchChain(HUMAN_SSRF_PAGE, {
      ledger,
      hostGate: createHostGate(),
      tavilyExtract: stubTavilyFail(),
      impersonatedFetch: stubImpersonateUnavailable(),
      humanSolve,
    })

    const humanAttempt = result.attempts.find((a) => a.step === 'human')
    expect(humanAttempt?.ok).toBe(false)
    expect(humanAttempt?.error).toBe('unsafe final url')
    expect(humanAttempt?.blocked).toBe('unsafe final url')
    expect(result.via).not.toBe('human')
    expect(ledger.tierOf(HUMAN_SSRF_PAGE)).not.toBe('retrieved')
  })

  it('accepts a human-solve result whose finalUrl is an ordinary public address', async () => {
    const HUMAN_OK_PAGE = 'https://203.0.113.29/page'
    stubFetch(() => new Response('<title>Just a moment...</title>', { status: 403, headers: { 'cf-mitigated': 'challenge', 'content-type': 'text/html' } }))

    const humanSolve = async (req: HumanSolveRequest) => ({
      ok: true as const,
      html: htmlPage(),
      finalUrl: HUMAN_OK_PAGE,
      mode: 'solved' as const,
    })

    const result = await runFetchChain(HUMAN_OK_PAGE, {
      ledger: createLedger(),
      hostGate: createHostGate(),
      tavilyExtract: stubTavilyFail(),
      impersonatedFetch: stubImpersonateUnavailable(),
      humanSolve,
    })

    expect(result.via).toBe('human')
  })
})

describe('human-solve HTTP status', () => {
  it('a settled 404 is recorded missing exactly like the origin step, and the chain stops there (no Wayback)', async () => {
    const HUMAN_404_PAGE = 'https://203.0.113.40/page'
    stubFetch(() => new Response('<title>Just a moment...</title>', { status: 403, headers: { 'cf-mitigated': 'challenge', 'content-type': 'text/html' } }))
    let waybackCalls = 0
    const humanSolve = async (req: HumanSolveRequest) => ({
      ok: true as const,
      html: '<html><body>ERROR 404 Seite nicht gefunden</body></html>',
      finalUrl: HUMAN_404_PAGE,
      mode: 'solved' as const,
      status: 404,
    })
    const ledger = createLedger()

    const result = await runFetchChain(HUMAN_404_PAGE, {
      ledger,
      hostGate: createHostGate(),
      tavilyExtract: stubTavilyFail(),
      impersonatedFetch: stubImpersonateUnavailable(),
      humanSolve,
      onArchive: () => {
        waybackCalls++
      },
    })

    expect(result.via).toBeNull()
    expect(result.error).toContain('HTTP 404')
    expect(ledger.tierOf(HUMAN_404_PAGE)).toBe('missing')
    expect(waybackCalls).toBe(0) // a definitively-missing result never falls through to Wayback
  })

  it('a settled 410 is recorded missing the same way as a 404', async () => {
    const HUMAN_410_PAGE = 'https://203.0.113.41/page'
    stubFetch(() => new Response('<title>Just a moment...</title>', { status: 403, headers: { 'cf-mitigated': 'challenge', 'content-type': 'text/html' } }))
    const humanSolve = async (req: HumanSolveRequest) => ({
      ok: true as const,
      html: '<html><body>Gone</body></html>',
      finalUrl: HUMAN_410_PAGE,
      mode: 'solved' as const,
      status: 410,
    })
    const ledger = createLedger()

    const result = await runFetchChain(HUMAN_410_PAGE, {
      ledger,
      hostGate: createHostGate(),
      tavilyExtract: stubTavilyFail(),
      impersonatedFetch: stubImpersonateUnavailable(),
      humanSolve,
    })

    expect(result.via).toBeNull()
    expect(ledger.tierOf(HUMAN_410_PAGE)).toBe('missing')
  })

  it('a settled 500 is an ordinary failed human attempt, not missing — and still falls through to Wayback', async () => {
    const HUMAN_500_PAGE = 'https://203.0.113.42/page'
    stubFetch(() => new Response('<title>Just a moment...</title>', { status: 403, headers: { 'cf-mitigated': 'challenge', 'content-type': 'text/html' } }))
    const humanSolve = async (req: HumanSolveRequest) => ({
      ok: true as const,
      html: htmlPage(),
      finalUrl: HUMAN_500_PAGE,
      mode: 'solved' as const,
      status: 500,
    })
    const ledger = createLedger()

    const result = await runFetchChain(HUMAN_500_PAGE, {
      ledger,
      hostGate: createHostGate(),
      tavilyExtract: stubTavilyFail(),
      impersonatedFetch: stubImpersonateUnavailable(),
      humanSolve,
    })

    const humanAttempt = result.attempts.find((a) => a.step === 'human')
    expect(humanAttempt?.ok).toBe(false)
    expect(humanAttempt?.error).toBe('HTTP 500')
    expect(result.via).not.toBe('human')
    expect(ledger.tierOf(HUMAN_500_PAGE)).not.toBe('missing')
  })

  it('an unknown status (absent) is treated exactly like today — a good page still succeeds via human', async () => {
    const HUMAN_UNKNOWN_STATUS_PAGE = 'https://203.0.113.43/page'
    stubFetch(() => new Response('<title>Just a moment...</title>', { status: 403, headers: { 'cf-mitigated': 'challenge', 'content-type': 'text/html' } }))
    const humanSolve = async (req: HumanSolveRequest) => ({
      ok: true as const,
      html: htmlPage(),
      finalUrl: HUMAN_UNKNOWN_STATUS_PAGE,
      mode: 'solved' as const,
      // no `status` field at all — Chrome <109 or the navigation entry was never recorded
    })

    const result = await runFetchChain(HUMAN_UNKNOWN_STATUS_PAGE, {
      ledger: createLedger(),
      hostGate: createHostGate(),
      tavilyExtract: stubTavilyFail(),
      impersonatedFetch: stubImpersonateUnavailable(),
      humanSolve,
    })

    expect(result.via).toBe('human')
  })

  it('a 200 status still succeeds via human exactly like an absent status', async () => {
    const HUMAN_200_STATUS_PAGE = 'https://203.0.113.44/page'
    stubFetch(() => new Response('<title>Just a moment...</title>', { status: 403, headers: { 'cf-mitigated': 'challenge', 'content-type': 'text/html' } }))
    const humanSolve = async (req: HumanSolveRequest) => ({
      ok: true as const,
      html: htmlPage(),
      finalUrl: HUMAN_200_STATUS_PAGE,
      mode: 'solved' as const,
      status: 200,
    })

    const result = await runFetchChain(HUMAN_200_STATUS_PAGE, {
      ledger: createLedger(),
      hostGate: createHostGate(),
      tavilyExtract: stubTavilyFail(),
      impersonatedFetch: stubImpersonateUnavailable(),
      humanSolve,
    })

    expect(result.via).toBe('human')
  })
})

describe('marker-less block eligibility', () => {
  it('sets sawBlock (human-eligible) when both the plain and impersonation rungs return a marker-less 403, without a host-wide cooldown', async () => {
    const MARKERLESS_BOTH_PAGE = 'https://203.0.113.30/page'
    stubFetch(() => new Response('Forbidden', { status: 403 })) // no vendor marker
    const impersonatedFetch: NonNullable<FetchChainOptions['impersonatedFetch']> = async () =>
      new Response('Forbidden', { status: 403 }) // also marker-less
    let humanCalls = 0
    const humanSolve = async () => {
      humanCalls++
      return { ok: false as const, reason: 'stub: not solved' }
    }
    const hostGate = createHostGate()

    const result = await runFetchChain(MARKERLESS_BOTH_PAGE, {
      ledger: createLedger(),
      hostGate,
      tavilyExtract: stubTavilyFail(),
      impersonatedFetch,
      humanSolve,
    })

    expect(humanCalls).toBe(1) // sawBlock was set even though neither rung carried a vendor marker
    expect(hostGate.cooldown(hostOf(MARKERLESS_BOTH_PAGE))).toBeNull() // no cooldown from marker-less evidence alone
    expect(result.via).toBeNull()
  })

  it('never makes a marker-less 401 on the plain request human-eligible, even when impersonation also fails', async () => {
    const MARKERLESS_401_PAGE = 'https://203.0.113.31/page'
    stubFetch(() => new Response('Unauthorized', { status: 401 }))
    const impersonatedFetch: NonNullable<FetchChainOptions['impersonatedFetch']> = async () => new Response('Unauthorized', { status: 401 })
    let humanCalls = 0
    const humanSolve = async () => {
      humanCalls++
      return { ok: false as const, reason: 'must not be called' }
    }

    const result = await runFetchChain(MARKERLESS_401_PAGE, {
      ledger: createLedger(),
      hostGate: createHostGate(),
      tavilyExtract: stubTavilyFail(),
      impersonatedFetch,
      humanSolve,
    })

    expect(humanCalls).toBe(0) // an auth wall a captcha-solve can't fix — never human-eligible
    expect(result.via).not.toBe('human')
  })

  it('a 429 with no vendor fingerprint sets a cooldown but never becomes human-eligible', async () => {
    const RATE_LIMITED_NO_HUMAN_PAGE = 'https://203.0.113.32/page'
    stubFetch(() => new Response('Slow down', { status: 429 }))
    let humanCalls = 0
    const humanSolve = async () => {
      humanCalls++
      return { ok: false as const, reason: 'must not be called' }
    }
    const hostGate = createHostGate()

    const result = await runFetchChain(RATE_LIMITED_NO_HUMAN_PAGE, {
      ledger: createLedger(),
      hostGate,
      tavilyExtract: stubTavilyFail(),
      humanSolve,
    })

    expect(humanCalls).toBe(0) // a rate limit needs waiting, not a human
    expect(hostGate.cooldown(hostOf(RATE_LIMITED_NO_HUMAN_PAGE))).not.toBeNull() // still sets a cooldown
    expect(result.via).not.toBe('human')
  })
})

describe('origin-skip: cooldown kind decides sawBlock, and the skipped label is derived', () => {
  it('a rate-limit-kind cooldown skips the origin without making the chain human-eligible', async () => {
    stubFetch(() => new Response('Not Found', { status: 404 })) // any wayback rescue fails fast, never a real network call
    const RATE_SKIP_PAGE = 'https://203.0.113.36/page'
    const host = hostOf(RATE_SKIP_PAGE)
    const hostGate = createHostGate()
    hostGate.noteBlocked(host, { reason: 'rate limited (HTTP 429, no vendor signature)', kind: 'rate-limit' })
    let humanCalls = 0
    const humanSolve = async () => {
      humanCalls++
      return { ok: false as const, reason: 'must not be called' }
    }

    const result = await runFetchChain(RATE_SKIP_PAGE, {
      ledger: createLedger(),
      hostGate,
      tavilyExtract: stubTavilyFail(),
      impersonatedFetch: stubImpersonateUnavailable(),
      humanSolve,
    })

    const originAttempt = result.attempts.find((a) => a.step === 'readability')
    expect(originAttempt?.error).toMatch(/^skipped: cooldown/)
    expect(humanCalls).toBe(0) // a rate-limit cooldown alone is not evidence a human would help
    expect(result.via).not.toBe('human')
  })

  it('a challenge-kind cooldown skips the origin and DOES make the chain human-eligible', async () => {
    stubFetch(() => new Response('Not Found', { status: 404 })) // wayback (reached after the failed human-solve stub) fails fast
    const CHALLENGE_SKIP_PAGE = 'https://203.0.113.37/page'
    const host = hostOf(CHALLENGE_SKIP_PAGE)
    const hostGate = createHostGate()
    hostGate.noteBlocked(host, { reason: 'blocked: cloudflare challenge (HTTP 403)', kind: 'challenge' })
    let humanCalls = 0
    const humanSolve = async () => {
      humanCalls++
      return { ok: false as const, reason: 'stub: not solved' }
    }

    const result = await runFetchChain(CHALLENGE_SKIP_PAGE, {
      ledger: createLedger(),
      hostGate,
      tavilyExtract: stubTavilyFail(),
      impersonatedFetch: stubImpersonateUnavailable(),
      humanSolve,
    })

    const originAttempt = result.attempts.find((a) => a.step === 'readability')
    expect(originAttempt?.error).toMatch(/^skipped: cooldown/)
    expect(humanCalls).toBe(1) // a challenge cooldown IS evidence a human-driven browser might succeed
  })

  it('derives the skipped-origin attempt label from the learned rung (impersonate), not hardcoded readability', async () => {
    stubFetch(() => new Response('Not Found', { status: 404 })) // wayback fails fast — no humanSolve wired, so it's the next stop
    const DERIVE_PAGE = 'https://203.0.113.38/page'
    const host = hostOf(DERIVE_PAGE)
    const hostGate = createHostGate()
    hostGate.noteBlocked(host, { reason: 'blocked: cloudflare challenge (HTTP 403)', kind: 'challenge' })
    const impersonationMemory = createImpersonationMemory()
    impersonationMemory.noteWorks(host)

    const result = await runFetchChain(DERIVE_PAGE, {
      ledger: createLedger(),
      hostGate,
      tavilyExtract: stubTavilyFail(),
      impersonationMemory,
    })

    const skippedAttempt = result.attempts.find((a) => a.error?.startsWith('skipped:'))
    expect(skippedAttempt?.step).toBe('impersonate')
    expect(result.attempts.some((a) => a.step === 'readability')).toBe(false)
  })
})

describe('cancellation vs budget exhaustion', () => {
  it('fails fast with "cancelled" and skips human/wayback when the caller signal aborted, even though the budget is also spent', async () => {
    const CANCELLED_PAGE = 'https://203.0.113.33/page'
    stubFetch(() => new Response('Internal Server Error', { status: 500 })) // no block signal — falls through toward Tavily
    const controller = new AbortController()
    controller.abort(new Error('job cancelled'))

    let humanCalls = 0
    const humanSolve = async () => {
      humanCalls++
      return { ok: false as const, reason: 'must not be called' }
    }

    const result = await runFetchChain(CANCELLED_PAGE, {
      ledger: createLedger(),
      hostGate: createHostGate(),
      signal: controller.signal,
      budgetMs: 100,
      humanSolve,
      tavilyExtract: stubTavilyFail(),
    })

    expect(result.error).toBe('cancelled')
    expect(result.via).toBeNull()
    expect(humanCalls).toBe(0)
  })
})
