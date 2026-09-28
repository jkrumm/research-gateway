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
import { mapPdftotextResult, readIdleCapped, MAX_PDFTOTEXT_OUTPUT_BYTES } from './pdf-extract.js'
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

export async function extractPdfText(bytes: Uint8Array, opts?: { jobId?: string; signal?: AbortSignal }): Promise<PdfExtractResult> {
  const jobId = opts?.jobId ?? '-'
  let dir: string | null = null
  // Bounded process-wide: nothing else caps how many pdftotext subprocesses run at once
  // across every job's worker fan-out (pdf-semaphore.ts's header). A waiter here just WAITS —
  // no timeout — same reasoning as the agent loop's own lack of a step/turn/wall-clock ceiling
  // (rules/agent-limits.md). It IS tied to `opts.signal` (the fetch chain's budget/cancel,
  // threaded in from fetch-chain/origin.ts): a queued wait that outlives the chain it belongs
  // to aborts with it instead of sitting forever past the point anything is still listening
  // for its result.
  const gotSlot = await pdfExtractionSemaphore.acquire(opts?.signal)
  if (!gotSlot) {
    const error = 'aborted while waiting for a PDF extraction slot'
    log('tool.pdf', { jobId, ok: false, error })
    return { ok: false, text: '', error }
  }
  // Hoisted above the try so `watchdog.clear()` can run in an OUTER finally regardless of
  // which branch below returns or throws — idle-watchdog.ts requires clear() on every path or
  // its timer leaks for PDFTOTEXT_IDLE_MS past a call that already finished.
  const watchdog = createIdleWatchdog(PDFTOTEXT_IDLE_MS)
  // Hoisted so the outer `finally` can always remove it — once a slot is granted, the caller's
  // OWN abort (the fetch chain's budget/cancel) must kill the child immediately rather than sit
  // until the unrelated 60s idle watchdog eventually catches the now-abandoned process.
  let onCallerAbort: (() => void) | undefined
  try {
    // A slot was granted, but the caller may have aborted in the time it took to get here —
    // check before ever spawning pdftotext, so an already-cancelled fetch chain never starts a
    // subprocess it has no use for.
    if (opts?.signal?.aborted) {
      const error = 'aborted'
      log('tool.pdf', { jobId, ok: false, error })
      return { ok: false, text: '', error }
    }

    dir = await mkdtemp(join(tmpdir(), PDF_TMP_PREFIX))
    const inPath = join(dir, 'in.pdf')
    await writeFile(inPath, bytes)

    if (opts?.signal?.aborted) {
      const error = 'aborted'
      log('tool.pdf', { jobId, ok: false, error })
      return { ok: false, text: '', error }
    }

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

    const killChild = (): void => {
      try {
        proc.kill('SIGKILL')
      } catch {
        // already gone
      }
    }

    // Registered the INSTANT the child exists, before any other setup below (the watchdog
    // listener, the reads) — a caller abort landing in the gap between spawn and the rest of
    // this function must still kill the child rather than run unbounded until the unrelated
    // 60s idle watchdog eventually catches it. Checked again right after registering: an
    // already-aborted signal never fires its `abort` event for a listener added after the
    // fact, so a signal that aborted in the instant between spawn and this line would
    // otherwise leave the child running forever.
    onCallerAbort = killChild
    opts?.signal?.addEventListener('abort', onCallerAbort, { once: true })
    if (opts?.signal?.aborted) {
      killChild()
      const error = 'aborted'
      log('tool.pdf', { jobId, ok: false, error })
      return { ok: false, text: '', error }
    }

    // Armed from the moment the process spawns, reset by every unit of progress this call can
    // observe (a chunk on stdout, a chunk on stderr) — replaces the old flat
    // `timeout: PDFTOTEXT_TIMEOUT_MS` kill, which fired on total runtime even while pdftotext
    // was actively producing output on a large-but-healthy document.
    let idleFired = false
    watchdog.signal.addEventListener('abort', () => {
      idleFired = true
      killChild()
    })
    watchdog.arm()

    // A byte-cap truncation on either stream means the child has no more use — its output past
    // the cap is discarded either way — so it is killed the moment `readIdleCapped` reports the
    // `'cap'` outcome, rather than left to keep writing into a pipe nothing is draining (which
    // would otherwise block until the 60s idle watchdog eventually caught it). Tracked per
    // stream by its OWN outcome — a stderr cap crossing kills the child same as a stdout one
    // would, but must never be read back as the STDOUT read having crossed its cap.
    const killIfCapped = <T extends { outcome: string }>(result: T): T => {
      if (result.outcome === 'cap') killChild()
      return result
    }

    const [stdoutResult, stderrResult] = await Promise.all([
      readIdleCapped(proc.stdout, MAX_PDFTOTEXT_OUTPUT_BYTES, watchdog, opts?.signal).then(killIfCapped),
      readIdleCapped(proc.stderr, MAX_PDFTOTEXT_OUTPUT_BYTES, watchdog, opts?.signal).then(killIfCapped),
    ])
    const code = await proc.exited

    const result = mapPdftotextResult({
      // `idleFired` takes precedence over `proc.signalCode` for the idle-kill message
      // specifically; `stdoutFailure` below takes precedence over BOTH when stdout's own read
      // resolved a specific reason (idle/aborted/error) — `signalCode` alone cannot tell an
      // idle kill apart from a caller abort or a stderr-only cap crossing, since `killChild()`
      // now fires on all three and every one of them leaves the same 'SIGKILL'.
      signalCode: idleFired ? 'SIGKILL' : proc.signalCode,
      code,
      stdout: stdoutResult.text,
      stderr: stderrResult.text,
      idleMs: PDFTOTEXT_IDLE_MS,
      stdoutTruncated: stdoutResult.outcome === 'cap',
      stdoutFailure: stdoutResult.outcome === 'idle' || stdoutResult.outcome === 'aborted' || stdoutResult.outcome === 'error' ? stdoutResult.outcome : undefined,
      stderrOverflow: stderrResult.outcome === 'cap',
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
    watchdog.clear()
    if (onCallerAbort) opts?.signal?.removeEventListener('abort', onCallerAbort)
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
    pdfExtractionSemaphore.release()
  }
}
