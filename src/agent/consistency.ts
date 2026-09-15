import { generateText, tool } from 'ai'
import type { Tool } from 'ai'
import { leadModel } from '../lib/llm.js'
import { consistencyPrompt } from './prompt.js'
import { ConsistencyReview } from './schema.js'
import type { ConsistencyReview as ConsistencyReviewInput } from './schema.js'
import { resolveConsistencyReview } from './extract.js'
import { log } from '../lib/log.js'
import { withSpan } from '../lib/otel.js'
import { env } from '../env.js'
import { emptyUsage, toUsageStats } from '../lib/usage.js'
import type { UsageStats } from '../lib/usage.js'
import { createIdleWatchdog } from '../lib/idle-watchdog.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = Tool<any, any>

// The post-synthesis internal-consistency pass (issue #5): one lead-model call that reads the
// finished report body back and returns either a clean verdict or a corrected body. No tools,
// no retrieval — the contradicting statements are already in the text under review, and the
// field-notes case that motivated this (parallel digests disagreeing inside one report) needs
// no new evidence to catch.
//
// Never throws, like synthesize: a failed or malformed review degrades to the ORIGINAL
// report — a flawed report that reaches the caller still beats no report, and grounding
// downstream is unaffected either way. The reviewer contributes prose only; citations,
// sources and unverified pass through untouched, and groundReport re-derives them after.

function extractReview(toolCalls: ReadonlyArray<{ toolName: string; input: unknown }>): ConsistencyReviewInput | null {
  const reviewCall = toolCalls.find((c) => c.toolName === 'submit_review')
  if (!reviewCall) return null
  const parsed = ConsistencyReview.safeParse(reviewCall.input)
  return parsed.success ? parsed.data : null
}

export async function reviewConsistency(args: {
  report: string
  jobId: string
}): Promise<{ report: string; corrected: boolean; usage: UsageStats }> {
  const { report, jobId } = args
  const start = Date.now()

  const submitReviewTool: AnyTool = tool({
    description:
      'Submit the consistency verdict for the report under review. This is the ONLY way to deliver the review — do not write plain text.',
    inputSchema: ConsistencyReview,
  }) as AnyTool

  return withSpan(
    'research.consistency',
    { 'llm.model': env.IU_LEAD_MODEL, 'consistency.report_chars': report.length },
    async (span) => {
      // Same liveness rule as every other lead call (see synthesize.ts) — no wall-clock
      // ceiling, only the idle watchdog.
      const idle = createIdleWatchdog(env.RESEARCH_IDLE_TIMEOUT_MS)
      idle.arm()
      try {
        const result = await generateText({
          model: leadModel,
          instructions: consistencyPrompt(),
          prompt: report,
          tools: { submit_review: submitReviewTool },
          toolChoice: { type: 'tool', toolName: 'submit_review' },
          maxRetries: 2,
          abortSignal: idle.signal,
          onStepEnd: () => idle.arm(),
          onToolExecutionStart: () => idle.arm(),
          onToolExecutionEnd: () => idle.arm(),
        })

        const usage = toUsageStats(result.usage, Date.now() - start)
        const resolution = resolveConsistencyReview(report, extractReview(result.toolCalls))
        span.setAttributes({
          'llm.output_tokens': usage.outputTokens,
          'consistency.outcome': resolution.corrected ? 'corrected' : 'consistent',
        })
        log('consistency.done', {
          jobId,
          ms: Date.now() - start,
          outputTokens: usage.outputTokens,
          corrected: resolution.corrected,
        })
        return { ...resolution, usage }
      } catch (err) {
        // Caught INSIDE the span callback so the span ends normally and this pass keeps the
        // never-throws contract — a failed review is the original report, not an error.
        // Status is set by hand because nothing is rethrown (same reasoning as synthesize.ts).
        span.setAttributes({ 'consistency.outcome': 'failed' })
        span.setStatus('error', String(err).slice(0, 300))
        log('consistency.failed', { jobId, error: String(err) })
        return { report, corrected: false, usage: { ...emptyUsage(), durationMs: Date.now() - start } }
      } finally {
        idle.clear()
      }
    },
    'client',
  )
}
