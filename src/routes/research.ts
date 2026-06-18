import { Elysia } from 'elysia'
import { z } from 'zod'
import { ResearchInput, ResearchReport } from '../agent/schema.js'
import { atCapacity, createJob, getJob } from '../lib/job-store.js'
import { startResearchJob } from '../lib/run-job.js'
import { log } from '../lib/log.js'

export const researchRoutes = new Elysia({ prefix: '/research' })
  .post(
    '/',
    ({ body, status }) => {
      if (atCapacity()) {
        log('job.rejected', { reason: 'at_capacity' })
        return status(429, 'Research queue is full, retry shortly')
      }
      const depth = body.depth ?? 'standard'
      const job = createJob({ query: body.query, depth })
      log('job.created', { jobId: job.jobId, depth })

      // Fire-and-forget: run the agent in the background without blocking the response.
      startResearchJob(job)

      return { jobId: job.jobId, status: job.status }
    },
    {
      body: ResearchInput,
      response: {
        200: z.object({
          jobId: z.string(),
          status: z.string(),
        }),
        429: z.string(),
      },
      detail: {
        tags: ['Research'],
        summary: 'Submit a research query',
        description:
          'Enqueues an agentic research job and returns a jobId immediately. Poll `GET /research/:jobId` to check status and retrieve the result.',
        security: [{ BearerAuth: [] }],
      },
    },
  )
  .get(
    '/:jobId',
    ({ params, status }) => {
      const job = getJob(params.jobId)
      if (!job) {
        return status(404, 'Job not found')
      }
      return {
        status: job.status,
        result: job.result,
        error: job.error,
      }
    },
    {
      response: {
        200: z.object({
          status: z.string(),
          result: ResearchReport.optional(),
          error: z.string().optional(),
        }),
        404: z.string(),
      },
      detail: {
        tags: ['Research'],
        summary: 'Poll a research job',
        description:
          'Returns the current status of a research job. When `status` is `done`, `result` contains the research report. When `status` is `error`, `error` contains the failure message.',
        security: [{ BearerAuth: [] }],
      },
    },
  )
