// The one place every network response body is read, so nothing unbounded is ever downloaded,
// decoded or allocated in one piece. Env- and log-free by design (the logger is injected) —
// same convention as ledger.ts / extract.ts / response-kind.ts, so it stays unit-testable
// without booting env.ts. Lives in lib/ because lib/tavily-account.ts is a caller too, and a
// bounded reader has nothing to do with the fetch chain's own concerns.

// The largest non-PDF body the service will download and decode from a network response.
// Sized above the largest honest payload measured (a full PyPI registry JSON for `numpy`,
// ~3.7 MB) so the cap never bites real traffic, while bounding the pathological case — a host
// answering with hundreds of MB or gigabytes, downloaded, UTF-8-decoded and allocated on the
// one event loop every job shares (the OOM-kill shape docs/measurements.md records).
//
// PDFs are the deliberate exception: the fetch chain's step 1 reads them at MAX_PDF_BYTES
// (40 MB, pdf-extract.ts) because poppler needs the whole document. Every non-PDF body — an
// HTML page, a caption track, a registry JSON, a raw repo file — is far under 8 MB in honest
// operation.
export const MAX_BODY_BYTES = 8 * 1024 * 1024

export interface BoundedBytes {
  /** The bytes read, up to the cap. Partial when `truncated`. */
  bytes: Uint8Array
  /** True when the body was cut at the cap rather than read to the end. */
  truncated: boolean
}

export interface BoundedText {
  /** The decoded body: the whole of it, unless `truncated`. */
  text: string
  /** True when the body was cut at the cap rather than read to the end. */
  truncated: boolean
}

export interface OversizedInfo {
  capBytes: number
  /** The origin's declared size, when a `content-length` header made the cut known up front. */
  declaredBytes?: number
  /** The byte count at the moment the reader gave up. */
  readBytes?: number
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
}

/**
 * The shared core of every bounded byte read: pulls the stream chunk by chunk, asks `chooseCap`
 * for the cap the FIRST time a chunk arrives, and cancels the body the moment the next chunk
 * would cross it. Cancelling — rather than reading to the end and discarding — is the point:
 * a pathological body is never downloaded in full before being rejected. On truncation the
 * bytes already read are KEPT, so a caller whose cap depended on the prefix can still inspect
 * it.
 */
async function readBounded(
  body: ReadableStream<Uint8Array> | null,
  chooseCap: (firstChunk: Uint8Array) => number,
): Promise<BoundedBytes> {
  if (!body) return { bytes: new Uint8Array(0), truncated: false }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let capBytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (chunks.length === 0) capBytes = chooseCap(value)
      const next = total + value.length
      if (next > capBytes) {
        await reader.cancel().catch(() => {})
        return { bytes: concat(chunks, total), truncated: true }
      }
      chunks.push(value)
      total = next
    }
  } finally {
    reader.releaseLock()
  }
  return { bytes: concat(chunks, total), truncated: false }
}

/**
 * Reads a stream up to `capBytes`. On truncation the partial bytes are kept: a caller that can
 * still use a cut body (a raw JSON/CSV answer) may, while one that needs the whole document
 * (Readability, a PDF) treats `truncated` as a miss.
 */
export function readBoundedBytes(
  body: ReadableStream<Uint8Array> | null,
  capBytes: number,
): Promise<BoundedBytes> {
  return readBounded(body, () => capBytes)
}

/**
 * Reads a stream whose cap depends on what its first bytes turn out to be. The fetch chain's
 * step 1 needs exactly this: a PDF is read at MAX_PDF_BYTES, but a PDF served under a wrong or
 * absent Content-Type only announces itself in the `%PDF-` magic at the start of the body, so
 * the cap cannot be fixed before the first chunk arrives.
 */
export function readBoundedBytesByCap(
  body: ReadableStream<Uint8Array> | null,
  chooseCap: (firstChunk: Uint8Array) => number,
): Promise<BoundedBytes> {
  return readBounded(body, chooseCap)
}

/**
 * Reads a byte stream up to `capBytes`, decoded to text, discarding whatever comes past the
 * cap. The shared reader behind the spawned-process streams (pdf.ts's pdftotext, ytdlp.ts's
 * yt-dlp, brain-search.ts's ripgrep) — kept here, not hand-copied in each spawn wrapper, so
 * the "read up to a cap, never buffer past it" logic has one home. Built on readBoundedBytes
 * rather than a second loop.
 */
export async function readCappedText(stream: ReadableStream<Uint8Array> | null, capBytes: number): Promise<string> {
  const { bytes } = await readBoundedBytes(stream, capBytes)
  return new TextDecoder().decode(bytes)
}

/**
 * Reads a response body as text under `capBytes`, with a `content-length` early-out so an
 * over-cap body the origin declared up front is never pulled a single byte. Partial text is
 * kept on truncation, same contract as readBoundedBytes. `onOversized` fires with the numbers
 * the moment the cap trips, so an operator can see a body was cut — it is the caller's own
 * logger, injected to keep this module env-free.
 */
export async function readBoundedText(
  res: Response,
  capBytes: number,
  onOversized?: (info: OversizedInfo) => void,
): Promise<BoundedText> {
  const body = res.body
  // A 204/304 or a HEAD has no body: res.text() returned '' for these, and so does this.
  if (!body) return { text: '', truncated: false }

  const declared = Number(res.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > capBytes) {
    await body.cancel().catch(() => {})
    onOversized?.({ capBytes, declaredBytes: declared })
    return { text: '', truncated: true }
  }

  const reader = body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const next = bytes + value.byteLength
      if (next > capBytes) {
        await reader.cancel().catch(() => {})
        onOversized?.({ capBytes, readBytes: next })
        return { text, truncated: true }
      }
      bytes = next
      text += decoder.decode(value, { stream: true })
    }
    return { text: text + decoder.decode(), truncated: false }
  } finally {
    // A body that errors mid-read (a dropped connection) must release the reader too, and the
    // error still reaches the caller — a truncated body is not a substitute for a throw.
    reader.releaseLock()
  }
}
