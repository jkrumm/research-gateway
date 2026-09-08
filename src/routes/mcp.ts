import { Elysia } from 'elysia'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { Depth, JobHandle, JobState, type ResearchReport } from '../agent/schema.js'
import { admission, createJob, getJob, type Job } from '../lib/job-store.js'
import { POLL_INTERVAL_MS, shouldKeepWaiting, waitDeadline } from '../lib/wait.js'
import { startResearchJob } from '../lib/run-job.js'
import { env } from '../env.js'
import { log } from '../lib/log.js'
import type { CallToolResult } from '@modelcontextprotocol/server'

// MCP facade over the research engine, modelled on sideclaw's async-job contract:
// `research` submits and returns a jobId immediately, then `job_wait` / `job_status`
// retrieve the eventual report. The submit stays non-blocking because a job runs for
// minutes and a submit must not; `job_wait` then blocks for as long as the job takes
// (lib/wait.ts explains why that is safe, and why the old 50s cap was not a requirement).
//
// Served through `createMcpHandler`, the SDK's per-request entry: every request gets a
// fresh server instance, so no state can leak between calls, and the same endpoint serves
// BOTH the 2026-07-28 stateless protocol (which removed sessions and the initialize
// handshake) and 2025-era clients via the SDK's stateless legacy fallback. Constructing a
// transport by hand instead — the previous wiring — pins the endpoint to the legacy era
// and never installs the mandatory `server/discover` RPC.

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// Inline the report + citations + sources so text-only MCP clients get the full
// picture even if they ignore structuredContent.
function reportText(report: ResearchReport): string {
  // Confidence is rendered per citation, and `unverified` is rendered at all, because a
  // text-only client sees ONLY this string — omitting them here reproduced issue #1's
  // shape from the client's side: every claim looked equally established.
  const citationLines =
    report.citations.length > 0
      ? '\n\n## Citations\n' +
        report.citations.map((c, i) => `${i + 1}. [${c.confidence}] ${c.claim} — <${c.url}>`).join('\n')
      : ''
  const unverifiedLines =
    report.unverified.length > 0
      ? '\n\n## Unverified — could NOT be checked against a source\n' +
        report.unverified.map((u) => `- ${u.topic}${u.url ? ` (<${u.url}>)` : ''} — ${u.reason}`).join('\n')
      : ''
  const sourcesLines =
    report.sources.length > 0
      ? '\n\n## Sources read\n' + report.sources.map((s) => `- ${s}`).join('\n')
      : ''
  return report.report + citationLines + unverifiedLines + sourcesLines
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

// Per-request instance. Cheap: three registerTool calls over already-built Zod schemas.
function buildMcpServer(): McpServer {
  const mcpServer = new McpServer({
    name: 'research-gateway',
    version: '0.1.0',
  })

  // ── research — submit a job, return a handle (does NOT block) ─────────────────
  mcpServer.registerTool(
    'research',
    {
      title: 'Agentic Research (submit)',
      description:
        'Submit an agentic web research job: fans out Tavily searches, fetches and reads source pages, cross-verifies claims, and produces a cited markdown report. Returns IMMEDIATELY with a jobId — it does NOT block and does NOT return the report. Call job_wait({ jobId }) to block until the report is ready — it waits for the whole job, so one call is normally all you need — or job_status({ jobId }) for a non-blocking peek. depth=quick is fastest (fewer steps/sources); depth=standard (default) balances quality and speed; depth=deep is most thorough but slowest.',
      inputSchema: z.object({
        query: z.string().min(3).describe('The research question or topic to investigate'),
        depth: Depth.optional().describe('Research depth: quick | standard (default) | deep'),
      }),
      outputSchema: JobHandle,
    },
    async (args): Promise<CallToolResult> => {
      const refusal = admission()
      if (refusal) {
        return {
          content: [{ type: 'text', text: refusal.message }],
          isError: true,
        }
      }

      const depth = args.depth ?? 'standard'
      const job = createJob({ query: args.query, depth })
      startResearchJob(job)

      const handle: z.infer<typeof JobHandle> = {
        jobId: job.jobId,
        status: job.status,
        message: `Submitted as background research job. Call job_wait({ jobId: "${job.jobId}" }) once to block until it finishes and get the report, or job_status({ jobId: "${job.jobId}" }) for a one-shot check. This call did NOT return the report — do not treat it as the answer.`,
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
        "Block until a research job finishes, then return its state. The normal way to consume `research`: submit → job_wait → use result. It waits as long as the job takes — minutes for `standard`, up to ~20 for `deep` — holding the stream open with keep-alives, so ONE call is normally enough and there is no polling loop to write. Pass `maxWaitMs` only if you deliberately want to stop waiting early; a call that returns with stillRunning:true was bounded that way (or aborted), and calling job_wait again with the same jobId resumes waiting. When status is 'done', `result` holds the cited ResearchReport; when 'error', `error` explains why. The report carries `status` ('ok' | 'partial') and a code-counted `grounding` block: on 'partial' the run lost evidence, so treat any prose not backed by a `citations` entry as unconfirmed and read `unverified` for what could not be checked. Every citation carries a `confidence` derived from what was actually retrieved.",
      inputSchema: z.object({
        jobId: z.string().describe('The job id returned by research.'),
        maxWaitMs: z
          .number()
          .optional()
          .describe(
            'Optional. Stop blocking after this many ms and return with stillRunning:true. Omit it — the default is to wait for the job to actually finish.',
          ),
      }),
      outputSchema: JobState,
      annotations: { readOnlyHint: true, idempotentHint: false },
    },
    async (args, ctx): Promise<CallToolResult> => {
      let job = getJob(args.jobId)
      if (!job) return notFound(args.jobId)

      const startedWaitingAt = Date.now()
      const deadline = waitDeadline(startedWaitingAt, args.maxWaitMs)
      const progressToken = ctx.mcpReq._meta?.progressToken
      const signal = ctx.mcpReq.signal

      let tick = 0
      while (shouldKeepWaiting({ status: job.status, now: Date.now(), deadline, aborted: signal.aborted })) {
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

      // The line that says whether one call really covered a whole job. `bounded` separates a
      // caller who asked to stop early from a wait that ran to completion, so a rise in
      // `stillRunning: true` with `bounded: false` means the client hung up on us — the signal
      // that its per-server timeout is set too low, not that the job misbehaved.
      log('mcp.job_wait', {
        jobId: args.jobId,
        status: job.status,
        waitedMs: Date.now() - startedWaitingAt,
        ticks: tick,
        bounded: deadline !== null,
        aborted: signal.aborted,
      })

      return stateResult(job)
    },
  )

  // ── job_status — one-shot peek, no waiting ───────────────────────────────────
  mcpServer.registerTool(
    'job_status',
    {
      title: 'Research Job Status (one-shot)',
      description:
        "Return the current state of a research job by id, without waiting. Prefer job_wait when you actually want the report — this is a quick non-blocking peek (e.g. checking on a long job while doing other work). When status is 'done', `result` holds the cited ResearchReport; when 'error', `error` explains why. The report carries `status` ('ok' | 'partial') and a code-counted `grounding` block: on 'partial' the run lost evidence, so treat any prose not backed by a `citations` entry as unconfirmed and read `unverified` for what could not be checked. Every citation carries a `confidence` derived from what was actually retrieved.",
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

  return mcpServer
}

const handler = createMcpHandler(() => buildMcpServer(), {
  onerror: (error) => log('mcp.error', { error: String(error) }),
  // NOT the default 'auto', and this is what makes an unbounded `job_wait` viable at all.
  // Under 'auto' the SDK only upgrades a response to a stream once the handler emits a
  // notification, so a wait on a client that sent no `progressToken` would sit on a silent,
  // buffered response — and Bun closes an idle socket after `idleTimeout` (255s, its maximum,
  // set in index.ts). 'sse' upgrades before the tool body runs, which arms the SDK's 15s
  // keep-alive comment frames for every call. Bytes therefore flow the whole time, and no
  // layer in the path — Bun, Traefik, the client's idle timer — sees an idle connection.
  responseMode: 'sse',
})

// Elysia plugin: mount POST and GET on the prefix root so the handler sees both the
// JSON-RPC POST and the legacy SSE GET (which it answers 405 to under the stateless
// fallback — 2025 session operations do not exist in the modern protocol).
// No Elysia body/response schemas here — this is JSON-RPC, not REST.
// The route is excluded from the OpenAPI spec via the exclude.paths option in index.ts.
export const mcpRoutes = new Elysia({ prefix: '/mcp' })
  .post('/', ({ request }) => handler.fetch(request), { detail: { hide: true } })
  .get('/', ({ request }) => handler.fetch(request), { detail: { hide: true } })
