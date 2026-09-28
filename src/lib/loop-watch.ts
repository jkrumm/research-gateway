import { log } from './log.js'

// The one in-process warning an event-loop stall leaves behind.
//
// research-gateway is one Bun process — a single Elysia listener with every job fire-and-
// forget async on that one loop — and the fetch chain parses pages synchronously (linkedom +
// Readability, html-parse.ts's worker pool exists precisely to get that OFF this loop, but a
// big enough body still costs real time getting there). A sustained stall on this loop
// starves everything else sharing it: HTTP responses, job heartbeats, and every idle-watchdog
// timer this process runs — a live process can look dead to every one of them at once, with
// nothing in the process able to say why on its own.
//
// The measurement is timer drift: an interval that expects SAMPLE_INTERVAL_MS and fires N ms
// late was blocked for those N ms. Single-digit ms under a healthy loop (timer coalescing), so
// the 1s threshold sits far above the noise floor, and one window bounds nothing — a 30s stall
// between ticks reads as a ~25s lag on the next fire. Granularity worth knowing: a block is
// visible only when it straddles a deadline, so a 200ms stall inside a 5s window usually reads
// as nothing — but sustained blocking always straddles several, which is what this watches for.
//
// Unlike memory-watch there is NO load-shedding callback, on purpose: shedding admission
// because the loop is slow punishes the very jobs the stall is already hurting.
// `process.loop_lag` makes the stall visible and measurable (which consumer dominates, how
// long real stalls run) for `/health` and a keyword monitor to act on from outside the process.
//
// `log` → `otel.ts` → `env.ts`, so this file is untested-by-design the way memory-watch.ts is
// (extract.ts's header) EXCEPT for the pure tick math below, which `createLoopWatch` exposes
// as an injectable clock/scheduler specifically so that part does not have to wait on this
// file's own env-parsing chain — see loop-watch.test.ts.

const SAMPLE_INTERVAL_MS = 5_000
const LAG_THRESHOLD_MS = 1_000
// How many samples `loopSnapshot` reports a peak over. 12 samples is a minute: longer than any
// monitor's poll interval, short enough that a peak still means "recently". See LoopSnapshot.
const WINDOW_SAMPLES = 12

export interface LoopSnapshot {
  /** The most recent sample — how late the last interval fired. Null before the first one. */
  lastMs: number | null
  /**
   * The worst lag in the last WINDOW_SAMPLES samples, so a single quiet sample cannot erase a
   * stall from `/health`. The latest sample alone was misleading in exactly the case that
   * matters: a monitor polls every 30-60s, so it usually samples a different tick than the one
   * the stall landed on, reads the 0 that followed, and concludes the loop was healthy.
   */
  peakMs: number | null
}

export interface LoopWatch {
  start: () => void
  snapshot: () => LoopSnapshot
}

// The two real-clock primitives `createLoopWatch` needs, named as their own interface so a
// test can hand in a fake `now`/`setInterval` pair without touching global timers — the same
// "inject the clock" shape idle-watchdog.ts's own tests rely on, applied one level up since
// this module owns the interval itself rather than a single timeout.
export interface LoopWatchClock {
  /** Monotonic time, matching `performance.now()`'s contract (ms, arbitrary epoch). */
  now: () => number
  /** `setInterval`-shaped scheduler. Returns an object with an optional `unref` so production
   * can still keep this from holding the process open, exactly like the real one. */
  setInterval: (callback: () => void, ms: number) => { unref?: () => void }
}

const realClock: LoopWatchClock = {
  now: () => performance.now(),
  setInterval: (callback, ms) => setInterval(callback, ms),
}

/**
 * Builds one loop-lag watch. `startLoopWatch`/`loopSnapshot` below are the ONE real instance
 * `index.ts` starts at boot, wired to `realClock` — everything a caller needs in production.
 * Exported separately so a test can build its own instance against a fake clock/scheduler and
 * observe `snapshot()` deterministically, without waiting on real `SAMPLE_INTERVAL_MS` ticks
 * or this module's own env-parsing import chain.
 */
export function createLoopWatch(opts?: {
  clock?: LoopWatchClock
  sampleIntervalMs?: number
  lagThresholdMs?: number
  windowSamples?: number
}): LoopWatch {
  const clock = opts?.clock ?? realClock
  const sampleIntervalMs = opts?.sampleIntervalMs ?? SAMPLE_INTERVAL_MS
  const lagThresholdMs = opts?.lagThresholdMs ?? LAG_THRESHOLD_MS
  const windowSamples = opts?.windowSamples ?? WINDOW_SAMPLES

  let lastLagMs: number | null = null
  let started = false
  // The most recent lags, oldest first — the window `peakMs` is taken over. Bounded at
  // `windowSamples`, so its memory is a constant however long the process runs.
  const samples: number[] = []

  const snapshot = (): LoopSnapshot => ({
    lastMs: lastLagMs,
    peakMs: samples.length > 0 ? Math.max(...samples) : null,
  })

  const start = (): void => {
    // Idempotent: index.ts calls this once at boot, but a second caller would add a second
    // interval — double the samples, double the log lines, and a `window` filled twice as
    // fast as the time it claims to cover.
    if (started) return
    started = true
    let last = clock.now()
    const timer = clock.setInterval(() => {
      const now = clock.now()
      const lag = Math.max(0, now - last - sampleIntervalMs)
      last = now
      lastLagMs = Math.round(lag)
      samples.push(lastLagMs)
      if (samples.length > windowSamples) samples.shift()
      if (lag >= lagThresholdMs) {
        log('process.loop_lag', { lagMs: lastLagMs, intervalMs: sampleIntervalMs })
      }
    }, sampleIntervalMs)
    // Unref'd like every other housekeeping timer here: it must never be what keeps the
    // process alive.
    timer.unref?.()
  }

  return { start, snapshot }
}

const defaultWatch = createLoopWatch()

/** Called once at boot (index.ts). */
export const startLoopWatch: () => void = defaultWatch.start

/** Read on demand by `/health`. Null before the first interval has elapsed. */
export const loopSnapshot: () => LoopSnapshot = defaultWatch.snapshot
