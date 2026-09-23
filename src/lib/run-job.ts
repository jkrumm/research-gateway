import {
  updateJob,
  withSlot,
  startHeartbeat,
  saveJobCheckpoint,
  claimStaleJobs,
  isDraining,
  notifyJobResumed,
  notifyJobFailedAfterRestarts,
  MAX_JOB_ATTEMPTS,
  HandedOffError,
  type Job,
} from './job-store.js'
import { runResearch, type JobUsage } from '../agent/run.js'
import { parseCheckpoint, serializeCheckpoint, type ResearchCheckpoint } from '../agent/checkpoint.js'
import { reportUsage } from './usage.js'
import { env } from '../env.js'
import { log } from './log.js'

// Fire-and-forget: run an already-created job's agentic loop in the background,
// updating its status in the job-store as it progresses. Shared by both the REST
// `POST /research` route and the MCP `research` submit tool so the two stay in
// lockstep. The caller retrieves the result by polling (REST `GET /research/:id`
// or MCP `job_wait` / `job_status`) — this never blocks the submit response.
// Both failure paths below end the same way, and they are far enough apart in the file to
// drift: the inner one covers `runResearch` throwing, the outer one covers the job never
// getting a slot at all (see the comment on the `.catch` below).
function markFailed(jobId: string, err: unknown): void {
  log('job.error', { jobId, error: String(err) })
  updateJob(jobId, { status: 'error', error: String(err), finishedAt: Date.now() })
}

export function startResearchJob(job: Job, opts?: { checkpoint?: ResearchCheckpoint | null }): void {
  // Starts BEFORE `withSlot`, not inside it: `withSlot`'s `await acquire()` blocks until a
  // concurrency slot frees up, and with `RESEARCH_MAX_CONCURRENCY=3` and deep jobs running
  // up to ~21 minutes (measured max), a queued job can legitimately wait well over half an hour
  // for its turn. If the
  // heartbeat only started once the job began RUNNING, that entire queued wait would look
  // heartbeat-less to any other process sharing the DB (e.g. the sibling replica during a
  // rolling deploy) — which would falsely treat the whole backlog as abandoned on every deploy
  // that lands while jobs are queued. Starting it here proves this process owns the job for
  // its ENTIRE lifetime, queued and running alike. Stopped via `.finally` below so it covers
  // the whole span, not just the async work inside `withSlot`.
  const stopHeartbeat = startHeartbeat(job.jobId)

  void withSlot(job.jobId, async () => {
    updateJob(job.jobId, { status: 'running', startedAt: Date.now() })

    // `runResearch` emits a cumulative snapshot per round; hold on to the last one
    // so a job that dies mid-flight can re-report exactly what it had spent, marked
    // as a failure. Same source_id, so argo upserts the row rather than adding one.
    let lastStats: JobUsage | null = null
    const emit = (stats: JobUsage, outcome: 'ok' | 'error'): void => {
      void reportUsage({
        jobId: job.jobId,
        model: env.IU_LEAD_MODEL,
        subTool: 'lead',
        outcome,
        ...stats.lead,
      })
      void reportUsage({
        jobId: job.jobId,
        model: env.IU_WORKER_MODEL,
        subTool: 'worker',
        outcome,
        ...stats.worker,
      })
    }

    try {
      const result = await runResearch(
        { query: job.query, context: job.context, depth: job.depth, jobId: job.jobId },
        (stats) => {
          lastStats = stats
          emit(stats, 'ok')
        },
        {
          checkpoint: opts?.checkpoint ?? null,
          onCheckpoint: (cp) => saveJobCheckpoint(job.jobId, serializeCheckpoint(cp)),
        },
      )
      updateJob(job.jobId, { status: 'done', result, finishedAt: Date.now() })
      saveJobCheckpoint(job.jobId, null) // done — nothing left to resume
    } catch (err) {
      if (lastStats) emit(lastStats, 'error')
      markFailed(job.jobId, err)
      saveJobCheckpoint(job.jobId, null) // terminal error — a checkpoint here would never be read again
    }
  })
    .catch((err) => {
      if (err instanceof HandedOffError) {
        // A drain handed this job to another replica while it was still queued
        // (job-store.ts's `beginDraining`) — its lease was released, not lost, so this is NOT
        // a failure. Leave its status exactly as it was ('queued') for the adopter's
        // `claimStaleJobs` to pick up; calling `markFailed` here would overwrite a perfectly
        // resumable job with a terminal error the instant a deploy's drain caught it waiting.
        return
      }
      // The inner try/catch above only wraps `runResearch` — a job still waiting on `acquire()`
      // (queued behind RESEARCH_MAX_CONCURRENCY) never reaches it. This is the only other way
      // `withSlot` can reject, so it is the only other place this can land.
      markFailed(job.jobId, err)
    })
    .finally(() => stopHeartbeat())
}

// ── Adoption loop ────────────────────────────────────────────────────────────
//
// Runs at boot (called once from index.ts) and every ADOPTION_INTERVAL_MS after, unless
// draining: claims every job whose lease has gone stale — the owning process crashed, was
// SIGKILLed, or lost a rolling-deploy race — and resumes each from its last checkpoint rather
// than the old behaviour of reaping it straight to a terminal error. Lives here, not in
// job-store.ts, so that module never has to import this one: job-store.ts is the durable
// store and the lease primitives, this file is what DOES something with a claimed job, and
// run-job.ts already imports job-store.ts one direction only.
//
// The per-job SEARCH-spend meters in `agent/tools.ts` are in-memory and reset on every process
// boot, so a resumed job's reported `searchUsd`/`tavilyCredits` covers only the work done
// AFTER this adoption, not the whole job. LLM usage does not have this gap: `leadUsage`/
// `workerUsage` travel inside the checkpoint itself (checkpoint.ts) and are correct across a
// resume.
const ADOPTION_INTERVAL_MS = 30_000

function crashLoopMessage(attempts: number): string {
  return `This research job was restarted ${attempts} times without finishing and may itself be what keeps crashing the process that runs it. It will not be retried again — resubmit the query.`
}

function runAdoptionPass(): void {
  if (isDraining()) return // a draining process must adopt nothing new — it is on its way out
  let claimed: Job[]
  try {
    claimed = claimStaleJobs(Date.now())
  } catch (err) {
    // Runs on a timer: a transient sqlite error must not become an uncaughtException. The next
    // pass, 30s later, tries again.
    log('job.adoption_failed', { error: String(err) })
    return
  }
  for (const job of claimed) {
    // A poison job: something about it (not the process) keeps taking down whatever runs it.
    // Re-adopting it forever would just move the crash from replica to replica — give up
    // instead, the same one-retry-then-stop posture `round.ts`'s `shouldRetryRound` uses at
    // the round level, applied here at the whole-job level.
    if (job.attempts > MAX_JOB_ATTEMPTS) {
      const message = crashLoopMessage(job.attempts)
      updateJob(job.jobId, { status: 'error', error: message, finishedAt: Date.now() })
      notifyJobFailedAfterRestarts()
      log('job.crash_loop_guard', { jobId: job.jobId, attempts: job.attempts })
      continue
    }

    // A checkpoint that fails to parse (a version bump, corrupt JSON) degrades to null —
    // checkpoint.ts's own contract — so this job simply restarts from scratch rather than
    // failing to resume at all.
    const checkpoint = parseCheckpoint(job.checkpointJson)
    notifyJobResumed()
    log('job.resumed', { jobId: job.jobId, attempts: job.attempts, fromRound: checkpoint?.round ?? 1 })
    startResearchJob(job, { checkpoint })
  }
}

/** Called once from index.ts at boot; runs itself again every ADOPTION_INTERVAL_MS after. */
export function startAdoptionLoop(): void {
  runAdoptionPass()
  const timer = setInterval(runAdoptionPass, ADOPTION_INTERVAL_MS)
  if (typeof timer.unref === 'function') timer.unref()
}
