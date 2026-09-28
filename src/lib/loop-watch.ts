import { log } from './log.js'

// The one in-process warning an event-loop stall leaves behind.
//
// 2026-09-20: a job was reaped as `job.reaped_on_read` while its process was still alive —
// the 90s staleness window (job-store.ts, six missed 15s heartbeats) tripped on a LIVE loop,
// and the same starvation pushed the idle watchdog past its budget so live work was aborted
// as `worker.failed` ("idle: no step/tool activity"). Nothing in the process could say why:
// research-gateway is one Bun process — a single Elysia listener with every job
// fire-and-forget async on that one loop — and the fetch chain parses pages synchronously
// (linkedom + Readability, fetch-chain.ts), so one oversized page blocks heartbeats, watchdog
// timers and the HTTP listener together. The fully-developed shape was already measured on
// 2026-08-06 (docs/measurements.md): CPU 222%, NOT OOM-killed, listener dead on 7780 while
// jobs kept running.
//
// The measurement is timer drift: an interval that expects SAMPLE_INTERVAL_MS and fires N ms
// late was blocked for those N ms. Single-digit ms under a healthy loop (timer coalescing),
// so the 1s threshold sits far above the noise floor, and one window bounds nothing — a 30s
// stall between ticks reads as a ~25s lag on the next fire. Granularity worth knowing: a
// block is visible only when it straddles a deadline, so a 200ms stall inside a 5s window
// usually reads as nothing — but sustained blocking (the incident shape: a parse holding the
// loop while heartbeats lapse) always straddles several, which is what this watches for.
//
// Unlike memory-watch there is NO load-shedding callback, on purpose: shedding admission
// because the loop is slow punishes the very jobs the stall is already hurting.
// `process.loop_lag` makes the stall visible and measurable (which consumer dominates, how
// long real stalls run); the structural fix is the byte bound in fetch-chain.ts's
// `readBoundedBody` plus PARSE_INPUT_CAP, which stop an oversized body being downloaded,
// decoded and parsed on this loop in the first place. If this still fires with those in
// place, the next step is offloading the parse to a Bun Worker — which must keep the site
// adapters inline, since a parsed document cannot cross a Worker boundary.
//
// Untested like memory-watch.ts: it imports log.js → env.js, and anything importing env is
// untested by design (see extract.ts's header). No env vars of its own — always on.

const SAMPLE_INTERVAL_MS = 5_000
const LAG_THRESHOLD_MS = 1_000
// How many samples `loopSnapshot` reports a peak over. 12 samples is a minute: longer than any
// monitor's poll interval, short enough that a peak still means "recently". See LoopSnapshot.
const WINDOW_SAMPLES = 12

let lastLagMs: number | null = null
let started = false
// The most recent lags, oldest first — the window `peakMs` is taken over. Bounded at
// WINDOW_SAMPLES, so its memory is a constant however long the process runs.
const samples: number[] = []

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

// Read on demand by `/health`. Null before the first interval has elapsed (the first seconds
// of a boot have no sample yet), the same null shape `memorySnapshot` returns off-cgroup.
export function loopSnapshot(): LoopSnapshot {
  return {
    lastMs: lastLagMs,
    peakMs: samples.length > 0 ? Math.max(...samples) : null,
  }
}

export function startLoopWatch(): void {
  // Idempotent: index.ts calls this once at boot, but a second caller would add a second
  // interval — double the samples, double the log lines, and a `window` filled twice as fast
  // as the time it claims to cover.
  if (started) return
  started = true
  let last = performance.now()
  const timer = setInterval(() => {
    const now = performance.now()
    const lag = Math.max(0, now - last - SAMPLE_INTERVAL_MS)
    last = now
    lastLagMs = Math.round(lag)
    samples.push(lastLagMs)
    if (samples.length > WINDOW_SAMPLES) samples.shift()
    if (lag >= LAG_THRESHOLD_MS) {
      log('process.loop_lag', { lagMs: lastLagMs, intervalMs: SAMPLE_INTERVAL_MS })
    }
  }, SAMPLE_INTERVAL_MS)
  // Unref'd like every other housekeeping timer here: it must never be what keeps the
  // process alive.
  timer.unref?.()
}
