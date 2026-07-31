import { generateText, tool } from 'ai'
import type { Tool } from 'ai'
import { leadModel } from '../lib/llm.js'
import { profiles } from './depth.js'
import { synthesisPrompt } from './prompt.js'
import { resolveSynthesisReport } from './extract.js'
import { SubmittedReport, WorkerDigest } from './schema.js'
import type { Depth } from './schema.js'
import { log } from '../lib/log.js'
import { emptyUsage, toUsageStats } from '../lib/usage.js'
import type { UsageStats } from '../lib/usage.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = Tool<any, any>

function extractReport(toolCalls: ReadonlyArray<{ toolName: string; input: unknown }>): SubmittedReport | null {
  const submitCall = toolCalls.find((c) => c.toolName === 'submit_report')
  if (!submitCall) return null
  const parsed = SubmittedReport.safeParse(submitCall.input)
  return parsed.success ? parsed.data : null
}

function renderDigests(query: string, digests: WorkerDigest[]): string {
  const sections = digests.map((d) => {
    const findings = d.findings.map((f) => `- ${f.claim} — ${f.url} (${f.confidence})`).join('\n')
    const sourcesRead = d.sourcesRead.join(', ')
    const blockedSources = d.blockedSources
      .map((b) => `- ${b.topic} — ${b.url ?? '(no url)'} (${b.reason})`)
      .join('\n')
    return `### ${d.subQuestion}\n\n${d.summary}\n\n**Findings:**\n${findings || '(none)'}\n\n**Sources read:** ${sourcesRead || '(none)'}\n\n**Blocked sources:**\n${blockedSources || '(none)'}`
  })
  return `## Original query\n\n${query}\n\n## Researched sub-questions\n\n${sections.join('\n\n')}`
}

export async function synthesize(args: {
  query: string
  digests: WorkerDigest[]
  depth: Depth
  jobId: string
}): Promise<{ report: SubmittedReport | null; usage: UsageStats }> {
  const { query, digests, depth, jobId } = args
  const profile = profiles[depth]
  const start = Date.now()

  const submitReportTool: AnyTool = tool({
    description:
      'Submit the final research report synthesized from the provided digests. This is the ONLY way to deliver the answer — do not write plain text.',
    inputSchema: SubmittedReport,
  }) as AnyTool

  try {
    const result = await generateText({
      model: leadModel,
      instructions: synthesisPrompt(depth),
      prompt: renderDigests(query, digests),
      tools: { submit_report: submitReportTool },
      toolChoice: { type: 'tool', toolName: 'submit_report' },
      // `timeout.totalMs` bounds the whole call INCLUDING retries; a bare abortSignal
      // does not, which let a synthesis overrun its ceiling in testing. The abortSignal
      // is kept as an outer backstop (verified to fire correctly under Bun).
      timeout: { totalMs: profile.synthesisTimeoutMs },
      maxRetries: 2,
      abortSignal: AbortSignal.timeout(profile.synthesisTimeoutMs + 30_000),
    })

    const usage = toUsageStats(result.usage, Date.now() - start)
    log('synthesis.done', {
      jobId,
      ms: Date.now() - start,
      outputTokens: usage.outputTokens,
      digests: digests.length,
    })
    const report = extractReport(result.toolCalls)
    if (!report) {
      log('synthesis.rejected', { jobId, reason: 'no valid submit_report call' })
      return { report: null, usage }
    }

    const resolved = resolveSynthesisReport(report, digests)
    if (resolved.salvaged) {
      // Loud and distinct on purpose: how often this fires is the signal for whether the
      // prompt or the forced-toolChoice arm needs work — see extract.ts for the failure
      // mode this is salvaging.
      log('synthesis.salvaged', {
        jobId,
        reason: 'report.report was double-encoded JSON of the whole submission; unwrapped inner markdown',
      })
    }
    if (!resolved.report) {
      log('synthesis.rejected', { jobId, reason: 'schema-echo or empty-citations guard' })
      return { report: null, usage }
    }
    return { report: resolved.report, usage }
  } catch (err) {
    log('synthesis.failed', { jobId, error: String(err) })
    return { report: null, usage: { ...emptyUsage(), durationMs: Date.now() - start } }
  }
}
