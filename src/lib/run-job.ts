import { updateJob, withSlot, type Job } from './job-store.js'
import { runResearch } from '../agent/run.js'
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
    try {
      const result = await runResearch(
        { query: job.query, depth: job.depth, jobId: job.jobId },
        (stats) => {
          void reportUsage({ jobId: job.jobId, model: env.IU_LEAD_MODEL, subTool: 'lead', ...stats.lead })
          void reportUsage({ jobId: job.jobId, model: env.IU_WORKER_MODEL, subTool: 'worker', ...stats.worker })
        },
      )
      updateJob(job.jobId, { status: 'done', result, finishedAt: Date.now() })
    } catch (err) {
      log('job.error', { jobId: job.jobId, error: String(err) })
      updateJob(job.jobId, { status: 'error', error: String(err), finishedAt: Date.now() })
    }
  })
}
