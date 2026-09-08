// The policy behind MCP `job_wait`: how long one call blocks, and when its loop stops.
//
// It used to stop after 50s and hand the caller a `stillRunning: true` to loop on. That cap was
// never a protocol requirement — it was a guess at "the MCP HTTP transport's ~60s first-byte
// budget" — and it cost a model turn every 50 seconds. Against the measured span record (deep:
// p50 366s, p95 1181s) a single deep job spent roughly 24 round trips doing nothing but asking
// again. What actually bounds a blocking call is two real things, and neither is a timer here:
//
//   1. The SSE keep-alive. `createMcpHandler` is configured with `responseMode: 'sse'`, so the
//      SDK upgrades the response to a stream before the tool body runs and writes a comment
//      frame every 15s (its `DEFAULT_SSE_KEEP_ALIVE_MS`). That is what keeps Bun's `idleTimeout`
//      (255s, its maximum) and any proxy idle timer from closing a long call underneath us.
//   2. The client's own wall-clock limit. Claude Code applies a per-server `timeout` from its
//      MCP entry, which is also the floor on its 5-minute HTTP idle timeout — progress
//      notifications do NOT extend that idle window, the keep-alive stream is what does.
//
// So the wait is unbounded BY DEFAULT and terminates on the only thing that always happens: the
// job reaching a terminal status. That is guaranteed independently of this file — a job is
// capped by its own summed phase timeouts (agent/depth.ts) and, failing that, reaped once its
// heartbeat goes stale (lib/job-store.ts). `maxWaitMs` stays available for a caller that wants a
// bounded peek, but nothing imposes one on its behalf.
//
// Pure and `env`-free so both rules are unit-testable — same convention as `admission.ts`.
import type { JobStatus } from '../agent/schema.js'

export const POLL_INTERVAL_MS = 2_000

// Below this a "wait" is just a status read with extra steps, and a caller passing 0 or a
// negative number almost certainly meant "don't wait", which is what `job_status` is for.
const MIN_WAIT_MS = 1_000

/**
 * Absolute time this call must stop blocking, or `null` for "until the job is terminal".
 * `undefined` in means unbounded — the default, and the whole point.
 */
export function waitDeadline(now: number, requestedMs?: number): number | null {
  if (requestedMs === undefined) return null
  return now + Math.max(requestedMs, MIN_WAIT_MS)
}

export function shouldKeepWaiting(args: {
  status: JobStatus
  now: number
  deadline: number | null
  aborted: boolean
}): boolean {
  if (args.status === 'done' || args.status === 'error') return false
  if (args.aborted) return false
  if (args.deadline !== null && args.now >= args.deadline) return false
  return true
}
