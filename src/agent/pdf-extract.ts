// Pure pieces of the PDF-extraction step, kept env/log-free so they are unit-testable without
// booting env.ts — same convention as youtube-captions.ts vs ytdlp.ts (the spawn wrapper,
// pdf.ts, imports env for PDFTOTEXT_PATH and is not itself unit-tested for the same reason
// ytdlp.ts isn't).

import { normalizeText } from './extract.js'

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
}): PdfExtractResult {
  const { signalCode, code, stdout, stderr, idleMs, stdoutTruncated = false } = args

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
  return { ok: true, text, truncated: stdoutTruncated }
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
