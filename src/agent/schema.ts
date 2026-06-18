import { z } from 'zod'

export const Depth = z.enum(['quick', 'standard', 'deep'])
export type Depth = z.infer<typeof Depth>

export const ResearchInput = z.object({
  query: z.string().min(3),
  depth: Depth.optional(),
})
export type ResearchInput = z.infer<typeof ResearchInput>

export const ResearchReport = z.object({
  report: z.string().describe('Narrative, cited answer in markdown'),
  citations: z
    .array(z.object({ claim: z.string(), url: z.string() }))
    .describe('Each key claim tied to a source URL'),
  sources: z.array(z.string()).describe('Deduplicated list of all source URLs consulted'),
})
export type ResearchReport = z.infer<typeof ResearchReport>

// ── Async job contract (REST + MCP share this vocabulary) ────────────────────

export const JobStatus = z.enum(['queued', 'running', 'done', 'error'])
export type JobStatus = z.infer<typeof JobStatus>

// Returned by the `research` submit tool — a handle, not the report.
export const JobHandle = z.object({
  jobId: z
    .string()
    .describe('Opaque job id. Pass to job_wait / job_status to retrieve the eventual report.'),
  status: JobStatus.describe(
    'Initial status — "queued" (waiting behind the concurrency limit) or "running".',
  ),
  message: z.string().describe('Next step for the caller.'),
})
export type JobHandle = z.infer<typeof JobHandle>

// Returned by job_wait / job_status — the live state of a research job.
export const JobState = z.object({
  jobId: z.string(),
  status: JobStatus.describe('queued=waiting, running=executing, done/error=terminal.'),
  stillRunning: z
    .boolean()
    .describe('True while not terminal. If true after job_wait, call job_wait again with the same jobId.'),
  elapsedMs: z.number().describe('Wall time so far (running) or total (terminal).'),
  result: ResearchReport.nullable().describe("The cited research report. Present only when status is 'done'."),
  error: z.string().nullable().describe("Failure reason. Present when status is 'error'."),
})
export type JobState = z.infer<typeof JobState>
