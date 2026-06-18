import { Elysia } from 'elysia'
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { Depth, JobHandle, JobState, type ResearchReport } from '../agent/schema.js'
import { atCapacity, createJob, getJob, type Job } from '../lib/job-store.js'
import { startResearchJob } from '../lib/run-job.js'
import { env } from '../env.js'
import type { CallToolResult } from '@modelcontextprotocol/server'

// MCP facade over the research engine, modelled on sideclaw's async-job contract:
// `research` submits and returns a jobId immediately, then `job_wait` / `job_status`
// retrieve the eventual report. This keeps every request well under the MCP HTTP
// transport's ~60s first-byte budget — a blocking call that ran the full agentic
// loop (often 60–120s) would otherwise be aborted by the client mid-flight.
const mcpServer = new McpServer({
  name: 'research-gateway',
  version: '0.1.0',
})

const POLL_INTERVAL_MS = 2_000
const DEFAULT_WAIT_MS = 50_000
const MAX_WAIT_MS = 55_000 // stay under the MCP HTTP transport's ~60s first-byte budget
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// Inline the report + citations + sources so text-only MCP clients get the full
// picture even if they ignore structuredContent.
function reportText(report: ResearchReport): string {
  const citationLines =
    report.citations.length > 0
      ? '\n\n## Citations\n' +
        report.citations.map((c, i) => `${i + 1}. ${c.claim} — <${c.url}>`).join('\n')
      : ''
  const sourcesLines =
    report.sources.length > 0
      ? '\n\n## Sources\n' + report.sources.map((s) => `- ${s}`).join('\n')
      : ''
  return report.report + citationLines + sourcesLines
}

function toState(job: Job): z.infer<typeof JobState> {
  const terminal = job.status === 'done' || job.status === 'error'
  const start = job.startedAt ?? job.createdAt
  const end = job.finishedAt ?? Date.now()
  return {
    jobId: job.jobId,
    status: job.status,
    stillRunning: !terminal,
    elapsedMs: Math.max(0, end - start),
    result: job.status === 'done' ? (job.result ?? null) : null,
    error: job.status === 'error' ? (job.error ?? null) : null,
  }
}

function stateResult(job: Job): CallToolResult {
  const state = toState(job)
  const text =
    job.status === 'done' && job.result ? reportText(job.result) : JSON.stringify(state)
  return { content: [{ type: 'text', text }], structuredContent: state }
}

function notFound(jobId: string): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: `Job not found: ${jobId} — it may have expired (jobs are retained ${env.JOB_TTL_MINUTES} min after completion). Submit a new research job.`,
      },
    ],
    isError: true,
  }
}

// ── research — submit a job, return a handle (does NOT block) ─────────────────
mcpServer.registerTool(
  'research',
  {
    title: 'Agentic Research (submit)',
    description:
      'Submit an agentic web research job: fans out Tavily searches, fetches and reads source pages, cross-verifies claims, and produces a cited markdown report. Returns IMMEDIATELY with a jobId — it does NOT block and does NOT return the report. Call job_wait({ jobId }) to wait for and retrieve the report (loop while stillRunning is true), or job_status({ jobId }) for a non-blocking peek. depth=quick is fastest (fewer steps/sources); depth=standard (default) balances quality and speed; depth=deep is most thorough but slowest.',
    inputSchema: z.object({
      query: z.string().min(3).describe('The research question or topic to investigate'),
      depth: Depth.optional().describe('Research depth: quick | standard (default) | deep'),
    }),
    outputSchema: JobHandle,
  },
  async (args): Promise<CallToolResult> => {
    if (atCapacity()) {
      return {
        content: [{ type: 'text', text: 'Research gateway at capacity — retry shortly.' }],
        isError: true,
      }
    }

    const depth = args.depth ?? 'standard'
    const job = createJob({ query: args.query, depth })
    startResearchJob(job)

    const handle: z.infer<typeof JobHandle> = {
      jobId: job.jobId,
      status: job.status,
      message: `Submitted as background research job. Call job_wait({ jobId: "${job.jobId}" }) to block until it finishes and get the report (loop while stillRunning), or job_status({ jobId: "${job.jobId}" }) for a one-shot check. This call did NOT return the report — do not treat it as the answer.`,
    }
    return { content: [{ type: 'text', text: JSON.stringify(handle) }], structuredContent: handle }
  },
)

// ── job_wait — long-poll until terminal or the wait window elapses ───────────
mcpServer.registerTool(
  'job_wait',
  {
    title: 'Wait for Research Job',
    description:
      "Wait for a research job to finish, then return its state. The normal way to consume `research`: submit → job_wait → use result. Polls internally with progress heartbeats, so it is safe for long jobs and won't trip the MCP timeout. Waits up to ~50s per call; if the job is still running when the window elapses it returns with stillRunning:true — simply call job_wait again with the same jobId (loop until stillRunning is false). When status is 'done', `result` holds the cited ResearchReport; when 'error', `error` explains why.",
    inputSchema: z.object({
      jobId: z.string().describe('The job id returned by research.'),
      maxWaitMs: z
        .number()
        .optional()
        .describe(`Max time to block this call, in ms. Default ${DEFAULT_WAIT_MS}, capped at ${MAX_WAIT_MS}.`),
    }),
    outputSchema: JobState,
    annotations: { readOnlyHint: true, idempotentHint: false },
  },
  async (args, ctx): Promise<CallToolResult> => {
    let job = getJob(args.jobId)
    if (!job) return notFound(args.jobId)

    const budget = Math.min(Math.max(args.maxWaitMs ?? DEFAULT_WAIT_MS, 1_000), MAX_WAIT_MS)
    const deadline = Date.now() + budget
    const progressToken = ctx.mcpReq._meta?.progressToken
    const signal = ctx.mcpReq.signal

    let tick = 0
    while (
      job.status !== 'done' &&
      job.status !== 'error' &&
      Date.now() < deadline &&
      !signal.aborted
    ) {
      await sleep(POLL_INTERVAL_MS)
      tick++
      if (progressToken !== undefined) {
        const secs = Math.round((Date.now() - (job.startedAt ?? job.createdAt)) / 1000)
        // Heartbeat keeps the HTTP stream warm and surfaces progress to the client.
        // Best-effort: never let a notification failure abort the wait.
        try {
          await ctx.mcpReq.notify({
            method: 'notifications/progress',
            params: { progressToken, progress: tick, message: `Researching… (${secs}s)` },
          })
        } catch {
          // ignore — progress is best-effort
        }
      }
      job = getJob(args.jobId) ?? job
    }

    return stateResult(job)
  },
)

// ── job_status — one-shot peek, no waiting ───────────────────────────────────
mcpServer.registerTool(
  'job_status',
  {
    title: 'Research Job Status (one-shot)',
    description:
      "Return the current state of a research job by id, without waiting. Prefer job_wait when you actually want the report — this is a quick non-blocking peek (e.g. checking on a long job while doing other work). When status is 'done', `result` holds the cited ResearchReport; when 'error', `error` explains why.",
    inputSchema: z.object({
      jobId: z.string().describe('The job id returned by research.'),
    }),
    outputSchema: JobState,
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async (args): Promise<CallToolResult> => {
    const job = getJob(args.jobId)
    if (!job) return notFound(args.jobId)
    return stateResult(job)
  },
)

const transport = new WebStandardStreamableHTTPServerTransport()
await mcpServer.connect(transport)

// Elysia plugin: mount POST and GET on the prefix root so the transport can
// handle both the initial JSON-RPC POST and the optional SSE GET for streaming.
// No Elysia body/response schemas here — this is JSON-RPC, not REST.
// The route is excluded from the OpenAPI spec via the exclude.paths option in index.ts.
export const mcpRoutes = new Elysia({ prefix: '/mcp' })
  .post('/', ({ request }) => transport.handleRequest(request), { detail: { hide: true } })
  .get('/', ({ request }) => transport.handleRequest(request), { detail: { hide: true } })
