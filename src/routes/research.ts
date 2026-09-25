import { Elysia } from 'elysia'
import { z } from 'zod'
import { JobLiveFields, ResearchInput, ResearchReport } from '../agent/schema.js'
import { admission, cancelJob, createJob, findActiveJobByIdempotencyKey, getJob, liveFields } from '../lib/job-store.js'
import { startResearchJob } from '../lib/run-job.js'
import { log } from '../lib/log.js'
import { env } from '../env.js'

// The engine's input schema (agent/schema.ts) plus the submit dedupe key, which is a job-store
// concern rather than an engine one. Extending it here — rather than in schema.ts — keeps the
// `/research` body the only place that knows about keys; the MCP tool declares its own input.
const ResearchSubmit = ResearchInput.extend({
  idempotencyKey: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'Optional caller-supplied key (1..200 chars). Retrying a submit with the same key returns the original job instead of starting a second one.',
    ),
})

export const researchRoutes = new Elysia({ prefix: '/research' })
  .post(
    '/',
    ({ body, status, set }) => {
      const depth = body.depth ?? 'standard'

      // Dedupe BEFORE admission: a retried submit carrying a key whose job already exists must
      // return that job, never be shed by a full queue or a draining process — the work is
      // already accounted for, so refusing it would be pure loss.
      if (body.idempotencyKey !== undefined) {
        const existing = findActiveJobByIdempotencyKey(body.idempotencyKey)
        if (existing) {
          log('job.deduplicated', { jobId: existing.jobId })
          return { jobId: existing.jobId, status: existing.status }
        }
      }

      const refusal = admission()
      if (refusal) {
        log('job.rejected', { reason: refusal.reason })
        set.headers['Retry-After'] = String(refusal.retryAfterSeconds)
        return status(refusal.httpStatus, { error: refusal.message })
      }

      const job = createJob({
        query: body.query,
        depth,
        context: body.context,
        idempotencyKey: body.idempotencyKey,
      })
      log('job.created', { jobId: job.jobId, depth, withContext: body.context !== undefined })

      // Fire-and-forget: run the agent in the background without blocking the response.
      startResearchJob(job)

      return { jobId: job.jobId, status: job.status }
    },
    {
      body: ResearchSubmit,
      response: {
        200: z.object({
          jobId: z.string(),
          status: z.string(),
        }),
        429: z.object({ error: z.string() }),
        503: z.object({ error: z.string() }),
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
        // JSON, not a bare string: a poller parses every response of this endpoint as
        // JSON, so a plain-text body turns an expected 404 into a parse crash in the
        // client. Job records now persist across a restart (see lib/job-db.ts) — a job that
        // was queued/running when the process died comes back as a terminal 'error', not a
        // 404 — so a 404 here means the id never existed or has passed its TTL retention
        // window after completion.
        return status(404, {
          error: `Job not found: ${params.jobId}. It never existed, or has passed its retention window (${env.JOB_TTL_MINUTES} minutes after completion). Submit a new research job.`,
        })
      }
      return {
        status: job.status,
        ...liveFields(job),
        result: job.result,
        error: job.error,
      }
    },
    {
      response: {
        200: z.object({
          status: z.string(),
          ...JobLiveFields,
          result: ResearchReport.optional(),
          error: z.string().optional(),
        }),
        404: z.object({ error: z.string() }),
      },
      detail: {
        tags: ['Research'],
        summary: 'Poll a research job',
        description:
          'Returns the current status of a research job, plus live fields: `queuePosition` while queued, `progress` (phase, round, workers done/total) while running, timestamps, and the measured p50/p90 duration for its depth. When `status` is `done`, `result` contains the research report. When `status` is `error` or `cancelled`, `error` says why.',
        security: [{ BearerAuth: [] }],
      },
    },
  )
  .delete(
    '/:jobId',
    ({ params, status }) => {
      const outcome = cancelJob(params.jobId)
      if (outcome.kind === 'not_found') {
        return status(404, {
          error: `Job not found: ${params.jobId}. It never existed, or has passed its retention window (${env.JOB_TTL_MINUTES} minutes after completion).`,
        })
      }
      if (outcome.kind === 'not_owned') {
        return status(409, {
          error: `Job ${params.jobId} is running on the other replica of an in-progress deploy and cannot be cancelled from this one; retry in a minute.`,
        })
      }
      return { jobId: outcome.job.jobId, status: outcome.job.status }
    },
    {
      response: {
        200: z.object({ jobId: z.string(), status: z.string() }),
        404: z.object({ error: z.string() }),
        409: z.object({ error: z.string() }),
      },
      detail: {
        tags: ['Research'],
        summary: 'Cancel a research job',
        description:
          "Cancels a queued or running job: a queued one never starts, a running one is aborted and its slot freed. Returns `status: 'cancelled'`. Idempotent — a job that is already terminal is returned with its status unchanged. A cancelled job's idempotencyKey is released for a corrected resubmit.",
        security: [{ BearerAuth: [] }],
      },
    },
  )
