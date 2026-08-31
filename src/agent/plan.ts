import { generateText, tool } from 'ai'
import type { Tool } from 'ai'
import { leadModel } from '../lib/llm.js'
import { profiles } from './depth.js'
import { planPrompt } from './prompt.js'
import { ResearchPlan } from './schema.js'
import type { Depth } from './schema.js'
import { log } from '../lib/log.js'
import { withSpan } from '../lib/otel.js'
import { env } from '../env.js'
import { emptyUsage, toUsageStats } from '../lib/usage.js'
import type { UsageStats } from '../lib/usage.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = Tool<any, any>

function fallbackPlan(query: string): ResearchPlan {
  return { subQuestions: [{ id: 's1', question: query }] }
}

function extractPlan(toolCalls: ReadonlyArray<{ toolName: string; input: unknown }>): ResearchPlan | null {
  const submitCall = toolCalls.find((c) => c.toolName === 'submit_plan')
  if (!submitCall) return null
  const parsed = ResearchPlan.safeParse(submitCall.input)
  return parsed.success ? parsed.data : null
}

export async function planResearch(args: {
  query: string
  depth: Depth
  jobId: string
}): Promise<{ plan: ResearchPlan; usage: UsageStats }> {
  const { query, depth, jobId } = args
  const profile = profiles[depth]

  // quick is a single-worker profile — decomposing a one-worker plan wastes an LLM call
  // for zero benefit, so skip straight to the trivial one-sub-question plan.
  if (profile.workers === 1) {
    return { plan: fallbackPlan(query), usage: emptyUsage() }
  }

  const start = Date.now()

  const submitPlanTool: AnyTool = tool({
    description: 'Submit the research plan as a set of independent, parallel sub-questions.',
    inputSchema: ResearchPlan,
  }) as AnyTool

  // Wrapped from the generateText call onward, not from the top of the function: the
  // quick-depth early return above makes no LLM call, and a zero-duration span there would
  // drag the plan-latency tile toward nothing.
  return withSpan(
    'research.plan',
    { 'llm.model': env.IU_LEAD_MODEL },
    async (span) => {
      try {
        const result = await generateText({
          model: leadModel,
          instructions: planPrompt(depth),
          prompt: query,
          tools: { submit_plan: submitPlanTool },
          toolChoice: { type: 'tool', toolName: 'submit_plan' },
          // See synthesize.ts — totalMs bounds retries too; abortSignal is the outer backstop.
          timeout: { totalMs: profile.planTimeoutMs },
          maxRetries: 2,
          abortSignal: AbortSignal.timeout(profile.planTimeoutMs + 30_000),
        })

        const usage = toUsageStats(result.usage, Date.now() - start)
        const plan = extractPlan(result.toolCalls)
        if (!plan) {
          // Counted off the plan actually RETURNED, not hardcoded: the fallback has one
          // sub-question, so a 0 here would break the plan.sub_questions ↔ research.workers
          // correlation for every job that lands on this branch.
          const fallback = fallbackPlan(query)
          span.setAttributes({
            'llm.output_tokens': usage.outputTokens,
            'plan.sub_questions': fallback.subQuestions.length,
            'plan.fallback': true,
          })
          log('plan.fallback', { jobId, reason: 'no valid submit_plan call' })
          return { plan: fallback, usage }
        }
        span.setAttributes({
          'llm.output_tokens': usage.outputTokens,
          'plan.sub_questions': plan.subQuestions.length,
          'plan.fallback': false,
        })
        return { plan, usage }
      } catch (err) {
        // Caught INSIDE the span callback so the span still ends normally and planResearch
        // keeps its "never throws" contract — the fallback plan is the result, not an error.
        // The status is set by hand precisely BECAUSE nothing is rethrown: runInSpan's own
        // handler never sees this failure, so the span would default to `ok` and the planner
        // would be invisible on the Errors tile.
        const fallback = fallbackPlan(query)
        span.setAttributes({ 'plan.sub_questions': fallback.subQuestions.length, 'plan.fallback': true })
        span.setStatus('error', String(err).slice(0, 300))
        log('plan.fallback', { jobId, reason: String(err) })
        return { plan: fallback, usage: { ...emptyUsage(), durationMs: Date.now() - start } }
      }
    },
    'client',
  )
}
