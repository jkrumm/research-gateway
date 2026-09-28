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
import { createIdleWatchdog } from '../lib/idle-watchdog.js'
import { pdfExtractionSemaphore } from './pdf-semaphore.js'
import { mapPdftotextResult, MAX_PDFTOTEXT_OUTPUT_BYTES } from './pdf-extract.js'
import type { PdfExtractResult } from './pdf-extract.js'

// An idle watchdog, not a flat wall-clock kill — mirrors YTDLP_TIMEOUT_MS's ROLE (a hang
// guard on one subprocess) but not its shape. pdftotext is a CPU-bound parse with no network
// wait, so a genuinely large document that is still actively producing output must never be
// punished for taking longer than some fixed ceiling; only real SILENCE — no bytes on stdout
// or stderr since the process spawned, or since the last chunk — means it is wedged (a PDF
// crafted to make poppler's layout pass thrash). This is the liveness rule rules/agent-limits.md
// allows for a subprocess: no output for N minutes/seconds, never a flat total-runtime cap.
const PDFTOTEXT_IDLE_MS = 60_000

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

// Thrown internally when the idle watchdog aborts while a read here is mid-await — never
// escapes `extractPdfText`, which always translates it into the honest "no output" result.
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

// Reads a stream up to `capBytes`, arming `watchdog` on every chunk so IDLE silence — not
// total size — is what can kill the read, and keeping (not discarding) whatever text was
// captured before a cap-crossing or an idle abort. Deliberately local rather than reusing
// lib/bounded-read.ts's shared reader: that module has no idle-signal hook, and adding one
// there would change every other caller's timing semantics for a need only this spawn
// wrapper has.
async function readIdleCapped(
  stream: ReadableStream<Uint8Array> | null,
  capBytes: number,
  watchdog: ReturnType<typeof createIdleWatchdog>,
): Promise<{ text: string; truncated: boolean }> {
  if (!stream) return { text: '', truncated: false }
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let bytes = 0
  let truncated = false
  try {
    for (;;) {
      const { done, value } = await withIdle(reader.read(), watchdog.signal)
      if (done || !value) break
      watchdog.arm()
      if (truncated) {
        bytes += value.byteLength
        continue
      }
      const room = capBytes - bytes
      if (value.byteLength <= room) {
        bytes += value.byteLength
        text += decoder.decode(value, { stream: true })
        continue
      }
      // This chunk crosses the cap — keep the part that still fits rather than discarding the
      // whole chunk, so a cap that lands mid-write still returns real (if incomplete) text.
      truncated = true
      bytes += value.byteLength
      if (room > 0) text += decoder.decode(value.subarray(0, room), { stream: true })
    }
  } catch {
    // An idle-aborted read, or the stream erroring because the process was just SIGKILLed —
    // either way this returns what was captured so far, marked truncated, rather than
    // rejecting: every call site below relies on this function never throwing.
    return { text, truncated: true }
  } finally {
    reader.releaseLock()
  }
  if (!truncated) text += decoder.decode()
  return { text, truncated }
}

export async function extractPdfText(bytes: Uint8Array, opts?: { jobId?: string }): Promise<PdfExtractResult> {
  const jobId = opts?.jobId ?? '-'
  let dir: string | null = null
  // Bounded process-wide: nothing else caps how many pdftotext subprocesses run at once
  // across every job's worker fan-out (pdf-semaphore.ts's header). A waiter here just WAITS —
  // no timeout, no rejection — same reasoning as the agent loop's own lack of a step/turn/
  // wall-clock ceiling (rules/agent-limits.md).
  await pdfExtractionSemaphore.acquire()
  try {
    dir = await mkdtemp(join(tmpdir(), PDF_TMP_PREFIX))
    const inPath = join(dir, 'in.pdf')
    await writeFile(inPath, bytes)

    // DEFAULT layout mode, deliberately not `-layout`: MEASURED against three real two-column
    // papers (AMS MWR-D-21-0150.1, Copernicus GMD doi:10.5194/gmd-19-4703-2026, arXiv:2309.04452)
    // — `-layout` interleaves the two columns onto the same line on all three, corrupting most
    // of the prose; the default mode keeps correct reading order, auto-dehyphenates, and renders
    // ligatures cleanly, at the cost of collapsed tables (an accepted limitation — a paper's
    // prose is what a worker cites, not its tables).
    const proc = Bun.spawn([env.PDFTOTEXT_PATH, '-enc', 'UTF-8', inPath, '-'], {
      stdout: 'pipe',
      stderr: 'pipe',
      killSignal: 'SIGKILL',
      // pdftotext parses attacker-controlled bytes (any page a model cites) — it must not
      // inherit this process's full environment (API keys, secrets-run's injected vars).
      // PATH is the one thing it genuinely needs (poppler's own dependent tools); LANG=C.UTF-8
      // keeps output encoding locale-independent rather than falling back to the parent's.
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', LANG: 'C.UTF-8' },
    })

    // Armed from the moment the process spawns, reset by every unit of progress this call can
    // observe (a chunk on stdout, a chunk on stderr) — replaces the old flat
    // `timeout: PDFTOTEXT_TIMEOUT_MS` kill, which fired on total runtime even while pdftotext
    // was actively producing output on a large-but-healthy document.
    const watchdog = createIdleWatchdog(PDFTOTEXT_IDLE_MS)
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

    const [stdoutResult, stderrResult] = await Promise.all([
      readIdleCapped(proc.stdout, MAX_PDFTOTEXT_OUTPUT_BYTES, watchdog),
      readIdleCapped(proc.stderr, MAX_PDFTOTEXT_OUTPUT_BYTES, watchdog),
    ])
    const code = await proc.exited
    watchdog.clear()

    const result = mapPdftotextResult({
      // `idleFired` takes precedence over `proc.signalCode`: the watchdog is the only thing
      // that ever calls `proc.kill()` in this function, so any signalCode it produced IS the
      // idle kill, but reading `idleFired` directly is honest even in the (untested) case of
      // an external kill this function did not cause.
      signalCode: idleFired ? 'SIGKILL' : proc.signalCode,
      code,
      stdout: stdoutResult.text,
      stderr: stderrResult.text,
      idleMs: PDFTOTEXT_IDLE_MS,
      stdoutTruncated: stdoutResult.truncated,
    })
    if (!result.ok) log('tool.pdf', { jobId, ok: false, error: result.error })
    else if (result.truncated) log('tool.pdf', { jobId, ok: true, truncated: true, chars: result.text.length })
    return result
  } catch (err) {
    // ENOENT (pdftotext missing from PATH) lands here alongside any other spawn/fs failure —
    // the chain falls through to Tavily Extract exactly as if the step had produced no text.
    log('tool.pdf', { jobId, ok: false, error: String(err) })
    return { ok: false, text: '', error: String(err) }
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
    pdfExtractionSemaphore.release()
  }
}
