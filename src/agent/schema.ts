import { z } from 'zod'

export const Depth = z.enum(['quick', 'standard', 'deep'])
export type Depth = z.infer<typeof Depth>

export const ResearchInput = z.object({
  query: z.string().min(3),
  depth: Depth.optional(),
})
export type ResearchInput = z.infer<typeof ResearchInput>

// What the SYNTHESIS MODEL submits. Deliberately does NOT carry `status`, `warnings` or
// `grounding` — those are derived in code from the retrieval ledger (see ground.ts). A
// model must never be able to assert that its own output was verified.
export const SubmittedReport = z.object({
  report: z.string().describe('Narrative, cited answer in markdown'),
  citations: z
    .array(
      z.object({
        claim: z.string(),
        url: z.string(),
        confidence: z
          .enum(['high', 'medium', 'low'])
          .describe("The worker's confidence in this specific claim, carried through from the source digest."),
      }),
    )
    .describe('Each key claim tied to a source URL'),
  sources: z.array(z.string()).describe('Deduplicated list of all source URLs consulted'),
  unverified: z
    .array(z.object({ topic: z.string(), url: z.string().nullable(), reason: z.string() }))
    .default([])
    .describe(
      'Claims or topics the report could NOT verify against a source, aggregated from the digests\' blockedSources. A transparency channel to the caller — distinct from citations, which are claims that WERE verified.',
    ),
})
export type SubmittedReport = z.infer<typeof SubmittedReport>

// What one run cost, counted in code alongside `grounding`. This exists because the only
// way to price a single job used to be differencing argo's cumulative counter between
// jobs — which is only correct while no two jobs overlap (i.e. not at
// RESEARCH_MAX_CONCURRENCY > 1) and was never available to a caller at all. Telemetry to
// argo is unchanged; this is the same numbers, delivered with the result.
export const RunCost = z.object({
  wallMs: z.number().describe('End-to-end duration of the run in milliseconds.'),
  totalUsd: z
    .number()
    .nullable()
    .describe('llmUsd + searchUsd. Null when the LLM rate table has no entry for the configured model.'),
  llmUsd: z
    .number()
    .nullable()
    .describe('Lead + worker token spend, computed from the local rate table (cache-aware).'),
  searchUsd: z.number().describe("Web-search spend, as reported by the vendor's own per-call cost."),
  searchCalls: z.number().describe('Billed search calls this run — cache hits excluded.'),
  tavilyCredits: z
    .number()
    .describe('Tavily credits consumed (page extraction, plus any search that fell back). Not priced — no verified USD-per-credit rate exists.'),
})
export type RunCost = z.infer<typeof RunCost>

// Machine-checked evidence accounting for the run. Every number here is counted in code
// from what the fetch tools actually returned, so a caller can weigh the report without
// trusting the model's own account of its work.
export const Grounding = z.object({
  pagesRetrieved: z.number().describe('Pages whose full text was actually retrieved this run.'),
  pagesFailed: z.number().describe('Pages a fetch was attempted on and failed (rate limit, error, refusal).'),
  citationsKept: z.number().describe('Citations backed by a page this run actually retrieved or saw as a search snippet.'),
  citationsDropped: z
    .number()
    .describe('Citations removed because the URL was never retrieved, or its fetch failed. Each is restated in `unverified`.'),
  confidenceCapped: z
    .number()
    .describe('Citations whose asserted confidence was lowered to match what was actually retrieved.'),
})
export type Grounding = z.infer<typeof Grounding>

// The PUBLIC report: the model's submission after code-side grounding.
export const ResearchReport = SubmittedReport.extend({
  status: z
    .enum(['ok', 'partial'])
    .default('ok')
    .describe(
      "'partial' means evidence was lost this run — citations were dropped for lack of a retrieved source, or nothing could be retrieved at all. Treat prose in a 'partial' report as unconfirmed unless a citation backs it.",
    ),
  warnings: z
    .array(z.string())
    .default([])
    .describe('Human-readable notes about degraded evidence for this run. Empty on a clean run.'),
  grounding: Grounding.describe('Machine-checked evidence accounting — counted in code, not asserted by the model.'),
  cost: RunCost.describe(
    'What this single run actually cost and how long it took — counted in code. Search spend is the vendor-reported USD, LLM spend is computed from the rate table.',
  ),
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
  blockedSources: z
    .array(z.object({ topic: z.string(), url: z.string().nullable(), reason: z.string() }))
    .default([])
    .describe(
      'Things you could NOT verify because a source was unreachable, truncated, paywalled, or otherwise unusable. Contrast with openGaps: openGaps feeds a re-research loop and must only contain genuinely researchable questions, so inaccessible-source problems must NEVER go there. blockedSources does NOT feed re-research — it is a transparency channel straight through to the caller, so it is the correct place for "could not verify X because the source was unreachable" notes. Empty array if nothing was blocked.',
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
