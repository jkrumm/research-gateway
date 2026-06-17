import { generateText, tool, stepCountIs, hasToolCall } from 'ai'
import type { Tool, StopCondition, ToolSet } from 'ai'
import { loopModel } from '../lib/llm.js'
import { buildTools } from './tools.js'
import { profiles } from './depth.js'
import { systemPrompt } from './prompt.js'
import { ResearchReport } from './schema.js'
import type { Depth } from './schema.js'
import { log } from '../lib/log.js'
import { computeCost } from '../lib/usage.js'
import { env } from '../env.js'

export interface UsageStats {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  reasoningTokens: number
  durationMs: number
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = Tool<any, any>

// Bounded budget for the final salvage synthesis call (one step over a large context).
const SALVAGE_TIMEOUT_MS = 90_000

// Pull a valid ResearchReport out of a result's tool calls, or null if absent/malformed.
function extractReport(
  toolCalls: ReadonlyArray<{ toolName: string; input: unknown }>,
): ResearchReport | null {
  const submitCall = toolCalls.find((c) => c.toolName === 'submit_report')
  if (!submitCall) return null
  const parsed = ResearchReport.safeParse(submitCall.input)
  return parsed.success ? parsed.data : null
}

export async function runResearch(
  input: { query: string; depth?: Depth; jobId?: string },
  onUsage?: (stats: UsageStats) => void,
): Promise<ResearchReport> {
  const depth = input.depth ?? 'standard'
  const jobId = input.jobId ?? '-'
  const profile = profiles[depth]
  const start = Date.now()

  log('research.start', { jobId, depth, queryPreview: input.query.slice(0, 200) })

  const sources = new Set<string>()
  const researchTools = buildTools((u) => sources.add(u), jobId)

  // The done tool — no `execute` means the loop halts when the model calls it.
  // Its input IS the final structured report.
  // Cast as AnyTool to satisfy ToolSet's index signature under exactOptionalPropertyTypes.
  const submitReportTool: AnyTool = tool({
    description:
      'Submit the final research report. Call this when you have gathered sufficient evidence and are ready to deliver your answer. This is the ONLY way to deliver the answer — do not write plain text.',
    inputSchema: ResearchReport,
  }) as AnyTool

  const allTools: ToolSet = {
    ...researchTools,
    submit_report: submitReportTool,
  }

  // Custom budget stop condition: halts if token budget or wall-clock is exceeded.
  // StopCondition receives only `{ steps }` — confirmed from ai@6.0.205 types.
  const budgetStop: StopCondition<ToolSet> = ({ steps }) => {
    const elapsed = Date.now() - start
    if (elapsed > profile.timeoutMs) return true

    let totalTokens = 0
    for (const step of steps) {
      const u = step.usage
      if (u.totalTokens !== undefined) {
        totalTokens += u.totalTokens
      } else {
        totalTokens += (u.inputTokens ?? 0) + (u.outputTokens ?? 0)
      }
    }
    return totalTokens > profile.maxTokens
  }

  const signal = AbortSignal.timeout(profile.timeoutMs)

  let result: Awaited<ReturnType<typeof generateText>>
  try {
    result = await generateText({
      model: loopModel,
      system: systemPrompt(depth),
      prompt: input.query,
      tools: allTools,
      stopWhen: [stepCountIs(profile.maxSteps), hasToolCall('submit_report'), budgetStop],
      abortSignal: signal,
      onStepFinish: (step) => {
        log('research.step', {
          jobId,
          tools: step.toolCalls.map((c) => c.toolName),
          finishReason: step.finishReason,
        })
      },
    })
  } catch (err) {
    // Wall-clock ceiling fired → degrade gracefully. Any other error → surface it.
    if (signal.aborted) {
      const wallMs = Date.now() - start
      log('research.aborted', { jobId, wallMs, sources: sources.size })
      return {
        report: 'Research halted at the wall-clock ceiling before a final report could be produced.',
        citations: [],
        sources: [...sources],
      }
    }
    log('research.error', { jobId, error: String(err) })
    throw err
  }

  // Usage accumulators — extended below if a salvage call runs.
  let inputTokens = result.totalUsage.inputTokens ?? 0
  let outputTokens = result.totalUsage.outputTokens ?? 0
  let totalTokens = result.totalUsage.totalTokens ?? 0
  let reasoningTokens =
    result.totalUsage.outputTokenDetails?.reasoningTokens ?? result.totalUsage.reasoningTokens ?? 0

  // Happy path: the loop terminated by calling submit_report with a valid payload.
  let report = extractReport(result.toolCalls)
  let reason: 'submit_report' | 'salvaged' | 'fallback' = report ? 'submit_report' : 'fallback'

  // Salvage: the loop halted at a budget/step ceiling (or with malformed input) WITHOUT a
  // valid report. Rather than discard all gathered evidence, force ONE final synthesis call
  // that must call submit_report — turning wasted spend into a cited answer. The first user
  // turn + the loop's generated messages are replayed so the model has the full evidence;
  // only submit_report is offered (no more researching) and a short timeout bounds the cost.
  if (!report) {
    try {
      const salvage = await generateText({
        model: loopModel,
        system: systemPrompt(depth),
        messages: [
          { role: 'user', content: input.query },
          ...result.response.messages,
          {
            role: 'user',
            content:
              'You have reached the research budget ceiling — stop researching now and call submit_report immediately, synthesizing from the evidence already gathered above. Requirements: (1) `report` is the COMPLETE markdown answer for the user — write the answer directly, with NO preamble or commentary about your process or what you did/didn’t gather; (2) `citations` must tie each key claim to a source URL seen above; (3) `sources` must list every URL you consulted above.',
          },
        ],
        tools: { submit_report: submitReportTool },
        toolChoice: { type: 'tool', toolName: 'submit_report' },
        abortSignal: AbortSignal.timeout(SALVAGE_TIMEOUT_MS),
      })
      inputTokens += salvage.totalUsage.inputTokens ?? 0
      outputTokens += salvage.totalUsage.outputTokens ?? 0
      totalTokens += salvage.totalUsage.totalTokens ?? 0
      reasoningTokens +=
        salvage.totalUsage.outputTokenDetails?.reasoningTokens ?? salvage.totalUsage.reasoningTokens ?? 0
      const salvaged = extractReport(salvage.toolCalls)
      if (salvaged) {
        report = salvaged
        reason = 'salvaged'
      }
    } catch (err) {
      log('research.salvageFailed', { jobId, error: String(err) })
    }
  }

  const wallMs = Date.now() - start

  if (onUsage) {
    onUsage({ inputTokens, outputTokens, totalTokens, reasoningTokens, durationMs: wallMs })
  }

  // Last-resort degraded stub: even the forced salvage produced no valid report.
  if (!report) {
    report = {
      report: result.text || 'Research halted at the budget ceiling before producing a final report.',
      citations: [],
      sources: [...sources],
    }
  }

  // Sources floor: never drop the URLs we actually touched. If the model returned an empty
  // sources list (common under a forced salvage call), backfill from the accumulator.
  if (report.sources.length === 0 && sources.size > 0) {
    report.sources = [...sources]
  }

  const { costUsd } = computeCost(env.IU_MODEL, inputTokens, outputTokens)
  log('research.done', {
    jobId,
    reason,
    citations: report.citations.length,
    sources: report.sources.length,
    inputTokens,
    outputTokens,
    totalTokens,
    reasoningTokens,
    costUsd,
    steps: result.steps.length,
    wallMs,
  })
  return report
}
