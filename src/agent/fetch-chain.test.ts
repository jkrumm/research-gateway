import { describe, it, expect, afterEach } from 'bun:test'

// Same boot convention as otel-spans.test.ts: fetch-chain.ts imports env.ts, which parses
// process.env at import time and throws without secrets — so the module graph is pulled in
// with a dynamic import AFTER these are set, rather than by a hoisted static import.
// `??=` so a real environment is never clobbered.
process.env['API_SECRET'] ??= 'test-secret'
process.env['IU_BASE_URL'] ??= 'https://example.invalid/v1'
process.env['IU_API_KEY'] ??= 'test-key'
process.env['TAVILY_API_KEY'] ??= 'test-key'

const { runFetchChain } = await import('./fetch-chain.js')
const { createLedger } = await import('./ledger.js')
const { _test: parseTest } = await import('./html-parse.js')

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
