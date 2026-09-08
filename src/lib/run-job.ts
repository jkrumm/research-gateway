import { updateJob, withSlot, startHeartbeat, type Job } from './job-store.js'
import { runResearch, type JobUsage } from '../agent/run.js'
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

export function startResearchJob(job: Job): void {
  // Starts BEFORE `withSlot`, not inside it: `withSlot`'s `await acquire()` blocks until a
  // concurrency slot frees up, and with `RESEARCH_MAX_CONCURRENCY=3` and deep jobs running
  // ~28 minutes, a queued job can legitimately wait well over half an hour for its turn. If the
  // heartbeat only started once the job began RUNNING, that entire queued wait would look
  // heartbeat-less to any other process sharing the DB (e.g. the sibling replica during a
  // rolling deploy) — which would falsely reap the whole backlog on every deploy that lands
  // while jobs are queued. Starting it here proves this process owns the job for its ENTIRE
  // lifetime, queued and running alike. Stopped via `.finally` below so it covers the whole
  // span, not just the async work inside `withSlot`.
  const stopHeartbeat = startHeartbeat(job.jobId)

  void withSlot(async () => {
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
        { query: job.query, depth: job.depth, jobId: job.jobId },
        (stats) => {
          lastStats = stats
          emit(stats, 'ok')
        },
      )
      updateJob(job.jobId, { status: 'done', result, finishedAt: Date.now() })
    } catch (err) {
      if (lastStats) emit(lastStats, 'error')
      markFailed(job.jobId, err)
    }
  })
    .catch((err) => {
      // The inner try/catch above only wraps `runResearch` — a job still waiting on `acquire()`
      // (queued behind RESEARCH_MAX_CONCURRENCY) never reaches it. `beginDraining` (job-store.ts)
      // rejects exactly that waiter on shutdown, and this is the only place that rejection can
      // land: the job's status was never flipped to 'running', so without this it would sit at
      // 'queued' until the heartbeat staleness reap caught it up to 90s later.
      markFailed(job.jobId, err)
    })
    .finally(() => stopHeartbeat())
}
