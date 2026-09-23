// PDF detection + extraction for the fetch chain — a scientific paper's `application/pdf`
// response was previously handed to linkedom/Readability (which cannot build a document from
// a binary), so it fell through every step and landed on Tavily Extract, which does not read
// PDFs either. See fetch-chain.ts's PDF branch for where this plugs in.
//
// Extraction runs `pdftotext` (poppler-utils, bundled into the image the same way yt-dlp is —
// see the Dockerfile) in its DEFAULT layout mode, not `-layout`. MEASURED against three real
// papers (AMS MWR-D-21-0150.1, Copernicus GMD doi:10.5194/gmd-19-4703-2026, arXiv:2309.04452):
// `-layout` interleaves the two columns onto the same line on ALL three, corrupting most of the
// prose; the default mode keeps correct reading order, auto-dehyphenates, and renders ligatures
// cleanly, at the cost of collapsed tables (a known, accepted limitation — a paper's prose is
// the thing a worker cites, not its tables). This is a deliberate deviation from the original
// brief, which named `-layout`; the measurement above is why. Extraction itself took 0.02-0.2s
// and 12-22 MB RSS on those three papers — cheap enough that the byte cap below, not CPU, is
// the thing worth bounding.
//
// The whole body is never buffered in the Bun heap: `extractPdfText` streams the response
// straight into `pdftotext -`'s stdin chunk by chunk, counting bytes as it goes, and kills the
// process the moment the running total crosses `maxBytes` — the same "cap while reading, not
// after" discipline `readBoundedBody` (fetch-chain.ts) uses for everything else, applied here
// because a PDF can legitimately run past `MAX_BODY_BYTES` (8 MB) while staying under this
// module's own, larger cap.
//
// Dependency-free of env.js/log.js by design (same convention as ledger.ts/site-adapters.ts):
// the caller passes every path/limit in, so this stays unit-testable without booting the
// env-parsing chain.

/** The largest PDF this chain will download and feed to pdftotext. */
export const PDF_MAX_BYTES = 25 * 1024 * 1024

/** The largest stdout `pdftotext` may produce before this module stops reading it. */
export const PDF_MAX_OUTPUT_BYTES = 2 * 1024 * 1024

/** How long one `pdftotext` invocation may run before it is killed — a hang guard on this ONE subprocess's unit of work, not a job-level or wall-clock budget (see ~/.claude/rules/agent-limits.md). A killed extraction is a miss the fetch chain falls through from, exactly like a thrown parse error already is. */
export const PDF_HANG_GUARD_MS = 60_000

const PDF_MAGIC = '%PDF-'
// A magic sniff is only meaningful within the leading bytes of a response — a real PDF's
// header sits at byte 0, and the odd server that pads with a BOM or a few bytes of garbage
// before it is still "at the start" for any practical purpose. 1024 bytes of slack costs
// nothing and catches both.
const MAGIC_SNIFF_WINDOW = 1024

/**
 * True when this response is a PDF: an explicit `application/pdf`/`application/x-pdf`
 * content-type, or (when `head` is supplied) the `%PDF-` magic bytes within the first 1024
 * bytes of the body — the fallback for `application/octet-stream` and other mislabelled
 * responses a real-world PDF host occasionally sends.
 */
export function isPdf(input: { contentType?: string | null; head?: Uint8Array }): boolean {
  const contentType = (input.contentType ?? '').toLowerCase()
  if (contentType.includes('application/pdf') || contentType.includes('application/x-pdf')) return true
  if (!input.head || input.head.byteLength === 0) return false
  const window = input.head.subarray(0, MAGIC_SNIFF_WINDOW)
  const text = new TextDecoder('latin1').decode(window) // byte-for-byte, no multi-byte decode surprises
  return text.includes(PDF_MAGIC)
}

export type PdfExtractResult = { ok: true; text: string } | { ok: false; reason: string; overCap: boolean }

// The two `ReadableStreamDefaultReader` members this module actually calls, named
// structurally rather than as the ambient global type: without `lib.dom` in this project's
// tsconfig, bun-types itself falls back to `node:stream/web`'s reader shape for a bare
// `.getReader()` call, which is missing Bun's `readMany()` extension that the GLOBAL
// `ReadableStreamDefaultReader` interface separately declares as required — so naming that
// type here would reject a perfectly real reader from either runtime. `read`/`cancel` are the
// one contract both shapes actually share.
export interface PdfBodyReader {
  read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>
  cancel(reason?: unknown): Promise<void>
}

export interface ExtractPdfTextOptions {
  /** The response body's stream reader — not yet fully consumed. */
  reader: PdfBodyReader
  /** A chunk already pulled off `reader` while sniffing for the PDF magic bytes, if any — prepended so no byte the sniff consumed is lost. */
  head?: Uint8Array
  /** The origin's declared Content-Length, if present — used only for a cheap early reject. */
  declaredLength?: number
  /** Path to the `pdftotext` binary. */
  pdftotextPath: string
  maxBytes?: number
  maxOutputBytes?: number
  hangGuardMs?: number
}

function readCapped(stream: ReadableStream<Uint8Array> | null, cap: number): Promise<{ text: string; truncated: boolean }> {
  if (!stream) return Promise.resolve({ text: '', truncated: false })
  return (async () => {
    const decoder = new TextDecoder()
    let text = ''
    let bytes = 0
    let truncated = false
    for await (const chunk of stream) {
      bytes += chunk.byteLength
      // Past the cap, keep DRAINING without keeping: stopping the read would leave pdftotext
      // blocked on a full pipe until the hang guard killed it, turning a long paper into a miss.
      if (truncated) continue
      if (bytes > cap) {
        truncated = true
        continue
      }
      text += decoder.decode(chunk, { stream: true })
    }
    if (!truncated) text += decoder.decode()
    return { text, truncated }
  })()
}

/**
 * Streams a PDF response through `pdftotext -enc UTF-8 -nopgbrk - -` (stdin -> stdout, byte-
 * identical to reading/writing a file — measured) and returns its extracted text, or why
 * extraction did not happen. Never buffers the whole PDF: bytes are counted as they are piped
 * into the subprocess's stdin, and the moment the running total exceeds `maxBytes` the body is
 * cancelled and the process killed — `overCap: true` distinguishes this from every other
 * failure so the caller never turns "too big to read" into a claim about the paper's content
 * (ground.ts's rule: a failed retrieval must never become a negative claim).
 */
export async function extractPdfText(opts: ExtractPdfTextOptions): Promise<PdfExtractResult> {
  const maxBytes = opts.maxBytes ?? PDF_MAX_BYTES
  const maxOutputBytes = opts.maxOutputBytes ?? PDF_MAX_OUTPUT_BYTES
  const hangGuardMs = opts.hangGuardMs ?? PDF_HANG_GUARD_MS

  if (opts.declaredLength !== undefined && Number.isFinite(opts.declaredLength) && opts.declaredLength > maxBytes) {
    await opts.reader.cancel().catch(() => {})
    return { ok: false, overCap: true, reason: `pdf over ${maxBytes} byte cap (declared ${opts.declaredLength})` }
  }

  const proc = Bun.spawn([opts.pdftotextPath, '-enc', 'UTF-8', '-nopgbrk', '-', '-'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const hangController = new AbortController()
  let hangTimer: ReturnType<typeof setTimeout> | undefined

  const stdoutPromise = readCapped(proc.stdout, maxOutputBytes)
  const stderrPromise = readCapped(proc.stderr, 8_192).then((r) => r.text)

  let bytes = 0
  let overCap = false
  const writer = proc.stdin
  try {
    if (opts.head && opts.head.byteLength > 0) {
      bytes += opts.head.byteLength
      if (bytes > maxBytes) overCap = true
      else await writer.write(opts.head)
    }
    if (!overCap) {
      for (;;) {
        const { done, value } = await opts.reader.read()
        if (done || !value) break
        bytes += value.byteLength
        if (bytes > maxBytes) {
          overCap = true
          await opts.reader.cancel().catch(() => {})
          break
        }
        await writer.write(value)
      }
    } else {
      await opts.reader.cancel().catch(() => {})
    }
  } catch (err) {
    clearTimeout(hangTimer)
    try {
      proc.kill('SIGKILL')
    } catch {
      // already gone
    }
    await stdoutPromise.catch(() => {})
    await stderrPromise.catch(() => {})
    return { ok: false, overCap: false, reason: `pdf stream error: ${String(err)}` }
  }

  try {
    await writer.end()
  } catch {
    // A pdftotext that already died (killed above, or exited early on bad input) closes its
    // stdin pipe from its side — ending an already-closed sink throws and carries no new
    // information here, so it is swallowed rather than surfaced as this call's own failure.
  }
  // Armed only now that the whole body is piped in: the guard is on pdftotext's own work, and
  // a slow download of a large paper is not a hung extraction.
  hangTimer = setTimeout(() => {
    hangController.abort()
    try {
      proc.kill('SIGKILL')
    } catch {
      // already gone
    }
  }, hangGuardMs)
  hangTimer.unref?.()

  if (overCap) {
    clearTimeout(hangTimer)
    try {
      proc.kill('SIGKILL')
    } catch {
      // already gone
    }
    await stdoutPromise.catch(() => {})
    await stderrPromise.catch(() => {})
    return { ok: false, overCap: true, reason: `pdf over ${maxBytes} byte cap (read ${bytes} bytes)` }
  }

  const [{ text: stdout }, stderrText] = await Promise.all([stdoutPromise, stderrPromise])
  const code = await proc.exited
  clearTimeout(hangTimer)

  if (hangController.signal.aborted) {
    return { ok: false, overCap: false, reason: `pdftotext hang guard fired after ${hangGuardMs}ms` }
  }
  // `proc.signalCode`, not `proc.killed` — measured true on Bun for both a SIGKILL and a
  // clean fast exit alike (the same trap documented in agent/ytdlp.ts / lightpanda/server.ts).
  if (proc.signalCode) {
    return { ok: false, overCap: false, reason: `pdftotext killed (${proc.signalCode})` }
  }
  if (code !== 0) {
    const stderrSlice = stderrText.trim().slice(0, 200) || `exit ${code}`
    return { ok: false, overCap: false, reason: `pdftotext exited ${code}: ${stderrSlice}` }
  }

  return { ok: true, text: stdout }
}
