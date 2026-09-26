import { generateText, tool, hasToolCall, stepCountIs, NoSuchToolError } from 'ai'
import type { Tool, StopCondition, ToolSet } from 'ai'
import { workerModel, workerSubmitChoice } from '../lib/llm.js'
import { buildTools } from './tools.js'
import { profiles } from './depth.js'
import { workerPrompt, backgroundSection } from './prompt.js'
import { WorkerDigest } from './schema.js'
import type { Depth } from './schema.js'
import { createLedger, type LedgerSnapshot, type RetrievalLedger } from './ledger.js'
import { groundDigest } from './ground.js'
import { shouldForceSubmit, buildSalvageMessages, buildSalvageInstruction, SALVAGE_TOOL_NAME } from './salvage.js'
import { log } from '../lib/log.js'
import { withSpan } from '../lib/otel.js'
import { emptyUsage, addUsage, toUsageStats } from '../lib/usage.js'
import type { UsageStats } from '../lib/usage.js'
import { createIdleWatchdog } from '../lib/idle-watchdog.js'
import { env } from '../env.js'

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
  context?: string | undefined
  depth: Depth
  jobId: string
  round: number
  signal?: AbortSignal | undefined
}): Promise<{ digest: WorkerDigest | null; usage: UsageStats; ledger: LedgerSnapshot; error?: string }> {
  const { subQuestion, context, depth, jobId, round } = args
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
    maxContextTokens: profile.maxContextTokens,
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
      let forcedReason: 'context_cap' | undefined
      // Whether the one-shot salvage call (below) is what actually produced the digest.
      let salvaged = false

      // No step/turn limit and no wall-clock ceiling (settled 2026-09-12) — a worker runs
      // until it submits its digest, or this fires because a step has produced NO
      // step/tool activity for `RESEARCH_IDLE_TIMEOUT_MS`. See lib/idle-watchdog.ts.
      const idle = createIdleWatchdog(env.RESEARCH_IDLE_TIMEOUT_MS, args.signal)
      idle.arm()

      try {
        const result = await generateText({
          model: workerModel,
          instructions: workerPrompt(depth),
          prompt: subQuestion + backgroundSection(context),
          tools: allTools,
          stopWhen: [hasToolCall('submit_digest'), contextGuard],
          // Force the digest in-loop before the context ceiling is hit — a worker that
          // never submits still banks a digest instead of being cut off empty-handed.
          prepareStep: ({ steps }) => {
            // Predictive, not just reactive: a step that is already growing fast enough to
            // blow past the ceiling next step forces the submit-only step now, a step early
            // — see salvage.ts's header for the measured jump this catches that the flat 80%
            // check alone missed.
            if (shouldForceSubmit({ steps, maxContextTokens: profile.maxContextTokens })) {
              forcedReason ??= 'context_cap'
              return { activeTools: ['submit_digest'], toolChoice: workerSubmitChoice('submit_digest') }
            }
            return {}
          },
          maxRetries: 2,
          abortSignal: idle.signal,
          onStepEnd: (step) => {
            stepCount++
            idle.arm()
            recordDeliveredText(step.toolResults, ledger)
            log('worker.step', { jobId, round, tools: step.toolCalls.map((c) => c.toolName), finishReason: step.finishReason })
            // A starved step (empty/truncated output) reads exactly like a step that simply
            // chose not to call a tool unless finishReason is checked — this is the one signal
            // that tells the two apart. No retry here (unlike plan/synthesis): the loop keeps
            // stepping under its own stopWhen/prepareStep ceiling regardless.
            if (step.finishReason === 'length') {
              log('worker.length', { jobId, round, stepNumber: step.stepNumber })
            }
          },
          onToolExecutionStart: () => idle.arm(),
          onToolExecutionEnd: () => idle.arm(),
        })

        let usage = toUsageStats(result.usage, Date.now() - start, result.steps)
        let raw = extractDigest(result.toolCalls)

        // Salvage: the loop ended (contextGuard's stopWhen, or the model simply stopping)
        // without ever calling submit_digest. Rather than banking a null digest outright, make
        // ONE more call — same model/instructions, the full transcript so far, submit_digest as
        // the only tool — and give the model one last chance to report what it actually found.
        // See salvage.ts's header for the measured failure this recovers from.
        if (!raw) {
          try {
            const salvageMessages = buildSalvageMessages({
              userPrompt: subQuestion + backgroundSection(context),
              transcript: result.response.messages,
              instruction: buildSalvageInstruction(),
            })
            const salvageResult = await generateText({
              model: workerModel,
              instructions: workerPrompt(depth),
              messages: salvageMessages,
              tools: { submit_digest: submitDigestTool },
              // Resolves to 'auto' at effort high — DeepSeek thinking mode rejects a forced
              // tool_choice — so this still relies on submit_digest being the only tool on
              // offer, same as llm-settings.ts's submitToolChoice contract everywhere else.
              toolChoice: workerSubmitChoice(SALVAGE_TOOL_NAME),
              stopWhen: stepCountIs(1),
              maxRetries: 2,
              // A model that, mid-transcript-replay, still reaches for a tool no longer on
              // offer (brainNotes/searchWeb/fetchPage — only submit_digest is declared for
              // this call) hits AI_NoSuchToolError. The AI SDK already degrades an unrepaired
              // one into a non-throwing "invalid" tool-call entry rather than an escaping
              // exception (ai/dist/index.js's parseToolCall: every repair-failure path is
              // caught by the SAME outer try that already catches the bare NoSuchToolError),
              // so `repairToolCall` cannot change whether this call survives — passing a
              // narrower `activeTools` on top of the already-single-tool `tools` object above
              // would be equally inert for the same reason. What this hook DOES add is
              // visibility: without it, a stray tool call here degrades silently into the
              // SDK's internal invalid-entry bookkeeping with nothing in our own logs to show
              // it happened.
              repairToolCall: async ({ toolCall, error }) => {
                if (NoSuchToolError.isInstance(error)) {
                  log('worker.salvage_repair', { jobId, round, attemptedTool: toolCall.toolName })
                }
                return null
              },
              abortSignal: idle.signal,
              onStepEnd: () => idle.arm(),
              onToolExecutionStart: () => idle.arm(),
              onToolExecutionEnd: () => idle.arm(),
            })
            const salvageRaw = extractDigest(salvageResult.toolCalls)
            usage = { ...addUsage(usage, toUsageStats(salvageResult.usage, 0, salvageResult.steps)), durationMs: Date.now() - start }
            if (salvageRaw) {
              raw = salvageRaw
              salvaged = true
            }
            log('worker.salvage', { jobId, round, ok: salvaged, findings: salvageRaw?.findings.length ?? 0 })
          } catch (salvageErr) {
            // The salvage call itself can fail (transcript too large for the model's real
            // window, idle timeout, etc.) — fall back to today's null-digest behaviour rather
            // than let it escape runWorker, which must never throw.
            log('worker.salvage', { jobId, round, ok: false, error: String(salvageErr).slice(0, 300) })
          }
        }

        // Ground BEFORE the digest leaves the worker: a finding citing a page this worker
        // never retrieved is stripped here, so it never enters the synthesis prompt and
        // therefore cannot surface in the report's prose either — not just its citations.
        // The salvage call added no new tool results, so the ledger already has everything
        // it may cite — grounding applies identically to a salvaged digest.
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
          'worker.salvaged': salvaged,
          'worker.digest': digest !== null,
          'worker.findings_kept': digest?.findings.length ?? 0,
          'worker.findings_stripped': stripped,
          'llm.input_tokens': usage.inputTokens,
          'llm.output_tokens': usage.outputTokens,
          'llm.finish_reason': result.finishReason,
          'ledger.retrieved': snapshot.retrieved.length,
          'ledger.missing': snapshot.missing.length,
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
          'worker.salvaged': false,
          'worker.digest': false,
          'worker.findings_kept': 0,
          'worker.findings_stripped': 0,
          'worker.error': String(err).slice(0, 300),
          'worker.elapsed_ms': Date.now() - start,
          'ledger.retrieved': snapshot.retrieved.length,
          'ledger.missing': snapshot.missing.length,
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
      } finally {
        idle.clear()
      }
    },
    'internal',
  )
}

// The text a model was actually handed for a page is what a number in its claim must come
// from (numbers.ts). Read off the step's tool results rather than inside fetchPage so the
// record is exactly the delivered text — after the page-text budget cut — and nothing else.
// Only fetchPage returns a single page's text under its own URL; the other tools' outputs
// are left unrecorded, which makes the numeric check skip their citations, never fail them.
function recordDeliveredText(results: ReadonlyArray<{ toolName: string; output: unknown }>, ledger: RetrievalLedger): void {
  for (const r of results) {
    if (r.toolName !== 'fetchPage') continue
    const out = r.output as { url?: unknown; text?: unknown } | null
    if (typeof out?.url !== 'string' || typeof out.text !== 'string') continue
    // fetchPage's per-worker cache answers a repeat with a stub, not the page (tools.ts).
    if (out.text.startsWith('Already fetched earlier in this conversation')) continue
    ledger.recordText(out.url, out.text)
  }
}
