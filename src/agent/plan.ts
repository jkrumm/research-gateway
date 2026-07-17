import { generateText, tool } from 'ai'
import type { Tool } from 'ai'
import { leadModel } from '../lib/llm.js'
import { profiles } from './depth.js'
import { planPrompt } from './prompt.js'
import { ResearchPlan } from './schema.js'
import type { Depth } from './schema.js'
import { log } from '../lib/log.js'
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

  try {
    const result = await generateText({
      model: leadModel,
      system: planPrompt(depth),
      prompt: query,
      tools: { submit_plan: submitPlanTool },
      toolChoice: { type: 'tool', toolName: 'submit_plan' },
      // See synthesize.ts — totalMs bounds retries too; abortSignal is the outer backstop.
      timeout: { totalMs: profile.planTimeoutMs },
      maxRetries: 2,
      abortSignal: AbortSignal.timeout(profile.planTimeoutMs + 30_000),
    })

    const usage = toUsageStats(result.totalUsage, Date.now() - start)
    const plan = extractPlan(result.toolCalls)
    if (!plan) {
      log('plan.fallback', { jobId, reason: 'no valid submit_plan call' })
      return { plan: fallbackPlan(query), usage }
    }
    return { plan, usage }
  } catch (err) {
    log('plan.fallback', { jobId, reason: String(err) })
    return { plan: fallbackPlan(query), usage: { ...emptyUsage(), durationMs: Date.now() - start } }
  }
}
