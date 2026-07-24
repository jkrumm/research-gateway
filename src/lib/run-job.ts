import { updateJob, withSlot, type Job } from './job-store.js'
import { runResearch, type JobUsage } from '../agent/run.js'
import { reportUsage } from './usage.js'
import { env } from '../env.js'
import { log } from './log.js'

// Fire-and-forget: run an already-created job's agentic loop in the background,
// updating its status in the job-store as it progresses. Shared by both the REST
// `POST /research` route and the MCP `research` submit tool so the two stay in
// lockstep. The caller retrieves the result by polling (REST `GET /research/:id`
// or MCP `job_wait` / `job_status`) — this never blocks the submit response.
export function startResearchJob(job: Job): void {
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
      log('job.error', { jobId: job.jobId, error: String(err) })
      if (lastStats) emit(lastStats, 'error')
      updateJob(job.jobId, { status: 'error', error: String(err), finishedAt: Date.now() })
    }
  })
}
