import { generateText, tool } from 'ai'
import type { Tool } from 'ai'
import { planModel, leadModelWithDoubledBudget, leadSubmitChoice } from '../lib/llm.js'
import type { IuLanguageModel } from '../lib/llm.js'
import { profiles } from './depth.js'
import { planPrompt, backgroundSection } from './prompt.js'
import { ResearchPlan } from './schema.js'
import type { Depth } from './schema.js'
import { log } from '../lib/log.js'
import { withSpan } from '../lib/otel.js'
import { env } from '../env.js'
import { addUsage, emptyUsage, toUsageStats } from '../lib/usage.js'
import type { UsageStats } from '../lib/usage.js'
import { createIdleWatchdog } from '../lib/idle-watchdog.js'
import type { IdleWatchdog } from '../lib/idle-watchdog.js'
import { ROLE_BUDGETS } from '../lib/llm.js'

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
  context?: string | undefined
  depth: Depth
  jobId: string
  signal?: AbortSignal | undefined
}): Promise<{ plan: ResearchPlan; usage: UsageStats }> {
  const { query, context, depth, jobId } = args
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

  const callPlan = (model: IuLanguageModel, idle: IdleWatchdog) =>
    generateText({
      model,
      instructions: planPrompt(depth),
      prompt: query + backgroundSection(context),
      tools: { submit_plan: submitPlanTool },
      toolChoice: leadSubmitChoice('submit_plan'),
      maxRetries: 2,
      abortSignal: idle.signal,
      onStepEnd: () => idle.arm(),
      onToolExecutionStart: () => idle.arm(),
      onToolExecutionEnd: () => idle.arm(),
    })

  // Wrapped from the generateText call onward, not from the top of the function: the
  // quick-depth early return above makes no LLM call, and a zero-duration span there would
  // drag the plan-latency tile toward nothing.
  return withSpan(
    'research.plan',
    { 'llm.model': env.IU_LEAD_MODEL },
    async (span) => {
      // No wall-clock ceiling (settled 2026-09-12) — only an idle watchdog: aborted when a
      // step has produced no activity for `RESEARCH_IDLE_TIMEOUT_MS`. See idle-watchdog.ts.
      const idle = createIdleWatchdog(env.RESEARCH_IDLE_TIMEOUT_MS, args.signal)
      idle.arm()
      try {
        let result = await callPlan(planModel, idle)
        let usage = toUsageStats(result.usage, 0)

        // A starved call (empty/truncated tool args) reads identically to "the model chose
        // not to call the tool" unless finishReason is checked — log it distinctly so the two
        // don't get confused on the fallback tile, and give the budget one more shot before
        // accepting the fallback plan.
        if (result.finishReason === 'length') {
          log('plan.length', { jobId, outputTokens: usage.outputTokens, budget: ROLE_BUDGETS.plan })
          result = await callPlan(leadModelWithDoubledBudget('plan'), idle)
          usage = addUsage(usage, toUsageStats(result.usage, 0))
          if (result.finishReason === 'length') {
            log('plan.length', { jobId, outputTokens: usage.outputTokens, retried: true })
          }
        }
        usage = { ...usage, durationMs: Date.now() - start }

        const plan = extractPlan(result.toolCalls)
        if (!plan) {
          // Counted off the plan actually RETURNED, not hardcoded: the fallback has one
          // sub-question, so a 0 here would break the plan.sub_questions ↔ research.workers
          // correlation for every job that lands on this branch.
          const fallback = fallbackPlan(query)
          span.setAttributes({
            'llm.output_tokens': usage.outputTokens,
            'llm.finish_reason': result.finishReason,
            'plan.sub_questions': fallback.subQuestions.length,
            'plan.fallback': true,
          })
          log('plan.fallback', {
            jobId,
            reason: result.finishReason === 'length' ? 'starved: finishReason=length' : 'no valid submit_plan call',
            finishReason: result.finishReason,
          })
          return { plan: fallback, usage }
        }
        span.setAttributes({
          'llm.output_tokens': usage.outputTokens,
          'llm.finish_reason': result.finishReason,
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
      } finally {
        idle.clear()
      }
    },
    'client',
  )
}
