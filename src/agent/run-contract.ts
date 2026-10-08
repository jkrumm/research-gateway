// The public shape of `runResearch` (run.ts), kept in an env-free module so job-runner-core.ts
// can type its injected `runResearch` against the same contract without pulling in run.ts's
// env/LLM import chain. Type-only imports throughout — nothing here is emitted at runtime.
import type { UsageStats } from '../lib/usage.js'
import type { ResearchCheckpoint } from './checkpoint.js'
import type { Depth, JobProgress, ResearchReport } from './schema.js'

// Combined job usage handed to onUsage: the flat total plus the per-model split, since
// the lead model (plan + synthesis) and worker model (fan-out) are billed separately.
export interface JobUsage extends UsageStats {
  lead: UsageStats
  worker: UsageStats
}

export interface ResearchRunInput {
  query: string
  context?: string | undefined
  depth?: Depth
  jobId?: string
  // Job-level cancel. Every LLM call's idle watchdog follows it (so the in-flight request
  // aborts at once), and the phase boundaries in run.ts re-check it: plan, worker, synthesis and
  // consistency all degrade instead of throwing, so without these checks an aborted job would
  // fall through to the fallback plan / assembled report and "finish".
  signal?: AbortSignal | undefined
  // Live phase for status reads (job-store.ts holds the latest). Worker counts are cumulative
  // across rounds and the retry, so a caller sees the job's whole fan-out, not one round's.
  onProgress?: ((progress: JobProgress) => void) | undefined
}

export interface ResearchRunOpts {
  checkpoint?: ResearchCheckpoint | null
  onCheckpoint?: (checkpoint: ResearchCheckpoint) => void
  /**
   * True once this process no longer owns the job's lease (job-store.ts's `ownsLease`) —
   * checked at every round/retry/synthesis boundary (rounds.ts's `runRounds`, plus once more
   * in run.ts before synthesis), and a positive check aborts the run with `FencedError` rather
   * than continuing to spend LLM/pdftotext work a fenced-off adopter will discard anyway.
   * Defaults to "never fenced", which is what every caller outside run-job.ts's live lease
   * machinery (tests, scripts/smoke.ts) wants.
   */
  isFenced?: () => boolean
}

export type RunResearchFn = (
  input: ResearchRunInput,
  onUsage?: (stats: JobUsage) => void,
  opts?: ResearchRunOpts,
) => Promise<ResearchReport>
