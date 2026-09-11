import { generateText, tool, isStepCount, hasToolCall } from 'ai'
import type { Tool, StopCondition, ToolSet } from 'ai'
import { workerModel } from '../lib/llm.js'
import { buildTools } from './tools.js'
import { profiles } from './depth.js'
import { workerPrompt } from './prompt.js'
import { WorkerDigest } from './schema.js'
import type { Depth } from './schema.js'
import { createLedger, type LedgerSnapshot } from './ledger.js'
import { groundDigest } from './ground.js'
import { log } from '../lib/log.js'
import { withSpan } from '../lib/otel.js'
import { emptyUsage, toUsageStats } from '../lib/usage.js'
import type { UsageStats } from '../lib/usage.js'
import { WORKER_ABORT_GRACE_MS } from './round.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = Tool<any, any>

function extractDigest(toolCalls: ReadonlyArray<{ toolName: string; input: unknown }>): WorkerDigest | null {
  const submitCall = toolCalls.find((c) => c.toolName === 'submit_digest')
  if (!submitCall) return null
  const parsed = WorkerDigest.safeParse(submitCall.input)
  return parsed.success ? parsed.data : null
}

export async function runWorker(args: {
  subQuestion: string
  depth: Depth
  jobId: string
  round: number
  // Wall-clock deadline for the WHOLE job's research phase (all rounds), reserved so
  // synthesis always keeps its full budget. A worker still running past this point banks
  // its digest (forced submit_digest) rather than being aborted — see prepareStep below.
  researchDeadlineAt: number
}): Promise<{ digest: WorkerDigest | null; usage: UsageStats; ledger: LedgerSnapshot; error?: string }> {
  const { subQuestion, depth, jobId, round, researchDeadlineAt } = args
  const profile = profiles[depth]
  const start = Date.now()

  // What this worker's tools ACTUALLY retrieved, failed on, or merely glimpsed as a search
  // snippet. It backfills the digest's sourcesRead, is the sources floor when the worker
  // fails entirely, and — via groundDigest below — decides which findings may survive.
  const ledger = createLedger()
  const researchTools = buildTools({
    ledger,
    jobId,
    searchDepth: profile.searchDepth,
    contextSize: profile.searchContextSize,
    maxResults: profile.maxSearchResults,
    maxSearches: profile.maxSearches,
    // Round 1 only — see DepthProfile.dualSearchFirstRound for why the gap round is excluded.
    dualSearch: profile.dualSearchFirstRound && round === 1,
  })

  // The done tool — no `execute` means the loop halts when the model calls it.
  const submitDigestTool: AnyTool = tool({
    description:
      'Submit the final digest for your sub-question. Call this when you have gathered sufficient evidence and are ready to report back. This is the ONLY way to deliver your answer — do not write plain text.',
    inputSchema: WorkerDigest,
  }) as AnyTool

  const allTools: ToolSet = {
    ...researchTools,
    submit_digest: submitDigestTool,
  }

  // Context-size guard (Bug 1 fix): measures the LAST step's real input size, not a
  // cumulative sum across steps — each step re-sends the whole conversation, so summing
  // grows quadratically and never reflects actual context size the model is facing.
  const contextGuard: StopCondition<ToolSet> = ({ steps }) => {
    const last = steps[steps.length - 1]
    return (last?.usage?.inputTokens ?? 0) > profile.maxContextTokens
  }

  // The span wraps the try/catch rather than living inside it: a worker that fails must
  // still close its span with an error status, and runWorker must still never throw.
  return withSpan(
    'research.worker',
    { 'research.round': round, 'worker.sub_question': subQuestion.slice(0, 200) },
    async (span) => {
      let stepCount = 0
      // Which ceiling cut this worker off, or undefined if it finished on its own terms.
      // FIRST reason only — once the digest is forced, every later step trivially forces too.
      let forcedReason: 'step_cap' | 'context_cap' | 'worker_deadline' | 'job_deadline' | undefined

      try {
        const result = await generateText({
          model: workerModel,
          instructions: workerPrompt(depth),
          prompt: subQuestion,
          tools: allTools,
          stopWhen: [isStepCount(profile.workerMaxSteps), hasToolCall('submit_digest'), contextGuard],
          // Force the digest in-loop before any ceiling is hit — step, context, worker
          // wall-clock, OR the job's research deadline. A worker that runs out of time dies
          // with all its evidence; one that submits early banks a digest instead. The
          // deadline arms matter most: they turn the dominant failure (timeout = total loss)
          // into a partial win — and NEVER a hard kill (that reintroduces the exact bug class
          // already fixed: a missing try/catch on searchWeb losing 60% of workers).
          prepareStep: ({ stepNumber, steps }) => {
            const last = steps[steps.length - 1]
            const nearContext = (last?.usage?.inputTokens ?? 0) > profile.maxContextTokens * 0.8
            const nearDeadline = Date.now() - start > profile.workerTimeoutMs * 0.6
            // Job-level force arm: the research phase's whole budget is nearly spent, so bank
            // now rather than risk running past the point synthesis needs its full timeout.
            const nearJobDeadline = Date.now() > researchDeadlineAt - 30_000
            const stepCap = stepNumber >= profile.workerMaxSteps - 1
            if (stepCap || nearContext || nearDeadline || nearJobDeadline) {
              // Same order the condition above evaluates in, so the label always names the
              // arm that actually fired.
              forcedReason ??= stepCap
                ? 'step_cap'
                : nearContext
                  ? 'context_cap'
                  : nearDeadline
                    ? 'worker_deadline'
                    : 'job_deadline'
              return { activeTools: ['submit_digest'], toolChoice: { type: 'tool', toolName: 'submit_digest' } }
            }
            return {}
          },
          // See synthesize.ts — totalMs bounds retries too; abortSignal is the outer backstop.
          // The grace beyond workerTimeoutMs is WORKER_ABORT_GRACE_MS (round.ts), which
          // shouldRetryRound's margin also accounts for — stated once, not as two literals.
          timeout: { totalMs: profile.workerTimeoutMs },
          maxRetries: 2,
          abortSignal: AbortSignal.timeout(profile.workerTimeoutMs + WORKER_ABORT_GRACE_MS),
          onStepEnd: (step) => {
            stepCount++
            log('worker.step', { jobId, round, tools: step.toolCalls.map((c) => c.toolName) })
          },
        })

        const usage = toUsageStats(result.usage, Date.now() - start)
        const raw = extractDigest(result.toolCalls)

        // Ground BEFORE the digest leaves the worker: a finding citing a page this worker
        // never retrieved is stripped here, so it never enters the synthesis prompt and
        // therefore cannot surface in the report's prose either — not just its citations.
        const digest = raw ? groundDigest(raw, ledger) : null
        let stripped = 0
        if (raw && digest) {
          stripped = raw.findings.length - digest.findings.length
          if (stripped > 0) {
            log('worker.ungrounded', { jobId, round, stripped, kept: digest.findings.length })
          }
        }

        const snapshot = ledger.snapshot()
        span.setAttributes({
          'worker.steps': stepCount,
          'worker.forced_submit': forcedReason,
          'worker.digest': digest !== null,
          'worker.findings_kept': digest?.findings.length ?? 0,
          'worker.findings_stripped': stripped,
          'llm.input_tokens': usage.inputTokens,
          'llm.output_tokens': usage.outputTokens,
          'ledger.retrieved': snapshot.retrieved.length,
          'ledger.failed': snapshot.failed.length,
          'ledger.snippet': snapshot.snippet.length,
        })

        return { digest, usage, ledger: snapshot }
      } catch (err) {
        // A worker that throws/times out must not kill the whole job — degrade to null.
        // The ledger snapshot is still returned so the job-level fallback still counts the
        // pages this worker actually read (and the fetches it lost) before it failed.
        const snapshot = ledger.snapshot()
        span.setAttributes({
          'worker.steps': stepCount,
          'worker.forced_submit': forcedReason,
          'worker.digest': false,
          'worker.findings_kept': 0,
          'worker.findings_stripped': 0,
          'worker.error': String(err).slice(0, 300),
          'worker.elapsed_ms': Date.now() - start,
          'worker.budget_ms': profile.workerTimeoutMs,
          'ledger.retrieved': snapshot.retrieved.length,
          'ledger.failed': snapshot.failed.length,
          'ledger.snippet': snapshot.snippet.length,
        })
        // Marked failed on the span but NOT rethrown: a dead worker is a degraded job, not a
        // failed one, and the root span stays green unless the job itself failed.
        span.setStatus('error', String(err).slice(0, 300))
        log('worker.failed', {
          jobId,
          round,
          elapsedMs: Date.now() - start,
          budgetMs: profile.workerTimeoutMs,
          subQuestion: subQuestion.slice(0, 200),
          error: String(err),
        })
        return {
          digest: null,
          usage: { ...emptyUsage(), durationMs: Date.now() - start },
          ledger: snapshot,
          // Threaded up through dispatchRound so a zero-digest round can name the real
          // upstream cause instead of the job falling back to a generic "budget exhausted"
          // stub — see round.ts's header for the evidence.
          error: String(err).slice(0, 300),
        }
      }
    },
    'internal',
  )
}
