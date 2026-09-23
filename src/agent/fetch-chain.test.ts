import { describe, it, expect, afterAll } from 'bun:test'

// What `PARSE_INPUT_CAP` could NOT prove, driven through the real chain: the cap is applied to
// an already-materialized string, so on its own it bounds the parse and nothing else. A body
// the origin declares, or streams, over `MAX_BODY_BYTES` used to be downloaded and decoded in
// full before any guard saw a character — a stall on the one event loop every job, every
// heartbeat timer and the HTTP listener share. These tests fail if that reader is removed:
// `pulled()` is the number of bytes the response body actually gave up.
//
// Same bootstrap as otel-spans.test.ts, and for the same reason: `fetch-chain.ts` imports
// `env.ts`, which parses `process.env` at import time and throws without secrets, so the
// module graph is pulled in with a dynamic import AFTER these are set. `??=` so a real
// environment is never clobbered.
process.env['API_SECRET'] ??= 'test-secret'
process.env['IU_BASE_URL'] ??= 'https://example.invalid/v1'
process.env['IU_API_KEY'] ??= 'test-key'
process.env['TAVILY_API_KEY'] ??= 'test-key'

// TEST-NET-3: `assertPublicHttpUrl` resolves a literal IP through `lookup()` without a DNS
// query, so the SSRF guard passes offline and the stub below is the only thing reachable.
const PAGE = 'https://203.0.113.20/page'
const RENDER_BASE = 'http://203.0.113.10:7781'
const RENDER_HOST = new URL(RENDER_BASE).host

const { runFetchChain } = await import('./fetch-chain.js')
const { createLedger } = await import('./ledger.js')
const { PARSE_INPUT_CAP, MAX_BODY_BYTES } = await import('./response-kind.js')

// PDF fixtures — read with Bun.file rather than node:fs, matching pdf.test.ts's convention
// (importing a `node:*` module pulls in @types/node's own ReadableStream declarations, which
// conflict with bun-types' and break `tsc --noEmit` the moment this file names that type).
const PDFTOTEXT_PATH = Bun.which('pdftotext')
const PDF_FIXTURES = `${import.meta.dir}/__fixtures__`
// `paper.pdf` carries real prose clearing MIN_USABLE_CHARS (200); `valid.pdf`/`thin.pdf`
// (pdf.test.ts's fixtures) are deliberately tiny and would read as "thin" at THIS layer even
// on a clean extraction — that distinction is the point of the "thin" test below.
const PAPER_PDF = new Uint8Array(await Bun.file(`${PDF_FIXTURES}/paper.pdf`).arrayBuffer())
const THIN_PDF = new Uint8Array(await Bun.file(`${PDF_FIXTURES}/thin.pdf`).arrayBuffer())

const realFetch = globalThis.fetch
afterAll(() => {
  globalThis.fetch = realFetch
})

function stubFetch(handler: (url: string) => Response): void {
  globalThis.fetch = ((input: unknown) => Promise.resolve(handler(String(input)))) as typeof fetch
}

// Enough text for the renderer's answer to clear MIN_USABLE_CHARS and terminate the chain.
const RENDERED = 'Real page content. '.repeat(200)

/** The renderer's own response shape, so a chain that falls through terminates at step 2. */
function renderOk(): Response {
  return new Response(JSON.stringify({ ok: true, text: RENDERED, status: 200 }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** Chunk size the fake bodies below produce — also the most a cancelled stream can buffer. */
const CHUNK_BYTES = 64 * 1024

/**
 * A body produced one chunk at a time, counting the bytes actually pulled off it.
 *
 * `declare` puts a content-length on the response WITHOUT making the generator honour it —
 * the adversarial shape, where the header and the body disagree and the body is what costs.
 */
function streamedBody(totalBytes: number, contentType: string, declare?: number) {
  let pulled = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= totalBytes) {
        controller.close()
        return
      }
      const size = Math.min(CHUNK_BYTES, totalBytes - pulled)
      pulled += size
      controller.enqueue(new Uint8Array(size).fill(0x61)) // 'a'
    },
  })
  const headers: Record<string, string> = { 'content-type': contentType }
  if (declare !== undefined) headers['content-length'] = String(declare)
  return { res: new Response(stream, { status: 200, headers }), pulled: () => pulled }
}

describe('the fetch chain never downloads an unbounded body', () => {
  it('pulls nothing at all from a body the origin declared over MAX_BODY_BYTES', async () => {
    const body = streamedBody(MAX_BODY_BYTES * 10, 'text/html', MAX_BODY_BYTES * 10)
    stubFetch((url) => (url.includes(RENDER_HOST) ? renderOk() : body.res))

    const result = await runFetchChain(PAGE, { ledger: createLedger(), renderBaseUrl: RENDER_BASE })

    // The cheap early-out: the declared size is over the cap, so the stream is never read.
    // Not literally 0 — a ReadableStream fills its own buffer before `cancel()` lands — but a
    // single chunk, nothing proportional to the 80 MB the origin says it has.
    expect(body.pulled()).toBeLessThanOrEqual(CHUNK_BYTES)
    // A miss like any other, not an error — the renderer answers, which is what a page this
    // heavy deserves.
    expect(result.attempts.map((a) => a.step)).toEqual(['readability', 'lightpanda'])
    expect(result.attempts[0]!.error).toContain('oversized')
    expect(result.via).toBe('lightpanda')
  })

  it('stops reading an undeclared body at the cap and cancels the rest', async () => {
    // No content-length at all — a chunked response, which is exactly the case a header-only
    // guard would miss. This is the assertion the old `await res.text()` could not survive:
    // it would have pulled all MAX_BODY_BYTES * 10.
    const body = streamedBody(MAX_BODY_BYTES * 10, 'text/html')
    stubFetch((url) => (url.includes(RENDER_HOST) ? renderOk() : body.res))

    const result = await runFetchChain(PAGE, { ledger: createLedger(), renderBaseUrl: RENDER_BASE })

    expect(body.pulled()).toBeGreaterThanOrEqual(MAX_BODY_BYTES)
    // Well under the 10x the generator is willing to produce: the reader stopped and cancelled
    // rather than draining the response.
    expect(body.pulled()).toBeLessThan(MAX_BODY_BYTES * 2)
    expect(result.attempts[0]!.error).toContain('oversized')
    expect(result.via).toBe('lightpanda')
  })

  it('still answers a raw body over the CHARACTER cap — that cap is about parsing, not fetching', async () => {
    // A large JSON/CSV dump is a legitimate answer and the whole reason the raw branch exists.
    // Applying the PARSE cap to it sends these URLs to the renderer and then to a BILLED
    // Tavily Extract, to recover text the chain was already holding.
    const csv = 'a'.repeat(PARSE_INPUT_CAP + 1)
    stubFetch((url) =>
      url.includes(RENDER_HOST)
        ? renderOk()
        : new Response(csv, { status: 200, headers: { 'content-type': 'text/csv' } }),
    )

    const result = await runFetchChain(PAGE, { ledger: createLedger(), renderBaseUrl: RENDER_BASE })

    expect(result.attempts.map((a) => a.step)).toEqual(['raw'])
    expect(result.via).toBe('raw')
    // Capped for the worker at TEXT_CAP, with the notice that says the tail is missing — the
    // reader must not have swallowed that by cutting the body before capText could see it.
    expect(result.text).toContain('[truncated: showing the first 80000 of 2000001 characters')
  })
})

describe('the PDF step', () => {
  it.skipIf(!PDFTOTEXT_PATH)('reads a PDF served with an honest content-type and grounds it as retrieved', async () => {
    stubFetch(() => new Response(PAPER_PDF, { status: 200, headers: { 'content-type': 'application/pdf' } }))
    const ledger = createLedger()

    const result = await runFetchChain(PAGE, { ledger })

    expect(result.via).toBe('pdf')
    expect(result.text).toContain('EMOS and quantile regression forests are mentioned here.')
    expect(ledger.tierOf(PAGE)).toBe('retrieved')
  })

  it.skipIf(!PDFTOTEXT_PATH)('detects a PDF mislabelled as application/octet-stream via the magic bytes', async () => {
    stubFetch(() => new Response(PAPER_PDF, { status: 200, headers: { 'content-type': 'application/octet-stream' } }))

    const result = await runFetchChain(PAGE, { ledger: createLedger() })

    expect(result.via).toBe('pdf')
    expect(result.text).toContain('EMOS and quantile regression forests are mentioned here.')
  })

  it.skipIf(!PDFTOTEXT_PATH)('never mistakes an ordinary HTML page for a PDF', async () => {
    stubFetch((url) =>
      url.includes(RENDER_HOST)
        ? renderOk()
        : new Response('<html><body>' + 'not a pdf. '.repeat(50) + '</body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
    )

    const result = await runFetchChain(PAGE, { ledger: createLedger(), renderBaseUrl: RENDER_BASE })

    expect(result.attempts.some((a) => a.step === 'pdf')).toBe(false)
  })

  it.skipIf(!PDFTOTEXT_PATH)('skips lightpanda for a thin/scanned PDF — a browser cannot read one any better', async () => {
    // The chain still falls through to Tavily Extract after this (step 3 always runs), which
    // is a REAL network call this test does not control the outcome of — the assertion here is
    // deliberately scoped to what step 1 decided: lightpanda must never be asked.
    stubFetch((url) => {
      if (url.includes(RENDER_HOST)) throw new Error('lightpanda must never be asked to read a PDF')
      return new Response(THIN_PDF, { status: 200, headers: { 'content-type': 'application/pdf' } })
    })

    const result = await runFetchChain(PAGE, { ledger: createLedger(), renderBaseUrl: RENDER_BASE })

    expect(result.attempts[0]).toMatchObject({ step: 'pdf', ok: false })
    expect(result.attempts.some((a) => a.step === 'lightpanda')).toBe(false)
  })

  it('records a failure, never a negative claim, when the PDF is declared over the 25 MB cap', async () => {
    stubFetch(() => new Response(PAPER_PDF, {
      status: 200,
      headers: { 'content-type': 'application/pdf', 'content-length': String(30 * 1024 * 1024) },
    }))
    const ledger = createLedger()

    const result = await runFetchChain(PAGE, { ledger })

    expect(result.error).toContain('over')
    expect(ledger.tierOf(PAGE)).toBe('failed')
    // Never `missing` — that tier backs a HIGH-confidence absence claim, and a paper that is
    // merely too big to fetch is not evidence the paper does not exist (ground.ts's rule).
    expect(ledger.tierOf(PAGE)).not.toBe('missing')
  })
})
