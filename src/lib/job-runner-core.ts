// The job-runner half of the lease/resume/drain state machine — `startResearchJob` and the
// adoption loop — factored out of run-job.ts the same way job-store-core.ts factored the store
// itself, so both are unit-testable against a `JobStore` built on `openJobDb(':memory:')`
// without booting `env.ts` or `agent/run.js`'s LLM import chain. `run-job.ts` is now a thin,
// env-wired instance of this factory; see job-store.test.ts for the scenarios this makes
// testable with injected FAKE `runResearch` functions (deferred promises, no LLM, no env).
import type { JobStore, Job } from './job-store-core.js'
import { HandedOffError, MAX_JOB_ATTEMPTS } from './job-store-core.js'
import { FencedError } from '../agent/fenced-error.js'
import { parseCheckpoint, serializeCheckpoint, type ResearchCheckpoint } from '../agent/checkpoint.js'
import type { Depth, JobProgress, ResearchReport } from '../agent/schema.js'
import type { UsageStats } from './usage.js'

// Mirrors `agent/run.ts`'s `JobUsage` — declared locally rather than imported so this module
// pulls in no part of run.ts's own env/LLM import chain (a type-only import would be erased
// and cost nothing either way, but this keeps the dependency direction explicit).
export interface JobUsage extends UsageStats {
  lead: UsageStats
  worker: UsageStats
}

// Mirrors the shape `lib/usage.ts`'s `reportUsage` takes, minus `model`/`subTool`/`outcome`
// (which the caller fills in per model role) — declared locally for the same reason as
// `JobUsage` above.
export type UsageReport = UsageStats & {
  jobId: string
  model: string
  subTool: 'lead' | 'worker'
  outcome?: 'ok' | 'error'
}

export interface RunResearchFn {
  (
    input: {
      query: string
      context?: string | undefined
      depth?: Depth
      jobId?: string
      signal?: AbortSignal | undefined
      onProgress?: ((progress: JobProgress) => void) | undefined
    },
    onUsage?: (stats: JobUsage) => void,
    opts?: {
      checkpoint?: ResearchCheckpoint | null
      onCheckpoint?: (checkpoint: ResearchCheckpoint) => void
      isFenced?: () => boolean
    },
  ): Promise<ResearchReport>
}

export interface JobRunnerDeps {
  store: JobStore
  runResearch: RunResearchFn
  reportUsage: (args: UsageReport) => void | Promise<void>
  log: (event: string, fields?: Record<string, unknown>) => void
  leadModel: string
  workerModel: string
  /**
   * Registered for the job's whole queued+running span so `cancelJob` (job-store.ts) can reach
   * it wherever it is — the cancel/progress runtime state lives one layer up (job-store.ts),
   * not in the durable `JobStore` core, so both are injected the same way `runResearch` is.
   */
  registerCancel: (jobId: string, controller: AbortController) => () => void
  setJobProgress: (jobId: string, progress: JobProgress) => void
  /** Defaults to 30s — production's real value; tests override to something a `bun test` run can wait out. */
  adoptionIntervalMs?: number
}

export interface JobRunner {
  startResearchJob(job: Job, opts?: { checkpoint?: ResearchCheckpoint | null }): void
  /** Runs one adoption pass synchronously — what the interval loop below calls on a timer, exposed directly so a test can drive it without waiting. */
  runAdoptionPass(): void
  /** Called once at boot; runs `runAdoptionPass` again every `adoptionIntervalMs` after. Returns a stop function so a test (or a graceful shutdown) can silence the timer. */
  startAdoptionLoop(): () => void
}

export function createJobRunner(deps: JobRunnerDeps): JobRunner {
  const { store, runResearch, reportUsage, log, leadModel, workerModel, registerCancel, setJobProgress } = deps
  const adoptionIntervalMs = deps.adoptionIntervalMs ?? 30_000

  function markFailed(jobId: string, err: unknown): void {
    log('job.error', { jobId, error: String(err) })
    store.updateJob(jobId, { status: 'error', error: String(err), finishedAt: Date.now() })
  }

  function startResearchJob(job: Job, opts?: { checkpoint?: ResearchCheckpoint | null }): void {
    // Starts BEFORE `withSlot`, not inside it — see run-job.ts's original comment for why: a
    // heartbeat has to cover a job's ENTIRE lifetime, queued and running alike, or a long
    // concurrency wait looks heartbeat-less to a sibling replica sharing the same DB.
    const stopHeartbeat = store.startHeartbeat(job.jobId)
    // Registered for the same queued+running span as the heartbeat, so `cancelJob` can reach
    // the job wherever it is. A cancel already writes the terminal 'cancelled' status itself
    // (job-store.ts), so both failure paths below only need to not report the unwinding abort
    // as a job error.
    const controller = new AbortController()
    const unregisterCancel = registerCancel(job.jobId, controller)

    void store
      .withSlot(job.jobId, async () => {
        // Cancelled in the gap between the slot being granted and this callback running — the
        // waiter was already popped, so cancelJob could not pull it from the line.
        if (controller.signal.aborted) return
        store.updateJob(job.jobId, { status: 'running', startedAt: Date.now() })

        let lastStats: JobUsage | null = null
        const emit = (stats: JobUsage, outcome: 'ok' | 'error'): void => {
          void reportUsage({ jobId: job.jobId, model: leadModel, subTool: 'lead', outcome, ...stats.lead })
          void reportUsage({ jobId: job.jobId, model: workerModel, subTool: 'worker', outcome, ...stats.worker })
        }

        try {
          const result = await runResearch(
            {
              query: job.query,
              context: job.context,
              depth: job.depth,
              jobId: job.jobId,
              signal: controller.signal,
              onProgress: (progress) => setJobProgress(job.jobId, progress),
            },
            (stats) => {
              lastStats = stats
              emit(stats, 'ok')
            },
            {
              checkpoint: opts?.checkpoint ?? null,
              onCheckpoint: (cp) => store.saveJobCheckpoint(job.jobId, serializeCheckpoint(cp)),
              // Checked at every round/retry/synthesis boundary inside `runResearch` itself.
              isFenced: () => !store.ownsLease(job.jobId),
            },
          )
          store.updateJob(job.jobId, { status: 'done', result, finishedAt: Date.now() })
          store.saveJobCheckpoint(job.jobId, null) // done — nothing left to resume
        } catch (err) {
          if (err instanceof FencedError) {
            // Another replica already claimed this job's lease and is resuming it from the
            // checkpoint this process itself last wrote — not a failure. `updateJob`'s owner
            // fence would refuse a status write from this process anyway, but skipping it here
            // also avoids a misleading `job.error` log line, and the checkpoint is left alone.
            log('job.fenced_stopped', { jobId: job.jobId })
            return
          }
          // A cancel is not a failure: its spend is still reported (same source_id, so argo
          // upserts the last snapshot), but as 'ok' so a cancelled job does not count toward
          // the error rate. `updateJob`'s terminal guard already refuses this write once
          // `cancelJob` has marked the job 'cancelled', so this can never clobber that status.
          if (lastStats) emit(lastStats, controller.signal.aborted ? 'ok' : 'error')
          if (!controller.signal.aborted) markFailed(job.jobId, err)
          store.saveJobCheckpoint(job.jobId, null) // terminal — never read again
        }
      })
      .catch((err) => {
        if (err instanceof HandedOffError) {
          // A drain handed this job to another replica while it was still queued — its lease
          // was released, not lost, so this is NOT a failure. Leave its status exactly as it
          // was ('queued') for the adopter's `claimStaleJobs` to pick up.
          return
        }
        if (!controller.signal.aborted) markFailed(job.jobId, err)
      })
      .finally(() => {
        stopHeartbeat()
        unregisterCancel()
      })
  }

  function crashLoopMessage(attempts: number): string {
    return `This research job was restarted ${attempts} times without finishing and may itself be what keeps crashing the process that runs it. It will not be retried again — resubmit the query.`
  }

  function runAdoptionPass(): void {
    if (store.isDraining()) return // a draining instance must adopt nothing new
    let claimed: Job[]
    try {
      claimed = store.claimStaleJobs(Date.now())
    } catch (err) {
      log('job.adoption_failed', { error: String(err) })
      return
    }
    for (const job of claimed) {
      // A poison job: something about it (not the process) keeps taking down whatever runs
      // it. `>=`, not `>`: `attempts` already counts THIS claim, so ending it here means
      // exactly MAX_JOB_ATTEMPTS processes crashed in a row, never one more.
      if (job.attempts >= MAX_JOB_ATTEMPTS) {
        const message = crashLoopMessage(job.attempts)
        store.updateJob(job.jobId, { status: 'error', error: message, finishedAt: Date.now() })
        store.notifyJobFailedAfterRestarts()
        log('job.crash_loop_guard', { jobId: job.jobId, attempts: job.attempts })
        continue
      }

      // A checkpoint that fails to parse (a version bump, corrupt JSON) degrades to null, so
      // this job simply restarts from scratch rather than failing to resume at all.
      const checkpoint = parseCheckpoint(job.checkpointJson)
      store.notifyJobResumed()
      log('job.resumed', { jobId: job.jobId, attempts: job.attempts, fromRound: checkpoint?.round ?? 1 })
      startResearchJob(job, { checkpoint })
    }
  }

  function startAdoptionLoop(): () => void {
    runAdoptionPass()
    const timer = setInterval(runAdoptionPass, adoptionIntervalMs)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  }

  return { startResearchJob, runAdoptionPass, startAdoptionLoop }
}
