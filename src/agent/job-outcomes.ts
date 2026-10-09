import type { HumanOutcome } from './human-outcome.js'

// Per-job tally of child-stage outcomes that the `research.job` root span rolls up. Workers and
// the fetch chain run deep inside the fan-out; threading a counter through round/rounds/
// checkpoint for each one would touch every signature on the path, so they note into this
// process-wide map keyed by jobId instead (the same shape as tools.ts's search/render meters)
// and run.ts reads it once at the end. Env-free, no I/O: in-memory state, unit-tested directly.
//
// In-memory like those meters: a job resumed from a checkpoint counts only its post-resume
// portion, for EVERY key below. run.ts clears the entry when the job ends; the cap bounds the
// jobs that never get there (a crash path), evicting the oldest first.

export type JobOutcomeKey = 'worker.salvaged' | 'consistency.failed' | `human.${HumanOutcome}`

const MAX_TRACKED_JOBS = 200
const tallies = new Map<string, Map<JobOutcomeKey, number>>()

export function noteJobOutcome(jobId: string, key: JobOutcomeKey): void {
  if (jobId === '-') return
  let t = tallies.get(jobId)
  if (!t) {
    if (tallies.size >= MAX_TRACKED_JOBS) {
      const oldest = tallies.keys().next().value
      if (oldest !== undefined) tallies.delete(oldest)
    }
    t = new Map()
    tallies.set(jobId, t)
  }
  t.set(key, (t.get(key) ?? 0) + 1)
}

export function readJobOutcomes(jobId: string): Partial<Record<JobOutcomeKey, number>> {
  return Object.fromEntries(tallies.get(jobId) ?? [])
}

export function clearJobOutcomes(jobId: string): void {
  tallies.delete(jobId)
}
