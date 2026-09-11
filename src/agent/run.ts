import { profiles } from './depth.js'
import { planResearch } from './plan.js'
import { runWorker } from './worker.js'
import { synthesize } from './synthesize.js'
import { assembleReport, nextRoundQuestions } from './assemble.js'
import { mergeLedgers, type LedgerSnapshot } from './ledger.js'
import { groundReport } from './ground.js'
import type { Depth, ResearchReport, SubmittedReport, SubQuestion, WorkerDigest } from './schema.js'
import { log } from '../lib/log.js'
import { computeCost, emptyUsage, addUsage } from '../lib/usage.js'
import { readSearchSpend, readRenderStats } from './tools.js'
import type { UsageStats } from '../lib/usage.js'
import { env } from '../env.js'
import { traceIdFromJobId, withRootSpan, withSpan } from '../lib/otel.js'
import {
  shouldRetryRound,
  describeFailures,
  collectRoundOutcome,
  ROUND_RETRY_BACKOFF_MS,
  type RoundResult,
  type WorkerOutcome,
} from './round.js'

// Re-exported for compatibility and direct unit-testing — the implementation lives in
// `assemble.ts` because it has no `env.js` import chain (schema.js only), so it can be
// tested without booting the env-parsing/llm.ts chain that `run.ts` itself drags in.
export { assembleReport, nextRoundQuestions } from './assemble.js'

// Combined job usage handed to onUsage: the flat total plus the per-model split, since
// the lead model (plan + synthesis) and worker model (fan-out) are billed separately.
export interface JobUsage extends UsageStats {
  lead: UsageStats
  worker: UsageStats
}

// Tiny local concurrency gate — bounds how many workers run at once within one job.
// No dependency added; Promise.allSettled still drives the actual parallel dispatch.
class Semaphore {
  private active = 0
  private readonly queue: Array<() => void> = []

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++
      return
    }
    await new Promise<void>((resolve) => this.queue.push(resolve))
    this.active++
  }

  release(): void {
    this.active--
    this.queue.shift()?.()
  }
}

async function withLimit<T>(sem: Semaphore, fn: () => Promise<T>): Promise<T> {
  await sem.acquire()
  try {
    return await fn()
  } finally {
    sem.release()
  }
}

// Runs one round's sub-questions as workers in parallel, bounded by WORKER_MAX_CONCURRENCY.
// A worker that throws is caught inside runWorker itself; Promise.allSettled here is a
// second, defensive layer so an unexpected throw can never abort the round. The settled-outcome
// classification itself (rejected / digest / error / neither) lives in `collectRoundOutcome`
// (round.ts) — pure and env-free, so it is unit-testable without this module's env.js chain.
async function dispatchRound(
  subQuestions: SubQuestion[],
  depth: Depth,
  jobId: string,
  round: number,
  researchDeadlineAt: number,
): Promise<RoundResult> {
  const sem = new Semaphore(env.WORKER_MAX_CONCURRENCY)
  const settled = await Promise.allSettled<WorkerOutcome>(
    subQuestions.map((sq) =>
      withLimit(sem, () =>
        runWorker({ subQuestion: sq.question, depth, jobId, round, researchDeadlineAt }),
      ),
    ),
  )

  return collectRoundOutcome(settled)
}

// One round's span + dispatch. Both the first pass and the retry pass go through here so the
// two can never drift in what they record — a retry is the SAME round re-run, distinguished
// only by `research.round_retry`.
function tracedRound(args: {
  subQuestions: SubQuestion[]
  depth: Depth
  jobId: string
  round: number
  researchDeadlineAt: number
  retry: boolean
}): Promise<RoundResult> {
  return withSpan(
    'research.round',
    {
      'research.round': args.round,
      'research.workers_dispatched': args.subQuestions.length,
      'research.gap_round': args.round > 1,
      ...(args.retry ? { 'research.round_retry': true } : {}),
    },
    async (s) => {
      const result = await dispatchRound(
        args.subQuestions,
        args.depth,
        args.jobId,
        args.round,
        args.researchDeadlineAt,
      )
      s.setAttributes({ 'research.digests_returned': result.digests.length })
      return result
    },
  )
}

export async function runResearch(
  input: { query: string; depth?: Depth; jobId?: string },
  onUsage?: (stats: JobUsage) => void,
): Promise<ResearchReport> {
  const depth = input.depth ?? 'standard'
  const jobId = input.jobId ?? '-'

  // The whole job is one trace, and its id is derived from the jobId — so a job id from the
  // REST/MCP surface is enough to find the trace, with no lookup table in between.
  return withRootSpan(
    {
      traceId: traceIdFromJobId(jobId),
      name: 'research.job',
      kind: 'server',
      attrs: { 'research.depth': depth, 'research.query': input.query.slice(0, 200) },
    },
    async (span) => {
      const profile = profiles[depth]
      const start = Date.now()

      log('research.start', { jobId, depth, queryPreview: input.query.slice(0, 200) })

      let leadUsage = emptyUsage()
      let workerUsage = emptyUsage()
      const allDigests: WorkerDigest[] = []
      const askedLower = new Set<string>()
      const allLedgers: LedgerSnapshot[] = []
      let workersDispatchedTotal = 0
      // Job-level failure causes, across every round and the one retry — feeds both the
      // zero-evidence throw's message and `shouldRetryRound`'s decision. A job-level latch:
      // one retry per JOB, not per round, so a job with two zero-digest rounds doesn't
      // silently double its worker spend chasing the same upstream outage.
      const allFailures: string[] = []
      let alreadyRetried = false

      // No span wrapper here — planResearch opens `research.plan` itself, so the quick-depth
      // path (which makes no LLM call at all) produces no zero-duration span. Same for
      // synthesize/`research.synthesis` below.
      const { plan, usage: planUsage } = await planResearch({ query: input.query, depth, jobId })
      leadUsage = addUsage(leadUsage, planUsage)
      log('research.plan', { jobId, subQuestions: plan.subQuestions.length })

      // Synthesis MUST always retain its full budget — the research phase (plan + worker
      // rounds) is only ever allowed to eat the remainder. Threaded into each worker so a
      // worker running past this point BANKS its digest (forced submit_digest) instead of
      // being aborted — an abort here would lose the whole digest, reintroducing the exact
      // failure class (missing try/catch on searchWeb killing 60% of workers) already fixed.
      const researchDeadlineAt = start + (profile.totalTimeoutMs - profile.synthesisTimeoutMs)

      let currentQuestions: SubQuestion[] = plan.subQuestions
      let round = 1
      while (currentQuestions.length > 0) {
        for (const sq of currentQuestions) askedLower.add(sq.question.trim().toLowerCase())

        // What this round has to show — the first pass alone, unless the retry below runs, in
        // which case it also carries that pass's digests. Used for the gap-question decision
        // after this block, so a retry that DID recover evidence still informs what the next
        // round asks.
        const roundDigests: WorkerDigest[] = []
        const absorb = (result: RoundResult): void => {
          workerUsage = addUsage(workerUsage, result.usage)
          allDigests.push(...result.digests)
          roundDigests.push(...result.digests)
          workersDispatchedTotal += currentQuestions.length
          allLedgers.push(...result.ledgers)
          allFailures.push(...result.failures)
        }

        const first = await tracedRound({
          subQuestions: currentQuestions,
          depth,
          jobId,
          round,
          researchDeadlineAt,
          retry: false,
        })
        absorb(first)

        // One retry per JOB, not per round (see `alreadyRetried` above): a round that lost
        // EVERY worker to a fast upstream failure still has nearly its whole research budget
        // left, so a second full pass over the SAME questions is worth it — but only when
        // there's genuinely enough of the research window left for one. See round.ts's
        // header for the evidence and the exact rule.
        if (
          shouldRetryRound({
            digests: first.digests.length,
            failures: first.failures.length,
            now: Date.now(),
            researchDeadlineAt,
            workerTimeoutMs: profile.workerTimeoutMs,
            alreadyRetried,
          })
        ) {
          log('round.retry', {
            jobId,
            round,
            failures: first.failures.length,
            reason: describeFailures(first.failures),
          })
          await new Promise((resolve) => setTimeout(resolve, ROUND_RETRY_BACKOFF_MS))
          alreadyRetried = true
          absorb(
            await tracedRound({
              subQuestions: currentQuestions,
              depth,
              jobId,
              round,
              researchDeadlineAt,
              retry: true,
            }),
          )
        }

        // Emit a cumulative snapshot per round, not just once at the end (this also covers
        // the retry above, if one ran — workerUsage already includes it by this point). argo
        // upserts on (source, source_id, machine), so each snapshot overwrites the last rather
        // than double-counting — and a job that dies mid-flight still leaves the tokens
        // it had already burned behind instead of reporting nothing at all.
        if (onUsage) {
          onUsage({
            ...addUsage(leadUsage, workerUsage),
            durationMs: Date.now() - start,
            lead: leadUsage,
            worker: workerUsage,
          })
        }

        log('research.round', {
          jobId,
          round,
          workersDispatched: currentQuestions.length,
          digestsReturned: roundDigests.length,
        })

        if (round >= profile.rounds) break

        const elapsed = Date.now() - start
        if (elapsed + profile.synthesisTimeoutMs >= profile.totalTimeoutMs) break

        const gapQuestions = nextRoundQuestions(roundDigests, askedLower, profile.gapWorkers)
        if (gapQuestions.length === 0) break

        currentQuestions = gapQuestions
        round += 1
      }

      // Guard clause: no digest was ever produced — every worker failed or timed out on every
      // round, plus the one retry above. This used to fall through to a hardcoded stub
      // ("Research could not gather any evidence... before the budget was exhausted"),
      // returned as a normal `done` + `partial` job. That was a lie whenever the real cause
      // was an upstream failure rather than the budget: 2026-09-10, three jobs died in 66ms
      // out of a 300 000ms worker budget on `AI_APICallError: Forbidden`, and the report told
      // the human "budget exhausted" anyway. A zero-evidence job IS a failed job — throwing
      // here lets it surface as a terminal `error` naming the actual cause. `runInSpan`
      // (lib/otel.ts) already marks the span error + records the exception on any throw, and
      // `run-job.ts`'s `markFailed` already turns the rejection into `status: 'error'` — both
      // handle this without any further code here.
      if (allDigests.length === 0) {
        // Same round/worker/digest attribute names the success path sets below, plus
        // `research.failures` (unique to this branch) — so a zero-evidence job's own trace
        // still carries round/worker context instead of ending on a bare `research.reason`,
        // which is exactly what's needed to confirm "instant and budget-untouched" from the
        // trace alone. No `report.status` / `cost.*` / `grounding.*` here: this branch never
        // reaches grounding, and cost already reaches argo via the `onUsage` snapshot below.
        span.setAttributes({
          'research.reason': 'empty',
          'research.rounds': round,
          'research.workers': workersDispatchedTotal,
          'research.digests': 0,
          'research.failures': allFailures.length,
        })

        // Report what was spent before throwing — a zero-evidence job still burned real
        // plan/worker tokens against the upstream failures above, and the caller should see
        // that spend rather than nothing at all.
        if (onUsage) {
          onUsage({
            ...addUsage(leadUsage, workerUsage),
            durationMs: Date.now() - start,
            lead: leadUsage,
            worker: workerUsage,
          })
        }

        throw new Error(`Research produced no evidence: ${describeFailures(allFailures)}`)
      }

      const { report: synthesized, usage: synthesisUsage } = await synthesize({
        query: input.query,
        digests: allDigests,
        depth,
        jobId,
      })
      leadUsage = addUsage(leadUsage, synthesisUsage)

      let submitted: SubmittedReport
      let reason: 'submit_report' | 'assembled'
      if (synthesized) {
        submitted = synthesized
        reason = 'submit_report'
      } else {
        // Deterministic fallback — assembled in code, no LLM call. See assemble.ts.
        submitted = assembleReport(allDigests)
        reason = 'assembled'
      }

      // The job-level gate. Every citation the synthesis model asserted is checked against the
      // union of what the workers' tools actually retrieved, `sources` is replaced by the pages
      // genuinely read, and `status`/`grounding` are counted in code. This is the invariant
      // from issue #1: a URL this run could not fetch can never back a citation.
      const toGround = submitted
      const grounded = await withSpan('research.ground', {}, async (s) => {
        const jobLedger = mergeLedgers(allLedgers)
        const result = groundReport(toGround, jobLedger)
        s.setAttributes({
          'grounding.pages_retrieved': result.grounding.pagesRetrieved,
          'grounding.pages_failed': result.grounding.pagesFailed,
          'grounding.citations_dropped': result.grounding.citationsDropped,
          'grounding.confidence_capped': result.grounding.confidenceCapped,
          'report.citations': result.citations.length,
          'report.sources': result.sources.length,
          'report.status': result.status,
        })
        return result
      })

      const wallMs = Date.now() - start
      const combined = addUsage(leadUsage, workerUsage)
      const jobUsage: JobUsage = { ...combined, durationMs: wallMs, lead: leadUsage, worker: workerUsage }

      if (onUsage) onUsage(jobUsage)

      const leadCost = computeCost(env.IU_LEAD_MODEL, {
        inputTokens: leadUsage.inputTokens,
        cachedInputTokens: leadUsage.cachedInputTokens,
        outputTokens: leadUsage.outputTokens,
      })
      const workerCost = computeCost(env.IU_WORKER_MODEL, {
        inputTokens: workerUsage.inputTokens,
        cachedInputTokens: workerUsage.cachedInputTokens,
        outputTokens: workerUsage.outputTokens,
      })
      const costUsd =
        leadCost.costUsd === null && workerCost.costUsd === null
          ? null
          : (leadCost.costUsd ?? 0) + (workerCost.costUsd ?? 0)

      // Search spend is read here, at the end of the run, from the same per-job meters that
      // feed argo — so the number in the result and the number on the dashboard are the same
      // number, not two independent accountings that can drift.
      const search = readSearchSpend(jobId)
      const report: ResearchReport = {
        ...grounded,
        cost: {
          wallMs,
          totalUsd: costUsd === null ? null : costUsd + search.sonarCostUsd,
          llmUsd: costUsd,
          searchUsd: search.sonarCostUsd,
          searchCalls: search.sonarCalls,
          tavilyCredits: search.tavilyCredits,
          tavilyExtractCalls: search.tavilyExtractCalls,
        },
      }

      // Operational counters, not spend — kept out of RunCost (which stays about money) and
      // reported only in this log line, plus argo via reportRenderUsage (tools.ts's meterRender).
      const renderStats = readRenderStats(jobId)

      // Mirrors the `research.done` line below field-for-field on purpose: the trace and the
      // log are then the same numbers by construction, not two accountings that can drift.
      span.setAttributes({
        'research.reason': reason,
        'research.rounds': round,
        'research.workers': workersDispatchedTotal,
        'research.digests': allDigests.length,
        'research.outcome_partial': grounded.status === 'partial',
        'report.status': grounded.status,
        'report.citations': grounded.citations.length,
        'report.sources': grounded.sources.length,
        'grounding.pages_retrieved': grounded.grounding.pagesRetrieved,
        'grounding.pages_failed': grounded.grounding.pagesFailed,
        'grounding.citations_dropped': grounded.grounding.citationsDropped,
        'grounding.confidence_capped': grounded.grounding.confidenceCapped,
        'llm.input_tokens': combined.inputTokens,
        'llm.cached_input_tokens': combined.cachedInputTokens,
        'llm.output_tokens': combined.outputTokens,
        'llm.reasoning_tokens': combined.reasoningTokens,
        'llm.lead_output_tokens': leadUsage.outputTokens,
        'llm.worker_output_tokens': workerUsage.outputTokens,
        'cost.llm_usd': costUsd,
        'cost.search_usd': search.sonarCostUsd,
        'cost.total_usd': report.cost.totalUsd,
        'search.calls': search.sonarCalls,
        'search.tavily_extract_calls': search.tavilyExtractCalls,
        'render.count': renderStats.renders,
        'render.failures': renderStats.failures,
      })

      log('research.done', {
        jobId,
        reason,
        depth,
        rounds: round,
        workers: workersDispatchedTotal,
        digests: allDigests.length,
        citations: grounded.citations.length,
        sources: grounded.sources.length,
        status: grounded.status,
        pagesRetrieved: grounded.grounding.pagesRetrieved,
        pagesFailed: grounded.grounding.pagesFailed,
        citationsDropped: grounded.grounding.citationsDropped,
        confidenceCapped: grounded.grounding.confidenceCapped,
        inputTokens: combined.inputTokens,
        cachedInputTokens: combined.cachedInputTokens,
        outputTokens: combined.outputTokens,
        totalTokens: combined.totalTokens,
        reasoningTokens: combined.reasoningTokens,
        costUsd,
        searchUsd: search.sonarCostUsd,
        searchCalls: search.sonarCalls,
        renders: renderStats.renders,
        rendersFailed: renderStats.failures,
        wallMs,
      })

      return report
    },
  )
}
