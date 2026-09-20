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
// long real stalls run); the structural fix is the parse-input cap in fetch-chain.ts, and if
// this still fires after it, the next step is offloading the parse to a Bun Worker — which
// must keep the site adapters inline, since a parsed document cannot cross a Worker boundary.
//
// Untested like memory-watch.ts: it imports log.js → env.js, and anything importing env is
// untested by design (see extract.ts's header). No env vars of its own — always on.

const SAMPLE_INTERVAL_MS = 5_000
const LAG_THRESHOLD_MS = 1_000

let lastLagMs: number | null = null

// Read on demand by `/health` — the most recent drift measurement, `null` before the first
// interval has elapsed (the first seconds of a boot have no sample yet), the same null
// shape `memorySnapshot` returns off-cgroup.
export function loopSnapshot(): number | null {
  return lastLagMs
}

export function startLoopWatch(): void {
  let last = performance.now()
  const timer = setInterval(() => {
    const now = performance.now()
    const lag = Math.max(0, now - last - SAMPLE_INTERVAL_MS)
    last = now
    lastLagMs = Math.round(lag)
    if (lag >= LAG_THRESHOLD_MS) {
      log('process.loop_lag', { lagMs: lastLagMs, intervalMs: SAMPLE_INTERVAL_MS })
    }
  }, SAMPLE_INTERVAL_MS)
  // Unref'd like every other housekeeping timer here: it must never be what keeps the
  // process alive.
  timer.unref?.()
}
