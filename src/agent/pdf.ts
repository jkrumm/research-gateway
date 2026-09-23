// PDF text extraction via poppler's pdftotext, spawned as a subprocess. Mirrors ytdlp.ts's
// spawn contract exactly: NEVER throw — an uncaught throw here would kill the worker that
// called it and lose every digest it had gathered, the same contract runFetchChain and every
// tool builder follows.
//
// pdftotext reads a FILE, not stdin: poppler needs random access into the PDF (xref table,
// page tree) that a pipe cannot provide, so the bytes are written to a temp file first
// (mkdtemp under os.tmpdir(), always removed in `finally`, on every path).
//
// Kept separate from pdf-extract.ts (env/log-free, same convention as youtube-captions.ts vs
// ytdlp.ts) so the pure bounding/mapping logic there is unit-testable without booting env.ts.

import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { env } from '../env.js'
import { log } from '../lib/log.js'
import { mapPdftotextResult, MAX_PDFTOTEXT_OUTPUT_BYTES } from './pdf-extract.js'
import type { PdfExtractResult } from './pdf-extract.js'
import { readCappedText } from './bounded-read.js'

// A process.exited hang guard, not a tuning default — mirrors YTDLP_TIMEOUT_MS's role.
// pdftotext is a CPU-bound parse with no network wait, so 60s is generous headroom over any
// real document (input is already capped at MAX_PDF_BYTES) while still bounding a
// pathological one (a PDF crafted to make poppler's layout pass thrash).
const PDFTOTEXT_TIMEOUT_MS = 60_000

const PDF_TMP_PREFIX = 'rg-pdf-'
const STALE_TMP_DIR_MS = 60 * 60 * 1000

// `finally` below removes each job's own dir on every path, but a hard kill (SIGKILL, an OOM
// reap) skips `finally` entirely and leaves it behind. Best-effort, once at module load — not
// a substitute for the per-call cleanup, just a floor under it.
async function sweepStalePdfTmpDirs(): Promise<void> {
  try {
    const base = tmpdir()
    const entries = await readdir(base)
    const now = Date.now()
    for (const entry of entries) {
      if (!entry.startsWith(PDF_TMP_PREFIX)) continue
      const path = join(base, entry)
      const info = await stat(path).catch(() => null)
      if (!info || !info.isDirectory()) continue
      if (now - info.mtimeMs < STALE_TMP_DIR_MS) continue
      await rm(path, { recursive: true, force: true }).catch(() => {})
    }
  } catch {
    // best-effort — a missing/unreadable tmpdir is not this module's problem to surface
  }
}

void sweepStalePdfTmpDirs()

export async function extractPdfText(bytes: Uint8Array, opts?: { jobId?: string }): Promise<PdfExtractResult> {
  const jobId = opts?.jobId ?? '-'
  let dir: string | null = null
  try {
    dir = await mkdtemp(join(tmpdir(), 'rg-pdf-'))
    const inPath = join(dir, 'in.pdf')
    await writeFile(inPath, bytes)

    const proc = Bun.spawn([env.PDFTOTEXT_PATH, '-enc', 'UTF-8', '-layout', inPath, '-'], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: PDFTOTEXT_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      // pdftotext parses attacker-controlled bytes (any page a model cites) — it must not
      // inherit this process's full environment (API keys, secrets-run's injected vars).
      // PATH is the one thing it genuinely needs (poppler's own dependent tools); LANG=C.UTF-8
      // keeps output encoding locale-independent rather than falling back to the parent's.
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', LANG: 'C.UTF-8' },
    })
    const [stdout, stderr] = await Promise.all([
      readCappedText(proc.stdout, MAX_PDFTOTEXT_OUTPUT_BYTES),
      readCappedText(proc.stderr, MAX_PDFTOTEXT_OUTPUT_BYTES),
    ])
    const code = await proc.exited

    const result = mapPdftotextResult({
      signalCode: proc.signalCode,
      code,
      stdout,
      stderr,
      timeoutMs: PDFTOTEXT_TIMEOUT_MS,
    })
    if (!result.ok) log('tool.pdf', { jobId, ok: false, error: result.error })
    return result
  } catch (err) {
    // ENOENT (pdftotext missing from PATH) lands here alongside any other spawn/fs failure —
    // the chain falls through to Tavily Extract exactly as if the step had produced no text.
    log('tool.pdf', { jobId, ok: false, error: String(err) })
    return { ok: false, text: '', error: String(err) }
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
