import type { UsageStats } from '../lib/usage.js'
import type { ConsistencyResolution } from './extract.js'
import type { Depth } from './schema.js'

// Env-free so the decision is unit-tested. A contradiction needs two statements to disagree:
// that takes at least two digests (parallel workers establishing facts independently) and a
// report long enough to hold two sections. Measured 2026-10-08 (149 passes): the pass cost a
// p50 of 29k output tokens / 138s to land ~230 chars of edits, and 'consistent' verdicts cost
// 21k tokens — so a pass that cannot find anything is pure latency. Since the Wave 8 deploy 7
// of 8 passes changed nothing, so the size/count floors are not enough: the pass also needs a
// concrete divergence signal (the same subject carrying a different number, date or version
// in two digests, `digest-divergence.ts`). No signal, no pass.
export const CONSISTENCY_MIN_REPORT_CHARS = 6_000

const CONSISTENCY_MIN_DIGESTS = 2

export type ConsistencySkip = 'quick-depth' | 'single-digest' | 'short-report' | 'no-divergence'

export function consistencySkipReason(args: {
  depth: Depth
  digestCount: number
  reportChars: number
  divergenceCount: number
}): ConsistencySkip | null {
  if (args.depth === 'quick') return 'quick-depth'
  if (args.digestCount < CONSISTENCY_MIN_DIGESTS) return 'single-digest'
  if (args.reportChars < CONSISTENCY_MIN_REPORT_CHARS) return 'short-report'
  if (args.divergenceCount === 0) return 'no-divergence'
  return null
}

// The review that changes nothing: the original report, no edits, no veto. Both ways a pass
// ends without a review — skipped by the gate above, or failed inside reviewConsistency —
// return this, so the two cannot drift apart on what "no-op" means.
export function noopConsistencyReview(
  report: string,
  usage: UsageStats,
): ConsistencyResolution & { usage: UsageStats } {
  return { report, corrected: false, appliedEdits: [], vetoed: false, usage }
}
