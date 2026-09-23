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

// Discriminated on `ok` so a caller narrowing on it (fetch-chain.ts, pdf.ts) gets `error` as a
// guaranteed string on the failure branch — matches html-parse.ts's ParseResponse shape.
export type PdfExtractResult = { ok: true; text: string } | { ok: false; text: string; error: string }

/**
 * Reads a stream up to `capBytes`, cancelling it (never buffering past the cap) rather than
 * reading fully and discarding — the point is to avoid downloading a pathological body end to
 * end before rejecting it. `truncated: true` means the caller should treat this as a miss, not
 * as `capBytes` worth of usable data.
 */
export async function readBoundedBytes(
  body: ReadableStream<Uint8Array> | null,
  capBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!body) return { bytes: new Uint8Array(0), truncated: false }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > capBytes) {
        await reader.cancel().catch(() => {})
        return { bytes: new Uint8Array(0), truncated: true }
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return { bytes, truncated: false }
}

/** Same cap-and-decode shape as ytdlp.ts's readCapped, duplicated rather than imported so this
 * module stays env-free (ytdlp.ts imports env.js at its top). */
export async function readCappedText(stream: ReadableStream<Uint8Array> | null, capBytes: number): Promise<string> {
  if (!stream) return ''
  const decoder = new TextDecoder()
  let text = ''
  let bytes = 0
  for await (const chunk of stream) {
    bytes += chunk.length
    if (bytes > capBytes) break
    text += decoder.decode(chunk, { stream: true })
  }
  return text + decoder.decode()
}

/**
 * Maps a finished `pdftotext` spawn (exit code, kill signal, both streams) to a step result.
 * Factored out of pdf.ts's `extractPdfText` so the mapping is testable without spawning a
 * process or importing env.ts.
 */
export function mapPdftotextResult(args: {
  // `signalCode`, not Bun's `proc.killed` — measured true on Bun 1.3/1.4 for both a SIGKILL
  // and a clean fast exit alike (the same trap ytdlp.ts's runYtdlp documents). signalCode is
  // null on any exit the process chose for itself and 'SIGKILL' only when the timeout fired.
  signalCode: string | null
  code: number
  stdout: string
  stderr: string
  timeoutMs: number
}): PdfExtractResult {
  const { signalCode, code, stdout, stderr, timeoutMs } = args

  if (signalCode) {
    return { ok: false, text: '', error: `pdftotext timed out after ${timeoutMs}ms` }
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
  return { ok: true, text }
}
