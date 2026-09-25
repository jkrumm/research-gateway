import { generateText, tool } from 'ai'
import type { Tool } from 'ai'
import { leadModel, leadSubmitChoice } from '../lib/llm.js'
import { consistencyPrompt } from './prompt.js'
// The schema (runtime validator) and its inferred shape (type) share a name, so the value
// import carries an inline type-only rename rather than a second import statement.
import { ConsistencyReview, type ConsistencyReview as ConsistencyReviewInput } from './schema.js'
import { resolveConsistencyReview } from './extract.js'
import type { ConsistencyResolution } from './extract.js'
import { log } from '../lib/log.js'
import { withSpan } from '../lib/otel.js'
import { env } from '../env.js'
import { emptyUsage, toUsageStats } from '../lib/usage.js'
import type { UsageStats } from '../lib/usage.js'
import { createIdleWatchdog } from '../lib/idle-watchdog.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = Tool<any, any>

// The post-synthesis internal-consistency pass (issue #5): one lead-model call that reads the
// finished report body back and returns either a clean verdict or a set of find/replace
// spans. No tools, no retrieval — the contradicting statements are already in the text under
// review, and the field-notes case that motivated this (parallel digests disagreeing inside
// one report) needs no new evidence to catch.
//
// Never throws, like synthesize: a failed or malformed review degrades to the ORIGINAL
// report — a flawed report that reaches the caller still beats no report, and grounding
// downstream is unaffected either way. The reviewer contributes find/replace spans only,
// applied by exact match in resolveConsistencyReview; citations, sources and unverified pass
// through untouched, and groundReport re-derives them after.

function extractReview(toolCalls: ReadonlyArray<{ toolName: string; input: unknown }>): ConsistencyReviewInput | null {
  const reviewCall = toolCalls.find((c) => c.toolName === 'submit_review')
  if (!reviewCall) return null
  const parsed = ConsistencyReview.safeParse(reviewCall.input)
  return parsed.success ? parsed.data : null
}

// One line per applied span, bounded — long enough to recognize the passage in a trace,
// short enough that a HyperDX row stays a row.
const SPAN_SNIPPET_CHARS = 120

function truncateForSpan(text: string): string {
  return text.length <= SPAN_SNIPPET_CHARS ? text : `${text.slice(0, SPAN_SNIPPET_CHARS)}…`
}

export async function reviewConsistency(args: {
  report: string
  jobId: string
  signal?: AbortSignal | undefined
}): Promise<{
  report: string
  corrected: boolean
  appliedEdits: ConsistencyResolution['appliedEdits']
  vetoed: boolean
  usage: UsageStats
}> {
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
      const idle = createIdleWatchdog(env.RESEARCH_IDLE_TIMEOUT_MS, args.signal)
      idle.arm()
      try {
        const result = await generateText({
          model: leadModel,
          instructions: consistencyPrompt(),
          prompt: report,
          tools: { submit_review: submitReviewTool },
          toolChoice: leadSubmitChoice('submit_review'),
          maxRetries: 2,
          abortSignal: idle.signal,
          onStepEnd: () => idle.arm(),
          onToolExecutionStart: () => idle.arm(),
          onToolExecutionEnd: () => idle.arm(),
        })

        const usage = toUsageStats(result.usage, Date.now() - start, result.steps)
        const resolution = resolveConsistencyReview(report, extractReview(result.toolCalls))
        // An accepted edit is never silent: the spans land on the span and the done log,
        // where the trace can show exactly what the review pass changed in the body.
        // Truncated per span — observability, not a changelog; the full text is the report.
        const applied = resolution.appliedEdits.map(
          (e) => `${truncateForSpan(e.find)} -> ${truncateForSpan(e.replace)}`,
        )
        span.setAttributes({
          'llm.output_tokens': usage.outputTokens,
          // 'vetoed' — the reviewer tried to move, split, delete or invent a citation token
          // and the resolver refused the whole set — is its own outcome, distinct from a
          // clean review ('consistent') and a clean correction ('corrected'): a trace can
          // then show the reviewer overstepped onto citations rather than merely finding
          // nothing to fix.
          'consistency.outcome': resolution.vetoed
            ? 'vetoed'
            : resolution.corrected
              ? 'corrected'
              : 'consistent',
          'consistency.edits': resolution.appliedEdits.length,
          // Span attributes are scalar-only (SpanAttributes in otel.ts), so the list goes
          // out JSON-encoded; the log path stringifies arrays itself.
          'consistency.applied': JSON.stringify(applied),
        })
        log('consistency.done', {
          jobId,
          ms: Date.now() - start,
          outputTokens: usage.outputTokens,
          corrected: resolution.corrected,
          vetoed: resolution.vetoed,
          edits: resolution.appliedEdits.length,
          applied,
        })
        return { ...resolution, usage }
      } catch (err) {
        // Caught INSIDE the span callback so the span ends normally and this pass keeps the
        // never-throws contract — a failed review is the original report, not an error.
        // Status is set by hand because nothing is rethrown (same reasoning as synthesize.ts).
        span.setAttributes({ 'consistency.outcome': 'failed' })
        span.setStatus('error', String(err).slice(0, 300))
        log('consistency.failed', { jobId, error: String(err) })
        return {
          report,
          corrected: false,
          appliedEdits: [],
          vetoed: false,
          usage: { ...emptyUsage(), durationMs: Date.now() - start },
        }
      } finally {
        idle.clear()
      }
    },
    'client',
  )
}
