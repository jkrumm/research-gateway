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

export interface BoundedBytesByCap extends BoundedBytes {
  /** The cap `chooseCap` actually decided on, so a caller doesn't have to re-derive it. */
  cap: number
}

// How much of the stream `readBounded` buffers before it trusts `chooseCap`'s answer. A
// mislabeled PDF only announces itself in the 5-byte `%PDF-` magic (response-kind.ts), and a
// chunk boundary is a network/runtime accident, not a content boundary — a host (or a test)
// that happens to deliver one byte per chunk must not lock the cap to the wrong value forever
// from a 1-byte first chunk. 8 bytes comfortably covers the magic with room to spare.
const CAP_DECISION_PREFIX_BYTES = 8

export interface BoundedText {
  /** The decoded body: the whole of it, unless `truncated`. */
  text: string
  /** True when the body was cut at the cap rather than read to the end. */
  truncated: boolean
}

export interface OversizedInfo {
  capBytes: number
  /** The byte count actually kept before the cap stopped the reader. */
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
 * The shared core of every bounded byte read: pulls the stream chunk by chunk, buffers a
 * `CAP_DECISION_PREFIX_BYTES`-byte prefix (or the whole body, if it ends sooner) before it asks
 * `chooseCap` for the cap, then cancels the body the moment the next chunk would cross it.
 * Deciding on a prefix rather than on the first raw chunk is what stops a mislabeled body from
 * locking onto the wrong cap when the origin (or a test) happens to deliver it one byte at a
 * time: `chooseCap` never sees fewer than the prefix unless the stream itself was shorter.
 * Cancelling — rather than reading to the end and discarding — is the point: a pathological
 * body is never downloaded in full before being rejected. On truncation the bytes already read
 * are KEPT, so a caller whose cap depended on the prefix can still inspect it. Every chunk,
 * including the ones buffered before the cap was known, still goes through the same
 * cap-crossing check once the cap IS known — nothing pre-decision is exempt from enforcement.
 */
async function readBounded(
  body: ReadableStream<Uint8Array> | null,
  chooseCap: (prefix: Uint8Array) => number,
): Promise<BoundedBytesByCap> {
  if (!body) return { bytes: new Uint8Array(0), truncated: false, cap: 0 }
  const reader = body.getReader()
  const committed: Uint8Array[] = []
  let total = 0
  let capBytes: number | null = null

  // Applies one chunk against the now-known cap. Returns true when it crossed the cap (the
  // chunk is NOT added, matching readBounded's long-standing "never buffer past the cap"
  // contract) — the caller cancels the reader and returns on true.
  const take = (chunk: Uint8Array): boolean => {
    const next = total + chunk.length
    if (next > (capBytes as number)) return true
    committed.push(chunk)
    total = next
    return false
  }

  try {
    const pending: Uint8Array[] = []
    let pendingTotal = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        if (capBytes === null) capBytes = chooseCap(concat(pending, pendingTotal))
        for (const chunk of pending) {
          if (take(chunk)) return { bytes: concat(committed, total), truncated: true, cap: capBytes }
        }
        break
      }
      if (capBytes === null) {
        pending.push(value)
        pendingTotal += value.length
        if (pendingTotal < CAP_DECISION_PREFIX_BYTES) continue
        capBytes = chooseCap(concat(pending, pendingTotal))
        const flushed = pending.splice(0, pending.length)
        pendingTotal = 0
        for (const chunk of flushed) {
          if (take(chunk)) {
            await reader.cancel().catch(() => {})
            return { bytes: concat(committed, total), truncated: true, cap: capBytes }
          }
        }
        continue
      }
      if (take(value)) {
        await reader.cancel().catch(() => {})
        return { bytes: concat(committed, total), truncated: true, cap: capBytes }
      }
    }
  } finally {
    reader.releaseLock()
  }
  return { bytes: concat(committed, total), truncated: false, cap: capBytes ?? 0 }
}

/**
 * Reads a stream up to `capBytes`. On truncation the partial bytes are kept: a caller that can
 * still use a cut body (a raw JSON/CSV answer) may, while one that needs the whole document
 * (Readability, a PDF) treats `truncated` as a miss.
 */
export async function readBoundedBytes(
  body: ReadableStream<Uint8Array> | null,
  capBytes: number,
): Promise<BoundedBytes> {
  const { bytes, truncated } = await readBounded(body, () => capBytes)
  return { bytes, truncated }
}

/**
 * Reads a stream whose cap depends on what its content turns out to be. The fetch chain's
 * step 1 needs exactly this: a PDF is read at MAX_PDF_BYTES, but a PDF served under a wrong or
 * absent Content-Type only announces itself in the `%PDF-` magic at the start of the body, so
 * the cap cannot be fixed before a real prefix of it has arrived. Returns the cap it actually
 * used, so a caller that based a second decision (is this body a PDF at all?) on the same
 * bytes doesn't have to re-derive it from scratch.
 */
export function readBoundedBytesByCap(
  body: ReadableStream<Uint8Array> | null,
  chooseCap: (prefix: Uint8Array) => number,
): Promise<BoundedBytesByCap> {
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
 * Reads a response body as text under `capBytes`, decoded in one pass once the bytes are in
 * hand. No `content-length` early-out: the streaming cap below already bounds the read, and an
 * origin that over-states its own `content-length` (a misconfigured proxy, a stale cache
 * header) must not turn an otherwise-readable body into a miss before a single byte is pulled.
 * Partial text is kept on truncation, same contract as readBoundedBytes. `onOversized` fires
 * with the numbers the moment the cap trips, so an operator can see a body was cut — it is the
 * caller's own logger, injected to keep this module env-free. Built on readBoundedBytes rather
 * than a second "never buffer past the cap" loop, so there is exactly one home for that logic.
 */
export async function readBoundedText(
  res: Response,
  capBytes: number,
  onOversized?: (info: OversizedInfo) => void,
): Promise<BoundedText> {
  const body = res.body
  // A 204/304 or a HEAD has no body: res.text() returned '' for these, and so does this.
  if (!body) return { text: '', truncated: false }

  const { bytes, truncated } = await readBoundedBytes(body, capBytes)
  if (truncated) onOversized?.({ capBytes, readBytes: bytes.length })
  return { text: new TextDecoder().decode(bytes), truncated }
}

// The download ceiling for the streaming line filter ONLY (readBoundedLines). Every other reader
// here buffers what it keeps, so it stays at MAX_BODY_BYTES; the filter keeps just the header and
// the matching lines, so its memory is bounded by the OUTPUT and the ceiling only bounds how long
// a single fetch may run. 128 MB covers OWID's 19 MB CO2 file and the next order of magnitude of
// honest open-data CSVs.
const MAX_STREAMED_LINES_BYTES = 128 * 1024 * 1024

// One physical line longer than this is cut (its tail dropped): a "line-oriented" body with no
// newlines at all must not make the carry-over buffer grow without bound.
const MAX_LINE_CHARS = 1_000_000

export interface StreamedLines {
  /** First line of the body (no line terminator). */
  header: string
  /** Matching lines after the header, in order, kept only while they fit `keepChars`. */
  matches: string[]
  /** Every matching line after the header, kept or not. */
  matched: number
  /** Every line after the header that was tested. */
  searched: number
  /** Set when the ceiling stopped the read before the end: bytes read until then. */
  stoppedAtBytes?: number
}

export interface ReadLinesOptions {
  isMatch: (line: string) => boolean
  /** Characters of matching lines to keep; later matches are counted, not stored. */
  keepChars: number
  ceilingBytes?: number
}

/**
 * Streams a body line by line and keeps only its header plus the lines `isMatch` accepts — memory
 * is bounded by `keepChars` (plus one in-flight line), never by the file size. Stops, cancelling
 * the download, once `ceilingBytes` have been read and reports where. Env- and log-free.
 */
export async function readBoundedLines(body: ReadableStream<Uint8Array> | null, opts: ReadLinesOptions): Promise<StreamedLines> {
  const ceiling = opts.ceilingBytes ?? MAX_STREAMED_LINES_BYTES
  const out: StreamedLines = { header: '', matches: [], matched: 0, searched: 0 }
  if (!body) return out

  let sawHeader = false
  let keptChars = 0
  const onLine = (raw: string): void => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (!sawHeader) {
      out.header = line
      sawHeader = true
      return
    }
    out.searched++
    if (!opts.isMatch(line)) return
    out.matched++
    if (keptChars + line.length + 1 > opts.keepChars) return
    out.matches.push(line)
    keptChars += line.length + 1
  }

  const decoder = new TextDecoder()
  const reader = body.getReader()
  let carry = ''
  let skippingOverlong = false
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.length
      let chunk = carry + decoder.decode(value, { stream: true })
      carry = ''
      let from = 0
      for (let nl = chunk.indexOf('\n', from); nl !== -1; nl = chunk.indexOf('\n', from)) {
        if (skippingOverlong) skippingOverlong = false
        else onLine(chunk.slice(from, nl))
        from = nl + 1
      }
      chunk = chunk.slice(from)
      if (skippingOverlong) chunk = ''
      else if (chunk.length > MAX_LINE_CHARS) {
        onLine(chunk.slice(0, MAX_LINE_CHARS))
        chunk = ''
        skippingOverlong = true
      }
      carry = chunk
      if (bytes >= ceiling) {
        out.stoppedAtBytes = bytes
        await reader.cancel().catch(() => {})
        return out
      }
    }
    carry += decoder.decode()
    if (carry !== '' && !skippingOverlong) onLine(carry)
  } finally {
    reader.releaseLock()
  }
  return out
}
