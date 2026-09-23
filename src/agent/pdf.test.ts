import { describe, it, expect } from 'bun:test'
import { isPdf, extractPdfText, PDF_MAX_BYTES } from './pdf.js'

// Bun.file, not node:fs — importing a `node:*` module here pulls @types/node's OWN global
// ReadableStream/ReadableStreamDefaultReader declarations into this file's type-checking,
// which conflict with bun-types' (the one pdf.ts's signatures are written against) and fail
// `tsc --noEmit` with a spurious "missing readMany()" error. Same convention as ytdlp.ts,
// which reads its spawned process's streams the Bun-native way for the same reason.
const FIXTURES = `${import.meta.dir}/__fixtures__`
const VALID_PDF = new Uint8Array(await Bun.file(`${FIXTURES}/valid.pdf`).arrayBuffer())
const TRUNCATED_PDF = new Uint8Array(await Bun.file(`${FIXTURES}/truncated.pdf`).arrayBuffer())

const PDFTOTEXT_PATH = Bun.which('pdftotext')

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

describe('isPdf', () => {
  it('matches an explicit application/pdf content-type with no body at all', () => {
    expect(isPdf({ contentType: 'application/pdf' })).toBe(true)
  })

  it('matches application/x-pdf and is tolerant of a charset parameter and casing', () => {
    expect(isPdf({ contentType: 'Application/X-PDF; charset=binary' })).toBe(true)
  })

  it('matches the %PDF- magic bytes when the content-type is missing or generic', () => {
    const bytes = new TextEncoder().encode('%PDF-1.4\n...rest of a real pdf...')
    expect(isPdf({ contentType: 'application/octet-stream', head: bytes })).toBe(true)
    expect(isPdf({ contentType: null, head: bytes })).toBe(true)
  })

  it('finds the magic bytes preceded by leading junk, within the sniff window', () => {
    const junk = new Uint8Array(40).fill(0x20) // 40 spaces ahead of the marker
    const magic = new TextEncoder().encode('%PDF-1.7')
    const bytes = new Uint8Array(junk.length + magic.length)
    bytes.set(junk, 0)
    bytes.set(magic, junk.length)
    expect(isPdf({ contentType: 'application/octet-stream', head: bytes })).toBe(true)
  })

  it('does not match an ordinary HTML page', () => {
    const html = new TextEncoder().encode('<!doctype html><html><body>hello</body></html>')
    expect(isPdf({ contentType: 'text/html; charset=utf-8', head: html })).toBe(false)
    expect(isPdf({ contentType: 'text/html' })).toBe(false)
  })

  it('does not match generic content with no magic bytes present, even with a head supplied', () => {
    const json = new TextEncoder().encode('{"version":"1.2.3"}')
    expect(isPdf({ contentType: 'application/octet-stream', head: json })).toBe(false)
  })

  it('does not match when neither a pdf content-type nor a head is given', () => {
    expect(isPdf({ contentType: 'application/octet-stream' })).toBe(false)
  })
})

describe('extractPdfText', () => {
  it.skipIf(!PDFTOTEXT_PATH)('extracts the known sentence from a tiny valid single-page PDF', async () => {
    const reader = streamOf(VALID_PDF).getReader()
    const result = await extractPdfText({
      reader,
      pdftotextPath: PDFTOTEXT_PATH!,
      declaredLength: VALID_PDF.byteLength,
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.text).toContain('Hello from the pdf fixture.')
  })

  it.skipIf(!PDFTOTEXT_PATH)('reassembles a head chunk taken during magic-sniffing with the rest of the body', async () => {
    // Mirrors what fetch-chain.ts does: peel off the first chunk to sniff isPdf(), then hand
    // both the head and the still-open reader here so no byte is lost.
    const head = VALID_PDF.subarray(0, 10)
    const rest = VALID_PDF.subarray(10)
    const reader = streamOf(new Uint8Array(rest)).getReader()
    const result = await extractPdfText({
      reader,
      head: new Uint8Array(head),
      pdftotextPath: PDFTOTEXT_PATH!,
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.text).toContain('Hello from the pdf fixture.')
  })

  it.skipIf(!PDFTOTEXT_PATH)('reports a truncated/corrupt PDF as a failure, with the exit code in the reason', async () => {
    const reader = streamOf(TRUNCATED_PDF).getReader()
    const result = await extractPdfText({ reader, pdftotextPath: PDFTOTEXT_PATH! })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.overCap).toBe(false)
      expect(result.reason).toMatch(/exit(ed)? \d+/)
    }
  })

  it.skipIf(!PDFTOTEXT_PATH)('rejects a declared content-length over the cap without reading any bytes', async () => {
    let pulled = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        controller.enqueue(new Uint8Array(1024))
      },
    })
    const reader = stream.getReader()
    const result = await extractPdfText({
      reader,
      pdftotextPath: PDFTOTEXT_PATH!,
      declaredLength: PDF_MAX_BYTES + 1,
      maxBytes: PDF_MAX_BYTES,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.overCap).toBe(true)
    expect(pulled).toBe(0)
  })

  it.skipIf(!PDFTOTEXT_PATH)('cancels the stream once the running byte count crosses a small cap, without pulling it to the end', async () => {
    const chunkSize = 1024
    const maxBytes = 2 * chunkSize
    let pulled = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        // An effectively unbounded source — if this were pulled to exhaustion the test would
        // hang or run for a long time. Bounding `pulled` in the assertion below is the point.
        controller.enqueue(new Uint8Array(chunkSize).fill(1))
      },
    })
    const reader = stream.getReader()
    const result = await extractPdfText({ reader, pdftotextPath: PDFTOTEXT_PATH!, maxBytes })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.overCap).toBe(true)
      expect(result.reason).toContain(String(maxBytes))
    }
    // Cut a few chunks past the cap, nowhere near "pulled forever".
    expect(pulled).toBeLessThan(10)
  })
})
