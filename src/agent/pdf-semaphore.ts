// A process-wide cap on concurrent `pdftotext` subprocesses. Nothing else bounds them across
// jobs x worker fan-out — every worker of every concurrent job that reads a PDF spawns its own,
// and each one costs real RSS (measured 12-22 MB on real papers, pdf.ts's header) against a
// shared, memory-limited container. FIFO, and a waiter simply WAITS for a slot rather than
// being rejected or timed out: unlike `lib/semaphore.ts`'s `queueTimeoutMs` variant (built for
// a caller with a real deadline — the sidecar's render budget, yt-dlp's rate limit), there is no
// budget to protect a queued pdftotext call against — the agent loop has no step/turn/wall-clock
// ceiling (~/.claude/rules/agent-limits.md), so the only thing worth bounding here is how many
// may run AT ONCE.
//
// Pure and dependency-free, same convention as `lib/semaphore.ts`, so it is unit-testable
// without booting the env-parsing chain.
export interface UnboundedSemaphore {
  /** Resolves once a slot is held. Never rejects and never times out — see the header above. */
  acquire: () => Promise<void>
  /** Give a held slot back. Must be called exactly once per successful acquire. */
  release: () => void
  readonly active: number
  readonly queued: number
}

export function createUnboundedSemaphore(limit: number): UnboundedSemaphore {
  let active = 0
  const waiting: Array<() => void> = []

  const acquire = (): Promise<void> => {
    if (active < limit) {
      active++
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      waiting.push(() => {
        active++
        resolve()
      })
    })
  }

  const release = (): void => {
    active--
    const next = waiting.shift()
    if (next) next()
  }

  return {
    acquire,
    release,
    get active() {
      return active
    },
    get queued() {
      return waiting.length
    },
  }
}

/** Measured pdftotext RSS on real papers: 12-22 MB (pdf.ts's header). 2 concurrent extractions is ample fan-out for that cost against a shared 2 GiB container. */
export const PDF_EXTRACTION_CONCURRENCY = 2

/** The one process-wide instance every `extractPdfText` call acquires/releases — see pdf.ts. */
export const pdfExtractionSemaphore: UnboundedSemaphore = createUnboundedSemaphore(PDF_EXTRACTION_CONCURRENCY)
