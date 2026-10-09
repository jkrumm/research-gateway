import { describe, it, expect, afterEach, setDefaultTimeout } from 'bun:test'
import { createHostGate } from './host-gate.js'
import type { HumanSolveRequest, FetchChainOptions } from './fetch-chain.js'

// Chain tests walk the real host-gate intervals (3-5s each on a loaded runner); the 5s default
// flaked the CI check on 2026-10-09 and the deploy poller refuses a red SHA.
setDefaultTimeout(30_000)

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
// The SSRF guard's own injectable seam (net.ts's `assertPublicUrl` parameter, threaded through
// `ctx.assertPublicUrl`) — production never sets this. A test that must exercise a REAL
// hostname (`resolveSite` is keyed on the actual host, so a site-adapter fixture can't use a
// TEST-NET literal) injects this no-op instead, so the SSRF check's `node:dns` lookup never
// runs and the suite stays offline/deterministic.
function stubAssertPublicUrlOk(): NonNullable<FetchChainOptions['assertPublicUrl']> {
  return async () => {}
}

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

  it('records via "browser" rather than "human" when the solver cleared the page with no human ever prompted', async () => {
    stubFetch(() => new Response('Access denied', { status: 403, headers: { 'cf-mitigated': 'challenge', 'content-type': 'text/html' } }))

    let humanCalls = 0
    const humanSolve = async (req: HumanSolveRequest) => {
      humanCalls++
      return { ok: true as const, html: htmlPage(), finalUrl: PAGE, mode: 'browser' as const }
    }

    const result = await runFetchChain(PAGE, {
      ledger: createLedger(),
      hostGate: createHostGate(),
      tavilyExtract: stubTavilyFail(),
      impersonatedFetch: stubImpersonateUnavailable(),
      humanSolve,
    })

    expect(humanCalls).toBe(1)
    expect(result.via).toBe('browser')
    expect(result.text).toContain('real words to read as article content')
    const browserAttempt = result.attempts.find((a) => a.step === 'browser')
    expect(browserAttempt?.ok).toBe(true)
    expect(result.attempts.some((a) => a.step === 'human')).toBe(false)
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

  it('(e) the LAST origin verdict decides render skipping: a decisive plain block then a corroborating-only impersonated one is not "origin challenged"', async () => {
    stubFetch(
      () => new Response('<title>Just a moment...</title>', { status: 403, headers: { 'cf-mitigated': 'challenge', 'content-type': 'text/html' } }),
    )
    // Corroborating only: a 403 naming the vendor, no decisive header or body marker.
    const impersonatedFetch: NonNullable<FetchChainOptions['impersonatedFetch']> = async () =>
      new Response('<p>Sorry, you have been blocked. cloudflare</p>', { status: 403, headers: { 'content-type': 'text/html' } })

    const result = await runFetchChain('https://203.0.113.24/page', {
      ledger: createLedger(),
      renderBaseUrl: 'https://198.51.100.9',
      hostGate: createHostGate(),
      tavilyExtract: stubTavilyFail(),
      impersonatedFetch,
    })

    const impersonateAttempt = result.attempts.find((a) => a.step === 'impersonate')
    expect(impersonateAttempt?.blocked).toBeDefined()
    const renderAttempt = result.attempts.find((a) => a.step === 'lightpanda')
    // Still skipped — the plain block put the host in cooldown — but for THAT reason, not a
    // stale decisive flag from the first attempt.
    expect(renderAttempt?.error).toMatch(/^skipped: cooldown/)
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

describe('bounded body reads', () => {
  const enc = new TextEncoder()

  // A stream that serves `first` then endless `chunkSize`-byte filler chunks, stopping when the
  // reader cancels. A cap test must not pre-build the whole over-cap body — that would allocate
  // the very memory under test — so the stream generates it lazily.
  function hugeStream(first: Uint8Array, chunkSize: number): ReadableStream<Uint8Array> {
    const filler = new Uint8Array(chunkSize).fill(0x20)
    let sent = 0
    return new ReadableStream({
      start(controller) {
        controller.enqueue(first)
      },
      pull(controller) {
        sent += 1
        if (sent > 200) {
          controller.close()
          return
        }
        controller.enqueue(filler)
      },
    })
  }

  function ofChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    })
  }

  it('misses a non-PDF body larger than 8 MB with an oversized reason', async () => {
    stubFetch((u) =>
      u === PAGE ? new Response(hugeStream(enc.encode('<html><body><p>'), 1024 * 1024), { headers: { 'content-type': 'text/html' } }) : new Response('nope', { status: 404 }),
    )

    const result = await runFetchChain(PAGE, {
      ledger: createLedger(),
      hostGate: createHostGate(),
      tavilyExtract: stubTavilyFail(),
      impersonatedFetch: stubImpersonateUnavailable(),
    })

    expect(result.via).toBeNull()
    const originAttempt = result.attempts.find((a) => a.step === 'readability')
    expect(originAttempt?.error).toMatch(/body exceeds 8388608 byte cap/)
  })

  it('reads an 8-40 MB PDF served as application/octet-stream under the 40 MB cap, by its %PDF- magic', async () => {
    // 9 MB of body — over MAX_BODY_BYTES, under MAX_PDF_BYTES — announced only by the magic.
    const chunks = [enc.encode('%PDF-1.7\n'), ...Array.from({ length: 9 }, () => new Uint8Array(1024 * 1024).fill(0x20))]
    stubFetch((u) =>
      u === PAGE ? new Response(ofChunks(chunks), { headers: { 'content-type': 'application/octet-stream' } }) : new Response('nope', { status: 404 }),
    )

    const result = await runFetchChain(PAGE, {
      ledger: createLedger(),
      hostGate: createHostGate(),
      tavilyExtract: stubTavilyFail(),
      impersonatedFetch: stubImpersonateUnavailable(),
    })

    // Reached the PDF branch (pdftotext was handed the bytes) rather than being cut at 8 MB and
    // treated as a miss.
    expect(result.attempts.some((a) => a.error?.includes('byte cap'))).toBe(false)
    expect(result.attempts.some((a) => a.step === 'pdf')).toBe(true)
  })

  it('reads a mislabeled 9 MB PDF delivered one byte per chunk for the first 16 bytes without being cut at the 8 MB cap', async () => {
    // The bug this closes: the cap used to be decided from the FIRST chunk only, so a body
    // delivered one byte at a time never showed the `%PDF-` magic to the chooser in time and
    // got locked to the 8 MB non-PDF cap forever. Sixteen one-byte chunks (well past the magic's
    // 5 bytes and the reader's 8-byte decision prefix), then the rest of a 9 MB body as normal
    // chunks — served under a Content-Type that carries no PDF information of its own.
    const magic = Array.from(enc.encode('%PDF-1.7\n'))
    const oneBytePrefix = magic.concat(Array.from({ length: 16 - magic.length }, () => 0x20)).map((byte) => new Uint8Array([byte]))
    const rest = Array.from({ length: 9 }, () => new Uint8Array(1024 * 1024).fill(0x20))
    stubFetch((u) =>
      u === PAGE ? new Response(ofChunks([...oneBytePrefix, ...rest]), { headers: { 'content-type': 'application/octet-stream' } }) : new Response('nope', { status: 404 }),
    )

    const result = await runFetchChain(PAGE, {
      ledger: createLedger(),
      hostGate: createHostGate(),
      tavilyExtract: stubTavilyFail(),
      impersonatedFetch: stubImpersonateUnavailable(),
    })

    expect(result.attempts.some((a) => a.error?.includes('byte cap'))).toBe(false)
    expect(result.attempts.some((a) => a.step === 'pdf')).toBe(true)
  })

  it('misses a PDF larger than 40 MB', async () => {
    stubFetch((u) =>
      u === PAGE ? new Response(hugeStream(enc.encode('%PDF-1.7\n'), 1024 * 1024), { headers: { 'content-type': 'application/pdf' } }) : new Response('nope', { status: 404 }),
    )

    const result = await runFetchChain(PAGE, {
      ledger: createLedger(),
      hostGate: createHostGate(),
      tavilyExtract: stubTavilyFail(),
      impersonatedFetch: stubImpersonateUnavailable(),
    })

    expect(result.via).toBeNull()
    const originAttempt = result.attempts.find((a) => a.step === 'readability')
    expect(originAttempt?.error).toMatch(/body exceeds 41943040 byte cap/)
  })

  it('fails the render step on an oversized lightpanda response instead of parsing it', async () => {
    const RENDER = 'https://198.51.100.9'
    stubFetch((u) =>
      u.startsWith(RENDER) ? new Response(hugeStream(enc.encode('{"ok":true,"text":"'), 1024 * 1024), { status: 200 }) : new Response('server error', { status: 500 }),
    )

    const result = await runFetchChain(PAGE, {
      ledger: createLedger(),
      renderBaseUrl: RENDER,
      hostGate: createHostGate(),
      tavilyExtract: stubTavilyFail(),
      impersonatedFetch: stubImpersonateUnavailable(),
    })

    const renderAttempt = result.attempts.find((a) => a.step === 'lightpanda')
    expect(renderAttempt?.error).toMatch(/render response exceeds 8388608 byte cap/)
    expect(result.via).toBeNull()
  })

  it('misses an oversized wayback rescue body', async () => {
    stubFetch((u) =>
      u === PAGE ? new Response('server error', { status: 500 }) : new Response(hugeStream(enc.encode('<html><body><p>'), 1024 * 1024), { headers: { 'content-type': 'text/html' } }),
    )

    const result = await runFetchChain(PAGE, {
      ledger: createLedger(),
      hostGate: createHostGate(),
      tavilyExtract: stubTavilyFail(),
      impersonatedFetch: stubImpersonateUnavailable(),
    })

    const waybackAttempt = result.attempts.find((a) => a.step === 'wayback')
    expect(waybackAttempt?.error).toMatch(/body exceeds 8388608 byte cap/)
    expect(result.via).toBeNull()
  })
})

// Runs the real pdftotext binary end to end through the fetch chain's PDF branch — the one
// place `pdf.ts`'s process-wide semaphore (pdf-semaphore.ts) and idle watchdog (replacing the
// old flat 60s kill) actually run, since pdf.ts itself stays untested-by-design like ytdlp.ts
// (both import env.ts for their binary path — see AGENTS.md's Local dev section). The pure
// mapping (`mapPdftotextResult`, `truncated`, `pdfTruncationNotice`) is unit-tested directly in
// pdf-extract.test.ts; this covers the real subprocess wiring around it.
// These run the real poppler binary. The mini has it; a CI runner without poppler skips them
// visibly rather than failing — the chain's PDF logic is still covered by the stubbed tests above.
const PDFTOTEXT_AVAILABLE = Bun.which(process.env['PDFTOTEXT_PATH'] ?? 'pdftotext') !== null

describe.skipIf(!PDFTOTEXT_AVAILABLE)('real pdftotext extraction (fixtures)', () => {
  const FIXTURES = `${import.meta.dir}/__fixtures__`
  const readFixture = (name: string) => Bun.file(`${FIXTURES}/${name}`).arrayBuffer().then((b) => new Uint8Array(b))

  it('extracts real text from a PDF that clears the MIN_PDF_TEXT_CHARS floor', async () => {
    const bytes = await readFixture('paper.pdf')
    stubFetch((u) => (u === PAGE ? new Response(bytes, { headers: { 'content-type': 'application/pdf' } }) : new Response('nope', { status: 404 })))

    const result = await runFetchChain(PAGE, {
      ledger: createLedger(),
      hostGate: createHostGate(),
      tavilyExtract: stubTavilyFail(),
      impersonatedFetch: stubImpersonateUnavailable(),
    })

    expect(result.via).toBe('pdf')
    expect(result.text).toContain('fixture paper about wind speed')
  })

  it('falls through a near-empty (scanned-looking) PDF as a miss, not a success', async () => {
    const bytes = await readFixture('thin.pdf')
    stubFetch((u) => (u === PAGE ? new Response(bytes, { headers: { 'content-type': 'application/pdf' } }) : new Response('nope', { status: 404 })))

    const result = await runFetchChain(PAGE, {
      ledger: createLedger(),
      hostGate: createHostGate(),
      tavilyExtract: stubTavilyFail(),
      impersonatedFetch: stubImpersonateUnavailable(),
    })

    const pdfAttempt = result.attempts.find((a) => a.step === 'pdf')
    expect(pdfAttempt?.ok).toBe(false)
    expect(pdfAttempt?.error).toMatch(/thin|scanned/)
  })

  it('falls through a clean but short PDF (exit 0, under the floor) as a miss, not a success', async () => {
    const bytes = await readFixture('valid.pdf')
    stubFetch((u) => (u === PAGE ? new Response(bytes, { headers: { 'content-type': 'application/pdf' } }) : new Response('nope', { status: 404 })))

    const result = await runFetchChain(PAGE, {
      ledger: createLedger(),
      hostGate: createHostGate(),
      tavilyExtract: stubTavilyFail(),
      impersonatedFetch: stubImpersonateUnavailable(),
    })

    const pdfAttempt = result.attempts.find((a) => a.step === 'pdf')
    expect(pdfAttempt?.ok).toBe(false)
    expect(pdfAttempt?.error).toMatch(/thin|scanned/)
    expect(result.via).toBeNull()
  })

  it('falls through a corrupt PDF exactly like any other pdftotext failure', async () => {
    const bytes = await readFixture('truncated.pdf')
    stubFetch((u) => (u === PAGE ? new Response(bytes, { headers: { 'content-type': 'application/pdf' } }) : new Response('nope', { status: 404 })))

    const result = await runFetchChain(PAGE, {
      ledger: createLedger(),
      hostGate: createHostGate(),
      tavilyExtract: stubTavilyFail(),
      impersonatedFetch: stubImpersonateUnavailable(),
    })

    const pdfAttempt = result.attempts.find((a) => a.step === 'pdf')
    expect(pdfAttempt?.ok).toBe(false)
    expect(result.via).toBeNull()
  })
})

// ── arXiv HTML→PDF fallback (origin.ts consuming site.fallbackUrl) ────────────────────────
// The real `arxiv.org` hostname is used deliberately, not a TEST-NET literal: `resolveSite`
// is keyed on the actual hostname, and only a genuine arXiv URL exercises `arxivAdapter.plan`'s
// real `fallbackUrl` — the thing this fallback-wiring is actually about. That hostname would
// otherwise cost a real `node:dns` lookup per origin/wayback hop (`assertPublicHttpUrl`) — every
// test below injects `stubAssertPublicUrlOk()` instead, so the suite stays offline/deterministic
// even though it is exercising a real hostname; the page fetch itself stays stubbed via
// `stubFetch` like every other test here.
describe('arXiv HTML→PDF fallback (origin.ts consuming site.fallbackUrl)', () => {
  const CITED_URL = 'https://arxiv.org/abs/2309.04452'
  const HTML_URL = 'https://arxiv.org/html/2309.04452'
  const PDF_URL = 'https://arxiv.org/pdf/2309.04452'
  const FIXTURES = `${import.meta.dir}/__fixtures__`
  const readFixture = (name: string) => Bun.file(`${FIXTURES}/${name}`).arrayBuffer().then((b) => new Uint8Array(b))

  it.skipIf(!PDFTOTEXT_AVAILABLE)('falls back to the PDF fixture when the HTML build 404s, without a false missing record', async () => {
    const pdfBytes = await readFixture('paper.pdf')
    const requested: string[] = []
    stubFetch((u) => {
      requested.push(u)
      if (u === HTML_URL) return new Response('not found', { status: 404 })
      if (u === PDF_URL) return new Response(pdfBytes, { status: 200, headers: { 'content-type': 'application/pdf' } })
      return new Response('nope', { status: 404 })
    })
    const ledger = createLedger()

    const result = await runFetchChain(CITED_URL, {
      ledger,
      hostGate: createHostGate(),
      tavilyExtract: stubTavilyFail(),
      impersonatedFetch: stubImpersonateUnavailable(),
      assertPublicUrl: stubAssertPublicUrlOk(),
    })

    expect(result.via).toBe('pdf')
    expect(result.text).toContain('fixture paper about wind speed')
    expect(requested).toContain(HTML_URL)
    expect(requested).toContain(PDF_URL)
    // The cited /abs/ url and the PDF address that genuinely answered are both retrieved —
    // the html address that 404'd is NOT, and the ledger never records a missing entry at all.
    expect(ledger.tierOf(CITED_URL)).toBe('retrieved')
    expect(ledger.tierOf(PDF_URL)).toBe('retrieved')
    expect(ledger.tierOf(HTML_URL)).not.toBe('retrieved')
    expect(ledger.tierOf(CITED_URL)).not.toBe('missing')
    expect(ledger.tierOf(HTML_URL)).not.toBe('missing')
  })

  it('records missing against the fallback url when both addresses 404, and the chain fails', async () => {
    stubFetch(() => new Response('not found', { status: 404 }))
    const ledger = createLedger()

    const result = await runFetchChain(CITED_URL, {
      ledger,
      hostGate: createHostGate(),
      tavilyExtract: stubTavilyFail(),
      impersonatedFetch: stubImpersonateUnavailable(),
      assertPublicUrl: stubAssertPublicUrlOk(),
    })

    expect(result.via).toBeNull()
    expect(result.text).toBeNull()
    expect(ledger.tierOf(PDF_URL)).toBe('missing')
    expect(ledger.tierOf(CITED_URL)).not.toBe('retrieved')
  })

  it('never requests the fallback when the HTML build answers 200', async () => {
    const requested: string[] = []
    stubFetch((u) => {
      requested.push(u)
      return new Response(htmlPage(), { status: 200, headers: { 'content-type': 'text/html' } })
    })

    const result = await runFetchChain(CITED_URL, {
      ledger: createLedger(),
      hostGate: createHostGate(),
      tavilyExtract: stubTavilyFail(),
      impersonatedFetch: stubImpersonateUnavailable(),
      assertPublicUrl: stubAssertPublicUrlOk(),
    })

    expect(result.via).toBe('readability')
    expect(requested).toContain(HTML_URL)
    expect(requested).not.toContain(PDF_URL)
  })

  // The bug this closes: the fallback dial (PDF_URL) does NOT terminate the chain on its own
  // (a 500, not a 2xx) here — so without `ctx.dialUrl`, render and Tavily would keep dialling
  // HTML_URL, the address that already answered 404, instead of following the chain onto the
  // fallback it just committed to.
  it('keeps dialling the pdf fallback address on render and Tavily once the html build 404s and the fallback itself does not terminate the chain', async () => {
    const RENDER = 'https://198.51.100.9'
    let renderRequestBody: unknown = null
    const tavilyCalls: string[][] = []

    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const u = String(input)
      if (u === HTML_URL) return new Response('not found', { status: 404 })
      if (u === PDF_URL) return new Response('server error', { status: 500 })
      if (u.startsWith(RENDER)) {
        renderRequestBody = init?.body ? JSON.parse(String(init.body)) : null
        return new Response('sidecar down', { status: 500 })
      }
      return new Response('nope', { status: 404 })
    }) as typeof fetch

    const tavilyExtract: NonNullable<FetchChainOptions['tavilyExtract']> = async (urls) => {
      tavilyCalls.push(urls)
      return { results: [], failedResults: urls.map((u) => ({ url: u, error: 'stub' })), responseTime: 0, requestId: 'test' }
    }

    const result = await runFetchChain(CITED_URL, {
      ledger: createLedger(),
      hostGate: createHostGate(),
      renderBaseUrl: RENDER,
      tavilyExtract,
      impersonatedFetch: stubImpersonateUnavailable(),
      assertPublicUrl: stubAssertPublicUrlOk(),
    })

    expect(result.via).toBeNull()
    expect(renderRequestBody).toEqual({ url: PDF_URL })
    expect(tavilyCalls[0]).toEqual([PDF_URL])
  })

  // The wayback rescue dials `waybackLookupUrl(ctx.dialUrl)`, and `ctx.dialUrl` is the PDF
  // fallback by the time this stage runs (the html build already 404d) — a DIFFERENT address
  // than the one the top-of-chain `assertPublicHttpUrl(fetchUrl)` pre-flight validated. Proves
  // that address is still re-checked: `safeFetch`'s own per-hop `assertPublicUrl` call covers
  // its start URL, not only redirect targets (net.ts), so the wayback lookup built from the
  // fallback is never dialled unchecked.
  it('re-validates the pdf fallback address through assertPublicUrl before dialling the wayback rescue', async () => {
    const RENDER = 'https://198.51.100.9'
    const checkedUrls: string[] = []
    const assertPublicUrl: NonNullable<FetchChainOptions['assertPublicUrl']> = async (u) => {
      checkedUrls.push(u)
    }

    globalThis.fetch = (async (input: unknown) => {
      const u = String(input)
      if (u === HTML_URL) return new Response('not found', { status: 404 })
      if (u === PDF_URL) return new Response('server error', { status: 500 })
      if (u.startsWith(RENDER)) return new Response('sidecar down', { status: 500 })
      // Everything else — including the wayback lookup — is a genuine miss; only whether
      // `assertPublicUrl` saw the address before it was dialled is under test here.
      return new Response('nope', { status: 404 })
    }) as typeof fetch

    const tavilyExtract: NonNullable<FetchChainOptions['tavilyExtract']> = async (urls) => ({
      results: [],
      failedResults: urls.map((u) => ({ url: u, error: 'stub' })),
      responseTime: 0,
      requestId: 'test',
    })

    const result = await runFetchChain(CITED_URL, {
      ledger: createLedger(),
      hostGate: createHostGate(),
      renderBaseUrl: RENDER,
      tavilyExtract,
      impersonatedFetch: stubImpersonateUnavailable(),
      assertPublicUrl,
    })

    expect(result.via).toBeNull()
    expect(checkedUrls).toContain(`https://web.archive.org/web/9999/${PDF_URL}`)
  })

  // The bug this closes: `runOrigin`'s `dialledUrl` parameter used to default to `ctx.fetchUrl`
  // (the ORIGINAL planned address), and `runOriginStage`'s impersonation-rung calls omit that
  // argument entirely — so once the html build 404'd and the chain fell through to the PDF
  // fallback, a markerless block on the fallback still sent the impersonation rung back to
  // re-dial the html address that already 404'd, never the pdf address that was actually
  // blocked. Defaulting to `ctx.dialUrl` (which `useFallbackUrl()` already switched by the time
  // the impersonation rung runs) fixes it.
  it('sends the impersonation rung to the pdf fallback address, not the html address that already 404d', async () => {
    const requested: string[] = []
    stubFetch((u) => {
      requested.push(u)
      if (u === HTML_URL) return new Response('not found', { status: 404 })
      // A markerless 403 on the fallback — no vendor fingerprint, same shape idealo's does —
      // unlocks the impersonation rung.
      return new Response('Access Denied', { status: 403 })
    })
    const impersonateRequested: string[] = []
    const impersonatedFetch: NonNullable<FetchChainOptions['impersonatedFetch']> = async (u) => {
      impersonateRequested.push(u)
      return new Response('Access Denied', { status: 403 })
    }

    const result = await runFetchChain(CITED_URL, {
      ledger: createLedger(),
      hostGate: createHostGate(),
      tavilyExtract: stubTavilyFail(),
      impersonatedFetch,
      assertPublicUrl: stubAssertPublicUrlOk(),
    })

    expect(result.via).toBeNull()
    expect(requested).toContain(HTML_URL)
    expect(requested).toContain(PDF_URL)
    expect(impersonateRequested).toEqual([PDF_URL])
    expect(impersonateRequested).not.toContain(HTML_URL)
  })
})

describe('fetchPage line filter (origin raw branch)', () => {
  const CSV_URL = 'https://203.0.113.21/population.csv'
  // Germany sits far past the 80k-char TEXT_CAP, the live failure this filter exists for.
  function bigCsv(): string {
    const rows = ['country,year,population']
    for (const c of ['Afghanistan', 'Brazil', 'Canada', 'Denmark', 'Germany', 'Japan'])
      for (let y = 1800; y < 2025; y++) for (let i = 0; i < 6; i++) rows.push(`${c},${y},${1_000_000 + y * 7 + i}`)
    return rows.join('\n')
  }
  const serve = (type: string) => stubFetch(() => new Response(bigCsv(), { status: 200, headers: { 'content-type': type } }))
  const opts = () => ({
    ledger: createLedger(),
    hostGate: createHostGate(),
    tavilyExtract: stubTavilyFail(),
    impersonatedFetch: stubImpersonateUnavailable(),
    impersonationMemory: createImpersonationMemory(),
    assertPublicUrl: stubAssertPublicUrlOk(),
  })

  it('without the filter a body past TEXT_CAP is cut before Germany', async () => {
    serve('text/csv')
    const r = await runFetchChain(CSV_URL, opts())
    expect(r.via).toBe('raw')
    expect(r.text).toContain('[truncated:')
    expect(r.text).not.toContain('Germany,')
  })

  it('the filter sees the whole body and returns the header plus the matching rows', async () => {
    serve('text/csv; charset=utf-8')
    const r = await runFetchChain(CSV_URL, { ...opts(), lineFilter: ['germany'] })
    expect(r.via).toBe('raw')
    expect(r.text?.startsWith('country,year,population\nGermany,1800,')).toBe(true)
    expect(r.text).toContain('Germany,2024,')
    expect(r.text).not.toContain('Brazil,')
    expect(r.text).not.toContain('[truncated:')
    expect((r.text ?? '').length).toBeLessThanOrEqual(80_000)
  })

  it('applies the paragraph filter, not the row filter, to a long non-line-oriented body', async () => {
    const ledger = createLedger()
    serve('application/json')
    const r = await runFetchChain(CSV_URL, { ...opts(), ledger, lineFilter: ['germany'] })
    expect(r.via).toBe('raw')
    expect(r.text).toContain('[paragraph filter "germany"')
    expect(r.text).not.toContain('[line filter')
    expect((r.text ?? '').length).toBeLessThanOrEqual(80_000)
    expect(ledger.tierOf(CSV_URL)).toBe('retrieved')
  })
})

// A body larger than the buffered 8 MB cap (the OWID CO2 file is ~19 MB), served as a stream that
// is never held whole by the test either.
describe('fetchPage oversized line-oriented file', () => {
  const URL = 'https://203.0.113.22/owid-co2-data.csv'
  const ROWS = 150_000 // ~13 MB at ~90 bytes
  function oversizedCsv(): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()
    let i = -1
    return new ReadableStream({
      pull(controller) {
        const lines: string[] = []
        for (let n = 0; n < 1_000 && i < ROWS; n++, i++) {
          lines.push(i < 0 ? 'country,year,co2' : `${i % 150 === 3 ? 'Germany' : 'Elsewhere'},${1750 + (i % 270)},${'1'.repeat(70)}`)
        }
        if (lines.length === 0) return controller.close()
        controller.enqueue(encoder.encode(`${lines.join('\n')}\n`))
      },
    })
  }
  function setup(headers: Record<string, string> = { 'content-type': 'text/csv' }): { tavilyCalls: string[][]; fetched: string[]; opts: FetchChainOptions } {
    const tavilyCalls: string[][] = []
    const fetched: string[] = []
    stubFetch((u) => {
      fetched.push(u)
      return new Response(oversizedCsv(), { status: 200, headers })
    })
    const tavily = stubTavilyFail()
    return {
      tavilyCalls,
      fetched,
      opts: {
        ledger: createLedger(),
        hostGate: createHostGate(),
        tavilyExtract: (urls, o) => {
          tavilyCalls.push(urls)
          return tavily(urls, o)
        },
        impersonatedFetch: stubImpersonateUnavailable(),
        impersonationMemory: createImpersonationMemory(),
        assertPublicUrl: stubAssertPublicUrlOk(),
      },
    }
  }

  it('with `lines` streams past the 8 MB cap and returns the header plus matching rows', async () => {
    const { opts, tavilyCalls, fetched } = setup()
    const r = await runFetchChain(URL, { ...opts, lineFilter: ['germany'] })
    expect(r.via).toBe('raw')
    expect(r.text?.startsWith('country,year,co2\nGermany,')).toBe(true)
    expect(r.text).toContain('[line filter "germany"')
    expect(r.text).not.toContain('Elsewhere,')
    expect((r.text ?? '').length).toBeLessThanOrEqual(80_000)
    expect(opts.ledger?.tierOf(URL)).toBe('retrieved')
    expect(tavilyCalls).toEqual([])
    expect(fetched).toEqual([URL]) // no render, no wayback
  })

  it('streams a file served with no Content-Type when the URL says .csv', async () => {
    const { opts, fetched } = setup({})
    const r = await runFetchChain(URL, { ...opts, lineFilter: ['germany'] })
    expect(r.via).toBe('raw')
    expect(r.text).toContain('[line filter "germany"')
    expect(fetched).toEqual([URL])
  })

  it('without `lines` returns the header plus a prefix and a note naming `lines`, not a failure', async () => {
    const { opts, tavilyCalls, fetched } = setup()
    const r = await runFetchChain(URL, opts)
    expect(r.via).toBe('raw')
    expect(r.error).toBeNull()
    expect(r.text?.startsWith('country,year,co2\n')).toBe(true)
    expect(r.text).toContain('`lines`')
    expect(r.text).toContain('larger than 8 MB')
    expect(r.text?.length).toBeLessThanOrEqual(80_000 + 200)
    expect(opts.ledger?.tierOf(URL)).toBe('retrieved')
    expect(tavilyCalls).toEqual([])
    expect(fetched).toEqual([URL])
  })
})
