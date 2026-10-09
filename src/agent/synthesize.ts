import { generateText, tool } from 'ai'
import type { Tool } from 'ai'
import { synthesisModel, leadModelWithDoubledBudget, leadSubmitChoice, ROLE_BUDGETS } from '../lib/llm.js'
import type { IuLanguageModel } from '../lib/llm.js'
import { synthesisPrompt, backgroundSection, ownerNoteTag } from './prompt.js'
import { resolveSynthesisReport } from './extract.js'
import { SubmittedReport, WorkerDigest } from './schema.js'
import { classifySynthesisReply, isCompactRetryable, trySalvage } from './synthesis-outcome.js'
import type { ReplyShape, SynthesisReply } from './synthesis-outcome.js'
import type { Depth } from './schema.js'
import { log } from '../lib/log.js'
import { withSpan } from '../lib/otel.js'
import { env } from '../env.js'
import { addUsage, emptyUsage, toUsageStats } from '../lib/usage.js'
import type { UsageStats } from '../lib/usage.js'
import { createIdleWatchdog } from '../lib/idle-watchdog.js'
import type { IdleWatchdog } from '../lib/idle-watchdog.js'

// Mirrors the `synthesis.outcome` span attribute: how the report was (not) produced.
export type SynthesisOutcome = 'submitted' | 'salvaged' | 'failed' | `rejected_${Exclude<SynthesisReply['kind'], 'submitted'>}`

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = Tool<any, any>

// Worded against the exact fabrication it replaces: a missing digest is a worker that did not
// report, which says nothing about the pages it was sent to read.
function undigestedSection(undigested: readonly string[]): string {
  if (undigested.length === 0) return ''
  const lines = undigested.map((q) => `- ${q}`).join('\n')
  return `\n\n## Sub-questions with no report\n\nThe worker for each of these ended without delivering findings. That is a failure of the worker, NOT evidence about its sources: do not describe any page, site or tool as blocked, JavaScript-only, unavailable or broken on account of these, and do not state findings for them. List them as not researched in this run.\n\n${lines}`
}

function renderDigests(
  query: string,
  context: string | undefined,
  digests: WorkerDigest[],
  undigested: readonly string[],
): string {
  const sections = digests.map((d) => {
    const findings = d.findings.map((f) => `- ${f.claim} — ${f.url} (${f.confidence})${ownerNoteTag(f.url, env.BRAIN_BASE_URL)}`).join('\n')
    const sourcesRead = d.sourcesRead.join(', ')
    const blockedSources = d.blockedSources
      .map((b) => `- ${b.topic} — ${b.url ?? '(no url)'} (${b.reason})`)
      .join('\n')
    return `### ${d.subQuestion}\n\n${d.summary}\n\n**Findings:**\n${findings || '(none)'}\n\n**Sources read:** ${sourcesRead || '(none)'}\n\n**Blocked sources:**\n${blockedSources || '(none)'}`
  })
  return `## Original query\n\n${query}${backgroundSection(context)}\n\n## Researched sub-questions\n\n${sections.join('\n\n')}${undigestedSection(undigested)}`
}

// Appended on the one retry after a malformed or text-only reply, so the second attempt is
// smaller and cannot fail the same way by running long.
const COMPACT_RETRY_NOTE =
  'RETRY: your previous reply was not a valid `submit_report` call. Call `submit_report` now. Keep the report compact: open with the Bottom line, then only the detail the sub-questions need, and no more than the length target above.'

function logRejection(
  jobId: string,
  reply: Exclude<SynthesisReply, { kind: 'submitted' }>,
  result: ReplyShape,
  outputTokens: number,
  next: 'retrying' | 'assembled',
): void {
  // `synthesis.rejected` means the job fell back to the assembled report; an intermediate
  // rejection that gets a compact retry is `synthesis.retry`, so the rejected rate stays clean.
  log(next === 'assembled' ? 'synthesis.rejected' : 'synthesis.retry', {
    jobId,
    reason: reply.kind,
    finishReason: result.finishReason,
    outputTokens,
    textChars: result.text.length,
    toolCalls: result.toolCalls.length,
    ...(reply.kind === 'malformed-call' ? { issues: reply.issues } : {}),
    next,
  })
}

export async function synthesize(args: {
  query: string
  context?: string | undefined
  digests: WorkerDigest[]
  depth: Depth
  jobId: string
  signal?: AbortSignal | undefined
  undigested?: readonly string[] | undefined
}): Promise<{ report: SubmittedReport | null; usage: UsageStats; outcome: SynthesisOutcome }> {
  const { query, context, digests, depth, jobId } = args
  const start = Date.now()

  const submitReportTool: AnyTool = tool({
    description:
      'Submit the final research report synthesized from the provided digests. This is the ONLY way to deliver the answer — do not write plain text.',
    inputSchema: SubmittedReport,
  }) as AnyTool

  const callSynthesis = (model: IuLanguageModel, idle: IdleWatchdog, compact = false) =>
    generateText({
      model,
      instructions: compact ? `${synthesisPrompt(depth)}\n\n${COMPACT_RETRY_NOTE}` : synthesisPrompt(depth),
      prompt: renderDigests(query, context, digests, args.undigested ?? []),
      tools: { submit_report: submitReportTool },
      toolChoice: leadSubmitChoice('submit_report'),
      maxRetries: 2,
      abortSignal: idle.signal,
      onStepEnd: () => idle.arm(),
      onToolExecutionStart: () => idle.arm(),
      onToolExecutionEnd: () => idle.arm(),
    })

  return withSpan(
    'research.synthesis',
    { 'llm.model': env.IU_LEAD_MODEL, 'synthesis.digests': digests.length },
    async (span) => {
      // No wall-clock ceiling (settled 2026-09-12) — only an idle watchdog: aborted when a
      // step has produced no activity for `RESEARCH_IDLE_TIMEOUT_MS`. See idle-watchdog.ts.
      // Synthesis can legitimately run long writing out a large report; what it must never
      // do is go silent.
      const idle = createIdleWatchdog(env.RESEARCH_IDLE_TIMEOUT_MS, args.signal)
      idle.arm()
      try {
        let usage = emptyUsage()
        // One call, fully classified: salvage of a prose reply and the report guard run here so
        // every attempt (first, doubled-budget, compact) gets the same recovery.
        const attempt = async (model: IuLanguageModel, compact = false) => {
          const result = await callSynthesis(model, idle, compact)
          usage = addUsage(usage, toUsageStats(result.usage, 0, result.steps))
          let reply = trySalvage(classifySynthesisReply(result), digests)
          let resolved: ReturnType<typeof resolveSynthesisReport> | null = null
          if (reply.kind === 'submitted') {
            resolved = resolveSynthesisReport(reply.report, digests)
            if (!resolved.report) reply = { kind: 'guard' }
          }
          return { result, reply, resolved }
        }

        // The report is written entirely inside the tool call's arguments, so a starved call
        // (finishReason: 'length') looks exactly like "no valid submit_report call" unless
        // classified explicitly. Each failure gets one recovery before the digest-assembled
        // fallback in run.ts: a doubled budget for `length`, otherwise one retry told to write
        // a compact report (a prose reply is kept as the report when it is long enough).
        let out = await attempt(synthesisModel)
        if (out.reply.kind === 'length') {
          log('synthesis.length', { jobId, outputTokens: usage.outputTokens, budget: ROLE_BUDGETS.synthesis })
          out = await attempt(leadModelWithDoubledBudget('synthesis'))
          if (out.reply.kind === 'length') {
            log('synthesis.length', { jobId, outputTokens: usage.outputTokens, retried: true })
          }
        } else if (isCompactRetryable(out.reply)) {
          logRejection(jobId, out.reply, out.result, usage.outputTokens, 'retrying')
          out = await attempt(synthesisModel, true)
        }
        usage = { ...usage, durationMs: Date.now() - start }

        span.setAttributes({ 'llm.output_tokens': usage.outputTokens, 'llm.finish_reason': out.result.finishReason })
        log('synthesis.done', {
          jobId,
          ms: Date.now() - start,
          outputTokens: usage.outputTokens,
          digests: digests.length,
        })
        const { reply, resolved } = out
        if (reply.kind !== 'submitted' || !resolved?.report) {
          // `attempt()` turns a submitted-but-unusable reply into 'guard', so 'submitted' here is
          // only the type system's view.
          const outcome: SynthesisOutcome = reply.kind === 'submitted' ? 'rejected_guard' : `rejected_${reply.kind}`
          span.setAttributes({ 'synthesis.outcome': outcome })
          if (reply.kind !== 'submitted') logRejection(jobId, reply, out.result, usage.outputTokens, 'assembled')
          return { report: null, usage, outcome }
        }
        if (resolved.salvaged) {
          // Loud and distinct on purpose: how often this fires is the signal for whether the
          // prompt or the forced-toolChoice arm needs work — see extract.ts for the failure
          // mode this is salvaging.
          log('synthesis.salvaged', {
            jobId,
            reason: 'report.report was double-encoded JSON of the whole submission; unwrapped inner markdown',
          })
        }
        const outcome = resolved.salvaged ? 'salvaged' : 'submitted'
        span.setAttributes({ 'synthesis.outcome': outcome })
        return { report: resolved.report, usage, outcome }
      } catch (err) {
        // Caught INSIDE the span callback so the span ends normally and synthesize keeps its
        // "never throws" contract — a failed synthesis is a null report, not an error.
        // The status is set by hand precisely BECAUSE nothing is rethrown: runInSpan's own
        // handler never sees this failure, so the span would default to `ok` and a dead
        // synthesis would be invisible on the Errors tile. The `rejected_*` outcomes above
        // stay `ok` on purpose — a rejected report is a handled outcome, not an error.
        span.setAttributes({ 'synthesis.outcome': 'failed' })
        span.setStatus('error', String(err).slice(0, 300))
        log('synthesis.failed', { jobId, error: String(err) })
        return { report: null, usage: { ...emptyUsage(), durationMs: Date.now() - start }, outcome: 'failed' }
      } finally {
        idle.clear()
      }
    },
    'client',
  )
}
