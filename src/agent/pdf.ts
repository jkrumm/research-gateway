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
// env-parsing chain. `idle-watchdog.ts` is the one exception — it is equally dependency-free
// (no imports at all), so pulling it in costs nothing this file doesn't already pay.

import { createIdleWatchdog } from '../lib/idle-watchdog.js'

/** The largest PDF this chain will download and feed to pdftotext. */
export const PDF_MAX_BYTES = 25 * 1024 * 1024

/** The largest stdout `pdftotext` may produce before this module stops reading it. */
export const PDF_MAX_OUTPUT_BYTES = 2 * 1024 * 1024

/** How long `pdftotext` (or the body feeding it) may go with NO progress before it is killed — an idle watchdog on this ONE subprocess's unit of work, not a job-level or wall-clock budget (see ~/.claude/rules/agent-limits.md). "Progress" is any of: a chunk read off the caller's body reader, a chunk written to pdftotext's stdin, a chunk read off its stdout — so a large-but-actively-streaming paper is never punished, only real silence is. A killed extraction is a miss the fetch chain falls through from, exactly like a thrown parse error already is. */
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
  /** No-progress idle timeout — see `PDF_HANG_GUARD_MS`'s doc comment. */
  hangGuardMs?: number
}

// Thrown internally by `withIdle` when the idle watchdog aborts while something here is
// mid-await — never escapes `extractPdfText`, which always translates it into the `overCap:
// false, reason: 'pdftotext idle for …ms'` result.
class PdfIdleError extends Error {}

// Races `promise` against the idle watchdog's abort signal, so a stall on ANY single await —
// the caller's body reader, pdftotext's stdin, pdftotext's stdout — unblocks this function the
// moment the watchdog fires, rather than leaving it hung on a promise that will never settle on
// its own (killing the child process alone does not resolve a pending read on the CALLER's
// reader, which is not this module's to cancel out from under it).
function withIdle<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new PdfIdleError('idle'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new PdfIdleError('idle'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (e) => {
        signal.removeEventListener('abort', onAbort)
        reject(e)
      },
    )
  })
}

function readCapped(
  stream: ReadableStream<Uint8Array> | null,
  cap: number,
  opts?: { onChunk?: () => void; idleSignal?: AbortSignal },
): Promise<{ text: string; truncated: boolean }> {
  if (!stream) return Promise.resolve({ text: '', truncated: false })
  return (async () => {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let text = ''
    let bytes = 0
    let truncated = false
    try {
      for (;;) {
        const { done, value } = opts?.idleSignal ? await withIdle(reader.read(), opts.idleSignal) : await reader.read()
        if (done || !value) break
        opts?.onChunk?.()
        bytes += value.byteLength
        // Past the cap, keep DRAINING without keeping: stopping the read would leave pdftotext
        // blocked on a full pipe until the idle watchdog killed it, turning a long paper into a miss.
        if (truncated) continue
        if (bytes > cap) {
          truncated = true
          continue
        }
        text += decoder.decode(value, { stream: true })
      }
    } catch {
      // An idle-aborted read, or the stream genuinely erroring (the process was SIGKILLed out
      // from under it) — either way this returns what was captured so far, marked truncated,
      // rather than rejecting: this function never threw before, and every call site relies on
      // that (Promise.all in the success path has no `.catch`).
      return { text, truncated: true }
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
  const idleMs = opts.hangGuardMs ?? PDF_HANG_GUARD_MS

  if (opts.declaredLength !== undefined && Number.isFinite(opts.declaredLength) && opts.declaredLength > maxBytes) {
    await opts.reader.cancel().catch(() => {})
    return { ok: false, overCap: true, reason: `pdf over ${maxBytes} byte cap (declared ${opts.declaredLength})` }
  }

  const proc = Bun.spawn([opts.pdftotextPath, '-enc', 'UTF-8', '-nopgbrk', '-', '-'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })

  // Idle watchdog, armed from the moment the process spawns and reset by every unit of
  // progress this call can observe (a chunk read off the caller's body, a chunk written to
  // pdftotext's stdin, a chunk read off its stdout) — see `PDF_HANG_GUARD_MS`'s doc comment for
  // why this replaced a guard that only armed after the whole body was already piped in.
  const watchdog = createIdleWatchdog(idleMs)
  let idleFired = false
  watchdog.signal.addEventListener('abort', () => {
    idleFired = true
    try {
      proc.kill('SIGKILL')
    } catch {
      // already gone
    }
  })
  watchdog.arm()

  const stdoutPromise = readCapped(proc.stdout, maxOutputBytes, { onChunk: watchdog.arm, idleSignal: watchdog.signal })
  const stderrPromise = readCapped(proc.stderr, 8_192, { idleSignal: watchdog.signal }).then((r) => r.text)

  let bytes = 0
  let overCap = false
  const writer = proc.stdin
  try {
    if (opts.head && opts.head.byteLength > 0) {
      bytes += opts.head.byteLength
      if (bytes > maxBytes) overCap = true
      else {
        await withIdle(Promise.resolve(writer.write(opts.head)), watchdog.signal)
        watchdog.arm()
      }
    }
    if (!overCap) {
      for (;;) {
        const { done, value } = await withIdle(opts.reader.read(), watchdog.signal)
        watchdog.arm()
        if (done || !value) break
        bytes += value.byteLength
        if (bytes > maxBytes) {
          overCap = true
          await opts.reader.cancel().catch(() => {})
          break
        }
        await withIdle(Promise.resolve(writer.write(value)), watchdog.signal)
        watchdog.arm()
      }
    } else {
      await opts.reader.cancel().catch(() => {})
    }
  } catch (err) {
    watchdog.clear()
    try {
      proc.kill('SIGKILL')
    } catch {
      // already gone
    }
    await opts.reader.cancel().catch(() => {})
    await stdoutPromise.catch(() => {})
    await stderrPromise.catch(() => {})
    if (idleFired || err instanceof PdfIdleError) {
      return { ok: false, overCap: false, reason: `pdftotext idle for ${idleMs}ms` }
    }
    return { ok: false, overCap: false, reason: `pdf stream error: ${String(err)}` }
  }

  try {
    await withIdle(Promise.resolve(writer.end()), watchdog.signal)
  } catch {
    // A pdftotext that already died (killed above, or exited early on bad input) closes its
    // stdin pipe from its side — ending an already-closed sink throws and carries no new
    // information here, so it is swallowed rather than surfaced as this call's own failure. An
    // idle-aborted `end()` swallows the same way: `idleFired` (or the final check below) is
    // what reports it.
  }

  if (overCap) {
    watchdog.clear()
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
  watchdog.clear()

  if (idleFired) {
    return { ok: false, overCap: false, reason: `pdftotext idle for ${idleMs}ms` }
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
