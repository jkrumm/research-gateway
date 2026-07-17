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

// ── Plan → parallel fan-out → synthesize contracts (internal, not part of the public API) ──

export const SubQuestion = z.object({
  id: z.string(),
  question: z.string(),
  rationale: z.string().optional(),
})
export type SubQuestion = z.infer<typeof SubQuestion>

export const ResearchPlan = z.object({ subQuestions: z.array(SubQuestion).min(1) })
export type ResearchPlan = z.infer<typeof ResearchPlan>

export const Finding = z.object({
  claim: z.string(),
  url: z.string(),
  confidence: z.enum(['high', 'medium', 'low']),
})
export type Finding = z.infer<typeof Finding>

export const WorkerDigest = z.object({
  subQuestion: z.string(),
  summary: z.string().describe('Distilled markdown answer to this sub-question, <= ~400 words'),
  findings: z.array(Finding),
  sourcesRead: z.array(z.string()),
  // Fed back as the next gap round's sub-questions, so these MUST be researchable
  // questions. Free-text notes ("could not fetch X, paywall") spawn workers chasing
  // things that are unresearchable by definition; they flail until they time out.
  openGaps: z
    .array(z.string())
    .describe(
      'Unresolved, self-contained research QUESTIONS that a different worker could answer from scratch, phrased as questions. NOT notes about what went wrong. Do NOT include anything blocked by an inaccessible source (paywall, dead link, video) — re-researching those is futile. Empty array if nothing substantive remains.',
    ),
})
export type WorkerDigest = z.infer<typeof WorkerDigest>

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
