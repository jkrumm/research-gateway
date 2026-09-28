// Pure pieces of the PDF-extraction step, kept env/log-free so they are unit-testable without
// booting env.ts — same convention as youtube-captions.ts vs ytdlp.ts (the spawn wrapper,
// pdf.ts, imports env for PDFTOTEXT_PATH and is not itself unit-tested for the same reason
// ytdlp.ts isn't).

import { normalizeText, TEXT_CAP } from './extract.js'
import type { createIdleWatchdog } from '../lib/idle-watchdog.js'

// Above this, a PDF is rejected before pdftotext ever runs — a hang guard on input size, not
// a tuning default: an unbounded download of a pathological body is the failure this exists
// to prevent, before poppler (or anything else) ever sees the bytes.
export const MAX_PDF_BYTES = 40 * 1024 * 1024

// Bounds pdftotext's stdout/stderr the same way ytdlp.ts bounds yt-dlp's — far above any real
// document's output, guarding only against a pathological response.
export const MAX_PDFTOTEXT_OUTPUT_BYTES = 80 * 1024 * 1024

// Same boundary the readability/wayback steps use (fetch-chain.ts's MIN_USABLE_CHARS) — the
// line between "this document has a text layer" and "this is a scanned page with no text
// layer at all", which must FAIL this step rather than succeed with a handful of stray glyphs.
export const MIN_PDF_TEXT_CHARS = 200

// Discriminated on `ok` so a caller narrowing on it (fetch-chain/, pdf.ts) gets `error` as a
// guaranteed string on the failure branch — matches html-parse.ts's ParseResponse shape.
// `truncated` on the ok branch (previously discarded at the pdf.ts call site — a silent
// success) is the honest signal that MAX_PDFTOTEXT_OUTPUT_BYTES cut pdftotext's OWN output
// while it was still writing: a real, complete extraction that ran long, not a failure — but
// the caller MUST see it is incomplete rather than treat it as the whole paper.
export type PdfExtractResult = { ok: true; text: string; truncated: boolean } | { ok: false; text: string; error: string }

/**
 * Maps a finished `pdftotext` spawn (exit code, kill signal, both streams) to a step result.
 * Factored out of pdf.ts's `extractPdfText` so the mapping is testable without spawning a
 * process or importing env.ts.
 */
export function mapPdftotextResult(args: {
  // `signalCode`, not Bun's `proc.killed` — measured true on Bun 1.3/1.4 for both a SIGKILL
  // and a clean fast exit alike (the same trap ytdlp.ts's runYtdlp documents). signalCode is
  // null on any exit the process chose for itself and 'SIGKILL' only when the idle watchdog
  // fired (pdf.ts) — there is no other path that kills this process.
  signalCode: string | null
  code: number
  stdout: string
  stderr: string
  /** The idle watchdog's no-progress window, for the `signalCode` branch's message. */
  idleMs: number
  /** Whether MAX_PDFTOTEXT_OUTPUT_BYTES cut stdout while pdftotext was still writing — see the `PdfExtractResult` header above. Defaults false for callers (existing tests) that never truncate. */
  stdoutTruncated?: boolean
  /**
   * Non-`'cap'`/`'complete'` outcome for the STDOUT read specifically (`readIdleCapped`'s
   * `outcome`, pdf.ts) — takes precedence over `signalCode`-based inference below because it is
   * the DIRECT reason stdout stopped, where `signalCode` is only ever 'SIGKILL' regardless of
   * WHICH of idle/caller-abort/a different stream's cap crossing caused the kill. Without this,
   * a caller abort or a stderr-only cap crossing (which also kills the child, and so also
   * leaves `signalCode: 'SIGKILL'`) would fall through to the generic idle-kill message below,
   * or worse — if it also happened to satisfy `stdoutTruncated` — be reported as a success.
   */
  stdoutFailure?: 'idle' | 'aborted' | 'error' | undefined
  /**
   * True when MAX_PDFTOTEXT_OUTPUT_BYTES cut STDERR, not stdout (`readIdleCapped`'s `outcome`
   * on the stderr read, pdf.ts) — pdf.ts kills the child the moment either stream crosses its
   * cap, so a stderr-only overflow still ends the process. Defaults false for callers (existing
   * tests) that never overflow stderr.
   */
  stderrOverflow?: boolean
}): PdfExtractResult {
  const { signalCode, code, stdout, stderr, idleMs, stdoutTruncated = false, stdoutFailure, stderrOverflow = false } = args

  // Truncation wins over everything below: crossing MAX_PDFTOTEXT_OUTPUT_BYTES cancels the
  // reader (readIdleCapped) and pdf.ts then kills the (now-useless) child explicitly — which
  // means `signalCode`/`code` on THIS exit reflect that kill, not a real failure. A byte-capped
  // extraction is a complete, honest partial result and must report `ok: true, truncated: true`
  // even though the process died by signal.
  // The usable-text floor still applies: megabytes of whitespace or glyph junk normalise to
  // almost nothing, and that is the scanned-PDF miss below (fall through to Tavily's OCR), not a
  // truncated success.
  if (stdoutTruncated) {
    const capped = normalizeText(stdout)
    if (capped.length < MIN_PDF_TEXT_CHARS) {
      return { ok: false, text: '', error: `thin (${capped.length} chars) after the output cap — likely a scanned/image PDF` }
    }
    return { ok: true, text: capped, truncated: true }
  }
  if (stdoutFailure === 'idle') {
    return { ok: false, text: '', error: `pdftotext idle for ${idleMs}ms and was killed` }
  }
  if (stdoutFailure === 'aborted') {
    return { ok: false, text: '', error: 'aborted' }
  }
  if (stdoutFailure === 'error') {
    return { ok: false, text: '', error: 'pdftotext stdout read failed' }
  }
  // A stderr-only cap crossing kills the child same as any other cap-kill — but ONLY when the
  // kill actually cut off a still-running process: `signalCode` set means that, and means
  // stdout cannot be trusted complete even though its own read reported 'complete' (that
  // outcome only means the pipe closed, which a SIGKILL also causes). When the process had
  // already exited on its own (`signalCode` null — pdf.ts's `killChild()` was a no-op on an
  // already-dead process), stdout genuinely finished before stderr's cap ever mattered, and
  // this falls through to be judged on its own merits below instead of being failed here.
  if (stderrOverflow && signalCode) {
    return { ok: false, text: '', error: 'pdftotext stderr overflow' }
  }
  if (signalCode) {
    return { ok: false, text: '', error: `pdftotext produced no output for ${idleMs}ms and was killed` }
  }
  if (code !== 0) {
    const reason = stderr.split('\n').find((l) => l.trim().length > 0)?.trim() ?? `pdftotext exited ${code}`
    return { ok: false, text: '', error: reason }
  }

  const text = normalizeText(stdout)
  if (text.length < MIN_PDF_TEXT_CHARS) {
    // A scanned PDF with no text layer — poppler exits 0 with (near-)empty output. This is a
    // miss, not an error: the chain falls through to Tavily Extract, which OCRs server-side.
    return { ok: false, text: '', error: `thin (${text.length} chars) — likely a scanned/image PDF` }
  }
  return { ok: true, text, truncated: false }
}

// Mirrors extract.ts's `capText` notice — an honest, actionable marker rather than a bare
// `[truncated]` flag, worded for what actually happened HERE: pdftotext's OUTPUT was cut at
// the byte cap while it was still being read, not the source PDF itself, so there is no
// total-length figure to report the way `capText`'s does (the cap stopped the read before the
// true length was ever known). Exported so both pdf.ts's own truncation and the fetch-chain's
// consumption of it stay worded identically.
export function pdfTruncationNotice(maxOutputBytes: number = MAX_PDFTOTEXT_OUTPUT_BYTES): string {
  return `\n\n[truncated: this PDF's extracted text exceeded pdftotext's ${maxOutputBytes}-byte output cap and was cut short. The remainder was not included — if the information you need is not above, it may be further down this paper.]`
}

/**
 * The text a successful PDF extraction hands the worker: `pdfTruncationNotice()` appended
 * when `truncated`, capped so the notice itself always survives. A truncated pdftotext output
 * can be up to MAX_PDFTOTEXT_OUTPUT_BYTES (80 MB) — far longer than TEXT_CAP (80k chars) — so
 * appending the notice AFTER the full text and letting a later `capText(text, TEXT_CAP)` run
 * over the combined string sliced the notice off the end entirely; it never reached the
 * worker. Capping HERE, with room reserved for the notice before it is appended, means the
 * text a caller (fetch-chain/origin.ts) hands to `ctx.done` is already at or under TEXT_CAP, so
 * `capText`'s own cap downstream is a no-op.
 */
export function finalizePdfText(text: string, truncated: boolean): string {
  if (!truncated) return text
  const notice = pdfTruncationNotice()
  return `${text.slice(0, Math.max(0, TEXT_CAP - notice.length))}${notice}`
}

// Thrown internally when the idle watchdog aborts while a read is mid-await — never escapes
// `readIdleCapped`, which always translates it into the honest `{ text, truncated: true }`.
class PdfIdleError extends Error {}

// Races `promise` against the idle watchdog's abort signal, so a stall on stdout OR stderr
// unblocks the read the moment the watchdog fires, rather than leaving it hung on a promise
// that only resolves once the (already-killed) process closes its pipes.
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

function concatText(chunks: Uint8Array[], total: number): string {
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

// Why a stop happened. Only `cap` is a complete, honest partial extraction a caller may report
// as a SUCCESS (`truncated: true`) — `idle`, `aborted` and `error` all mean the read produced
// no trustworthy text and MUST be reported as a failure, never silently folded into `truncated`
// (see `ReadIdleCappedResult`'s header — this is the distinction pdf.ts's `mapPdftotextResult`
// call depends on to avoid reporting a wedged or cancelled extraction as a success).
export type PdfReadOutcome = 'complete' | 'cap' | 'idle' | 'aborted' | 'error'

export interface ReadIdleCappedResult {
  text: string
  /** True ONLY for `outcome: 'cap'` — kept as its own field because pdf.ts/mapPdftotextResult
   * already key off it directly; derive it from `outcome`, never set independently. */
  truncated: boolean
  outcome: PdfReadOutcome
  /** Set only on `outcome: 'error'` — the underlying stream error's message. */
  error?: string
}

/**
 * Reads a stream up to `capBytes`, arming `watchdog` on every chunk so IDLE silence — not
 * total size — is what can kill the read, and keeping (not discarding) whatever text was
 * captured before a cap-crossing, an idle abort, or a caller abort. Deliberately local rather
 * than reusing lib/bounded-read.ts's shared reader: that module has no idle-signal hook, and
 * adding one there would change every other caller's timing semantics for a need only this
 * spawn wrapper has. Mirrors bounded-read.ts's `readBounded` on two points: raw chunks are
 * buffered and decoded once at the end (never decode-and-concat per chunk), and
 * `reader.cancel()` is always awaited BEFORE the reader's lock is released — releasing a lock
 * while a `read()` is still pending throws a TypeError that would otherwise replace this
 * function's designed return with an uncaught throw.
 *
 * `callerSignal` (pdf.ts's `opts.signal`, the fetch chain's own budget/cancel) races alongside
 * `watchdog.signal` via `AbortSignal.any` so a caller abort unblocks a pending read immediately
 * instead of waiting for the killed child's pipe to close on its own — and so the catch below
 * can tell WHICH signal fired and report the right `outcome`.
 */
export async function readIdleCapped(
  stream: ReadableStream<Uint8Array> | null,
  capBytes: number,
  watchdog: ReturnType<typeof createIdleWatchdog>,
  callerSignal?: AbortSignal,
): Promise<ReadIdleCappedResult> {
  if (!stream) return { text: '', truncated: false, outcome: 'complete' }
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let outcome: PdfReadOutcome = 'complete'
  let errorMessage: string | undefined
  const abortSignal = callerSignal ? AbortSignal.any([watchdog.signal, callerSignal]) : watchdog.signal
  try {
    for (;;) {
      const { done, value } = await withIdle(reader.read(), abortSignal)
      if (done) break
      // A zero-length chunk (or a `done: false` read with no value at all — not a documented
      // shape, but not worth trusting either) is not progress: arming here would let a stream
      // that yields empty chunks forever, without ever setting `done`, re-arm the idle watchdog
      // on every iteration and starve it of the chance to ever fire.
      if (!value || value.byteLength === 0) continue
      watchdog.arm()
      const room = capBytes - total
      if (value.byteLength <= room) {
        chunks.push(value)
        total += value.byteLength
        continue
      }
      // This chunk crosses the cap — keep the part that still fits rather than discarding the
      // whole chunk, so a cap that lands mid-write still returns real (if incomplete) text.
      // Cancel and stop here — there is no reason to keep draining a stream whose cap is
      // already known to be exceeded (no "dead" byte counter kept past this point). The ONLY
      // outcome that reports `truncated: true` — every other early stop below is a failure.
      outcome = 'cap'
      if (room > 0) {
        chunks.push(value.subarray(0, room))
        total += room
      }
      await reader.cancel().catch(() => {})
      break
    }
  } catch (err) {
    // `cancel()` settles the still-pending `read()` before `finally` releases the lock (see
    // the header comment). `withIdle` only ever rejects with `PdfIdleError` for an abort or
    // the ORIGINAL error for anything else (a genuine stream error, e.g. the pipe erroring
    // because the process was just SIGKILLed for a reason neither signal above caused) — that
    // distinction, not a blanket "any abnormal stop is a truncated success", is what decides
    // `outcome` here.
    await reader.cancel().catch(() => {})
    if (err instanceof PdfIdleError) {
      outcome = watchdog.signal.aborted ? 'idle' : 'aborted'
    } else {
      outcome = 'error'
      errorMessage = err instanceof Error ? err.message : String(err)
    }
  } finally {
    reader.releaseLock()
  }
  return {
    text: concatText(chunks, total),
    truncated: outcome === 'cap',
    outcome,
    ...(errorMessage !== undefined ? { error: errorMessage } : {}),
  }
}
