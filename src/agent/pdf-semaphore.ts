// A process-wide cap on concurrent `pdftotext` subprocesses. Nothing else bounds them across
// jobs x worker fan-out — every worker of every concurrent job that reads a PDF spawns its own,
// and each one costs real RSS (measured 12-22 MB on real papers, pdf.ts's header) against a
// shared, memory-limited container. FIFO, and a waiter simply WAITS for a slot rather than
// being rejected or timed out on its own: `lib/semaphore.ts`'s `createSemaphore` takes an
// OPTIONAL `queueTimeoutMs` for exactly this shape — omitted here, since there is no caller-side
// deadline to protect a queued pdftotext call against (the agent loop has no step/turn/
// wall-clock ceiling, ~/.claude/rules/agent-limits.md), only a cap on how many may run AT ONCE.
// A queued waiter still stops WAITING the moment the caller's own signal (pdf.ts threads the
// fetch chain's budget/cancel through `acquire(signal)`) aborts — it is the timeout half alone
// that is deliberately absent, not liveness.
//
// This used to be its own hand-copied `createUnboundedSemaphore` — collapsed into
// `lib/semaphore.ts`'s `createSemaphore` once `queueTimeoutMs` became optional there, so there
// is one semaphore implementation, not two.
import { createSemaphore } from '../lib/semaphore.js'
import type { Semaphore } from '../lib/semaphore.js'

export type { Semaphore } from '../lib/semaphore.js'

// 2 concurrent extractions is ample fan-out against the process's own MEMORY_LIMIT_MB
// watchdog (lib/memory-watch.ts) — pdftotext's real-world RSS is modest (single-digit to
// low-double-digit MB per invocation), so this bounds subprocess fan-out, not a measured cost.
// Exported so `/health`'s schema description (routes/health.ts) can name the real cap instead
// of a number hand-copied here that would silently go stale the next time this changes.
export const PDF_EXTRACTION_CONCURRENCY = 2

/** The one process-wide instance every `extractPdfText` call acquires/releases — see pdf.ts. */
export const pdfExtractionSemaphore: Semaphore = createSemaphore(PDF_EXTRACTION_CONCURRENCY)
