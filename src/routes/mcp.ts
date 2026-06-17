import { Elysia } from 'elysia'
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { Depth, ResearchReport } from '../agent/schema.js'
import { atCapacity, createJob, updateJob, withSlot } from '../lib/job-store.js'
import { runResearch } from '../agent/run.js'
import { reportUsage } from '../lib/usage.js'
import { env } from '../env.js'
import type { CallToolResult } from '@modelcontextprotocol/server'

// Build the MCP server and transport once (stateless: no session options).
// The transport handles all incoming requests without maintaining session state
// across connections, which is the correct model for a REST-style MCP facade.
const mcpServer = new McpServer({
  name: 'research-gateway',
  version: '0.1.0',
})

mcpServer.registerTool(
  'research',
  {
    title: 'Agentic Research',
    description:
      'Runs agentic web research: fans out Tavily searches, fetches and reads source pages, cross-verifies claims across sources, and returns a cited markdown report. depth=quick is fastest (fewer steps/sources); depth=standard balances quality and speed; depth=deep is most thorough but slowest. The tool blocks until the report is ready.',
    inputSchema: z.object({
      query: z.string().min(3).describe('The research question or topic to investigate'),
      depth: Depth.optional().describe('Research depth: quick | standard (default) | deep'),
    }),
    outputSchema: ResearchReport,
  },
  // TODO: Implement progress notifications / MCP Tasks for long-running deep jobs
  // so clients with short tool-call timeouts can poll instead of blocking.
  async (args): Promise<CallToolResult> => {
    if (atCapacity()) {
      return {
        content: [{ type: 'text', text: 'Research gateway at capacity — retry shortly.' }],
        isError: true,
      }
    }

    const depth = args.depth ?? 'standard'
    const job = createJob({ query: args.query, depth })

    try {
      const result = await withSlot(async () => {
        updateJob(job.jobId, { status: 'running', startedAt: Date.now() })
        try {
          const report = await runResearch(
            { query: args.query, depth, jobId: job.jobId },
            (stats) => {
              void reportUsage({
                jobId: job.jobId,
                model: env.IU_MODEL,
                ...stats,
              })
            },
          )
          updateJob(job.jobId, { status: 'done', result: report, finishedAt: Date.now() })
          return report
        } catch (e) {
          updateJob(job.jobId, {
            status: 'error',
            error: e instanceof Error ? e.message : String(e),
            finishedAt: Date.now(),
          })
          throw e
        }
      })

      // Build the human-readable text with inline citations so text-only MCP
      // clients get the full picture even if they ignore structuredContent.
      const citationLines =
        result.citations.length > 0
          ? '\n\n## Citations\n' +
            result.citations.map((c, i) => `${i + 1}. ${c.claim} — <${c.url}>`).join('\n')
          : ''
      const sourcesLines =
        result.sources.length > 0
          ? '\n\n## Sources\n' + result.sources.map((s) => `- ${s}`).join('\n')
          : ''
      const text = result.report + citationLines + sourcesLines

      return {
        content: [{ type: 'text', text }],
        structuredContent: result,
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return {
        content: [{ type: 'text', text: `Research failed: ${message}` }],
        isError: true,
      }
    }
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
