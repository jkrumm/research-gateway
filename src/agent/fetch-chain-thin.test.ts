import { describe, it, expect, afterEach, setDefaultTimeout } from 'bun:test'
import { createHostGate } from './host-gate.js'
import type { FetchChainOptions } from './fetch-chain.js'

// Same boot and timeout convention as fetch-chain.test.ts — env.ts parses process.env at import.
setDefaultTimeout(30_000)
process.env['API_SECRET'] ??= 'test-secret'
process.env['IU_BASE_URL'] ??= 'https://example.invalid/v1'
process.env['IU_API_KEY'] ??= 'test-key'
process.env['TAVILY_API_KEY'] ??= 'test-key'

const { runFetchChain } = await import('./fetch-chain.js')
const { createLedger } = await import('./ledger.js')

const PAGE = 'https://203.0.113.20/bike'
const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const tavilyFails: NonNullable<FetchChainOptions['tavilyExtract']> = async (urls) => ({
  results: [],
  failedResults: urls.map((u) => ({ url: u, error: 'stubbed: no tavily in tests' })),
  responseTime: 0,
  requestId: 'test',
})

const product = {
  '@type': 'Product',
  name: 'Endurace CF 7',
  offers: { '@type': 'Offer', price: '2199.00', priceCurrency: 'EUR' },
}
const article = `<article><h1>Endurace CF 7</h1><p>${'Comfortable, fast and built for long days in the saddle. '.repeat(8)}</p></article>`
const filler = Array.from({ length: 400 }, (_, i) => `<script>window.__s${i}="${'x'.repeat(150)}"</script>`).join('')
const shopPage = (head: string): string => `<html><head><title>Bike</title>${head}</head><body>${article}${filler}</body></html>`

function serve(html: string): void {
  globalThis.fetch = (() => Promise.resolve(new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }))) as unknown as typeof fetch
}

const run = () =>
  runFetchChain(PAGE, { ledger: createLedger(), hostGate: createHostGate(), tavilyExtract: tavilyFails })

describe('thin Readability on a big shop page', () => {
  it('delivers the JSON-LD price from the origin step instead of the sliver alone', async () => {
    serve(shopPage(`<script type="application/ld+json">${JSON.stringify(product)}</script>`))
    const result = await run()

    expect(result.via).toBe('readability')
    expect(result.text).toContain('Comfortable, fast and built')
    expect(result.text).toContain('offers.price: 2199.00')
    expect(result.attempts[0]).toMatchObject({ step: 'readability', ok: true })
  })

  it('falls through to the later stages when the sliver has no structured data to back it', async () => {
    serve(shopPage(''))
    const result = await run()

    expect(result.attempts[0]).toMatchObject({ step: 'readability', ok: false })
    expect(result.attempts[0]?.error).toContain('thin for page size')
    expect(result.attempts.some((a) => a.step === 'tavily-extract')).toBe(true)
  })

  it('keeps the origin sliver when render and Tavily both fail, without human solve or Wayback', async () => {
    serve(shopPage(''))
    let humanCalls = 0
    const ledger = createLedger()
    const result = await runFetchChain(PAGE, {
      ledger,
      hostGate: createHostGate(),
      tavilyExtract: tavilyFails,
      humanSolve: async () => {
        humanCalls++
        return { ok: false, reason: 'not expected' }
      },
    })

    expect(result.error).toBeNull()
    expect(result.via).toBe('readability')
    expect(result.text).toContain('Comfortable, fast and built')
    expect(humanCalls).toBe(0)
    expect(result.attempts.some((a) => a.step === 'wayback')).toBe(false)
    expect(result.attempts.find((a) => a.step === 'tavily-extract')).toMatchObject({ ok: false })
    expect(ledger.tierOf(PAGE)).toBe('retrieved')
    expect(ledger.failureReason(PAGE)).toBeNull()
  })

  it('prefers a later stage that succeeds over the sparse origin sliver', async () => {
    serve(shopPage(''))
    const tavilyReads: NonNullable<FetchChainOptions['tavilyExtract']> = async (urls) => ({
      results: urls.map((u) => ({ url: u, title: 'Bike', rawContent: `Full page from extract. ${'Specs and price. '.repeat(30)}`, images: [], favicon: '' })),
      failedResults: [],
      responseTime: 0,
      requestId: 'test',
    })
    const result = await runFetchChain(PAGE, { ledger: createLedger(), hostGate: createHostGate(), tavilyExtract: tavilyReads })

    expect(result.via).toBe('tavily-extract')
    expect(result.text).toContain('Full page from extract.')
    expect(result.text).not.toContain('Comfortable, fast and built')
  })

  it('still accepts a small page with short text', async () => {
    serve(`<html><body>${article}</body></html>`)
    const result = await run()

    expect(result.via).toBe('readability')
    expect(result.attempts[0]).toMatchObject({ step: 'readability', ok: true })
  })
})
