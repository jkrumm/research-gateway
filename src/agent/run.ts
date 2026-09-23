import { profiles } from './depth.js'
import { planResearch } from './plan.js'
import { runWorker } from './worker.js'
import { synthesize } from './synthesize.js'
import { reviewConsistency } from './consistency.js'
import { applyConsistencyGate, CONSISTENCY_WARNING } from './extract.js'
import { assembleReport, nextRoundQuestions } from './assemble.js'
import { mergeLedgers, type LedgerSnapshot } from './ledger.js'
import { groundReport } from './ground.js'
import { CHECKPOINT_VERSION, type ResearchCheckpoint } from './checkpoint.js'
import type { Depth, ResearchReport, SubmittedReport, SubQuestion, WorkerDigest } from './schema.js'
import { log } from '../lib/log.js'
import { computeCost, emptyUsage, addUsage } from '../lib/usage.js'
import { readSearchSpend, readRenderStats } from './tools.js'
import type { UsageStats } from '../lib/usage.js'
import { env } from '../env.js'
import { traceIdFromJobId, withRootSpan, withSpan } from '../lib/otel.js'
import { describeFailures, collectRoundOutcome, type RoundResult, type WorkerOutcome } from './round.js'
import { runRounds } from './rounds.js'
import { FencedError } from './fenced-error.js'

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
  context?: string,
): Promise<RoundResult> {
  const sem = new Semaphore(env.WORKER_MAX_CONCURRENCY)
  const settled = await Promise.allSettled<WorkerOutcome>(
    subQuestions.map((sq) =>
      withLimit(sem, () => runWorker({ subQuestion: sq.question, context, depth, jobId, round })),
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
  retry: boolean
  context?: string | undefined
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
      const result = await dispatchRound(args.subQuestions, args.depth, args.jobId, args.round, args.context)
      s.setAttributes({ 'research.digests_returned': result.digests.length })
      return result
    },
  )
}

export async function runResearch(
  input: { query: string; context?: string | undefined; depth?: Depth; jobId?: string },
  onUsage?: (stats: JobUsage) => void,
  opts?: {
    checkpoint?: ResearchCheckpoint | null
    onCheckpoint?: (checkpoint: ResearchCheckpoint) => void
    /**
     * True once this process no longer owns the job's lease (job-store.ts's `ownsLease`) —
     * checked at every round/retry/synthesis boundary (rounds.ts's `runRounds`, plus once more
     * here before synthesis), and a positive check aborts the run with `FencedError` rather
     * than continuing to spend LLM/pdftotext work a fenced-off adopter will discard anyway.
     * Defaults to "never fenced", which is what every caller outside run-job.ts's live lease
     * machinery (tests, scripts/smoke.ts) wants.
     */
    isFenced?: () => boolean
  },
): Promise<ResearchReport> {
  const depth = input.depth ?? 'standard'
  const jobId = input.jobId ?? '-'
  const checkpoint = opts?.checkpoint ?? null
  const persistCheckpoint = opts?.onCheckpoint
  const isFenced = opts?.isFenced ?? ((): boolean => false)

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

      // Everything below is either FRESH state or restored from a checkpoint taken after a
      // previous round completed (agent/checkpoint.ts) — see run-job.ts's adoption loop for
      // where `checkpoint` comes from. Search-spend meters (tools.ts) are NOT restorable:
      // they are in-memory and reset on every process boot, so a resumed job's reported
      // search cost covers only the post-resume portion. LLM usage below has no such gap — it
      // travels inside the checkpoint and is correct across a resume.
      let leadUsage = checkpoint?.leadUsage ?? emptyUsage()
      // Everything else the round loop needs is either FRESH or restored straight from the
      // checkpoint — these are the INITIAL values only, handed to `runRounds` as `restore`;
      // the loop itself (rounds.ts) owns mutating them from here on, and returns the
      // accumulated state once it finishes or throws.
      const initialWorkerUsage = checkpoint?.workerUsage ?? emptyUsage()
      const initialDigests: WorkerDigest[] = checkpoint ? [...checkpoint.digests] : []
      const initialAskedLower = checkpoint?.askedLower ?? []
      const initialLedgers: LedgerSnapshot[] = checkpoint ? [...checkpoint.ledgers] : []
      const initialWorkersDispatchedTotal = checkpoint?.workersDispatchedTotal ?? 0
      const initialFailures: string[] = checkpoint ? [...checkpoint.failures] : []
      const initialAlreadyRetried = checkpoint?.alreadyRetried ?? false

      const buildCheckpoint = (subQuestions: SubQuestion[], round: number): ResearchCheckpoint => ({
        version: CHECKPOINT_VERSION,
        subQuestions,
        round,
        digests: initialDigests,
        ledgers: initialLedgers,
        askedLower: [...initialAskedLower],
        failures: initialFailures,
        alreadyRetried: initialAlreadyRetried,
        leadUsage,
        workerUsage: initialWorkerUsage,
        workersDispatchedTotal: initialWorkersDispatchedTotal,
      })

      let currentQuestions: SubQuestion[]
      let round: number
      if (checkpoint) {
        currentQuestions = checkpoint.subQuestions
        round = checkpoint.round
        log('research.resumed', { jobId, round, digests: initialDigests.length })
      } else {
        // No span wrapper here — planResearch opens `research.plan` itself, so the
        // quick-depth path (which makes no LLM call at all) produces no zero-duration span.
        // Same for synthesize/`research.synthesis` below.
        const { plan, usage: planUsage } = await planResearch({ query: input.query, context: input.context, depth, jobId })
        leadUsage = addUsage(leadUsage, planUsage)
        log('research.plan', { jobId, subQuestions: plan.subQuestions.length })
        currentQuestions = plan.subQuestions
        round = 1
        persistCheckpoint?.(buildCheckpoint(currentQuestions, round))
      }

      // The round loop itself — dispatch, the one-retry-per-job rule, gap-round advancement,
      // and the fenced-lease check at every boundary — lives in rounds.ts's `runRounds`, pure
      // and env-free so it is unit-testable without this module's LLM/env import chain. Every
      // side effect it needs (dispatching a round, computing the next round's questions,
      // persisting a checkpoint, deciding whether this process is still fenced) is injected
      // below; `leadUsage` stays here since the loop itself never touches it (only
      // plan/synthesis do).
      const rounds = await runRounds({
        profile,
        initialQuestions: currentQuestions,
        initialRound: round,
        restore: checkpoint
          ? {
              digests: initialDigests,
              ledgers: initialLedgers,
              failures: initialFailures,
              askedLower: initialAskedLower,
              workerUsage: initialWorkerUsage,
              workersDispatchedTotal: initialWorkersDispatchedTotal,
              alreadyRetried: initialAlreadyRetried,
            }
          : null,
        isFenced,
        dispatchRound: (subQuestions, r, retry) => tracedRound({ subQuestions, depth, jobId, round: r, retry, context: input.context }),
        nextRoundQuestions,
        onRetry: ({ round: r, failures }) => {
          log('round.retry', { jobId, round: r, failures: failures.length, reason: describeFailures(failures) })
        },
        onRoundComplete: ({ round: r, state, roundDigests, workersDispatched }) => {
          // Emit a cumulative snapshot per round, not just once at the end (this also covers
          // the retry, if one ran — `state.workerUsage` already includes it by this point).
          // argo upserts on (source, source_id, machine), so each snapshot overwrites the last
          // rather than double-counting — and a job that dies mid-flight still leaves the
          // tokens it had already burned behind instead of reporting nothing at all.
          if (onUsage) {
            onUsage({
              ...addUsage(leadUsage, state.workerUsage),
              durationMs: Date.now() - start,
              lead: leadUsage,
              worker: state.workerUsage,
            })
          }
          log('research.round', { jobId, round: r, workersDispatched, digestsReturned: roundDigests.length })
        },
        onCheckpoint: (state, nextQuestions, nextRound) => {
          // Checkpoint after this completed round — including its retry, if one ran — with the
          // NEXT round's questions (empty once there is nothing left to run, which resumes
          // straight into synthesis below rather than re-entering the loop for nothing).
          persistCheckpoint?.({
            version: CHECKPOINT_VERSION,
            subQuestions: nextQuestions,
            round: nextRound,
            digests: state.allDigests,
            ledgers: state.allLedgers,
            askedLower: [...state.askedLower],
            failures: state.allFailures,
            alreadyRetried: state.alreadyRetried,
            leadUsage,
            workerUsage: state.workerUsage,
            workersDispatchedTotal: state.workersDispatchedTotal,
          })
        },
      })

      const allDigests = rounds.allDigests
      const allFailures = rounds.allFailures
      const allLedgers = rounds.allLedgers
      const workerUsage = rounds.workerUsage
      const workersDispatchedTotal = rounds.workersDispatchedTotal
      round = rounds.round

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

      // The last checkpoint boundary before the (uncheckpointed) work that follows — synthesis,
      // the consistency gate, and grounding all run to completion once started, so this is the
      // last chance to stop before spending that work on a run the owner fence will discard.
      if (isFenced()) throw new FencedError('research job fenced before synthesis')

      const { report: synthesized, usage: synthesisUsage } = await synthesize({
        query: input.query,
        context: input.context,
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

      // Internal-consistency pass (issue #5) — the one check the pipeline had no answer for:
      // parallel workers research independently, so one digest can establish a fact while
      // another contradicts it, and both the synthesized report and the assembled fallback
      // above can carry that contradiction verbatim. One lead-model call reads the finished
      // body back (no tools, no retrieval — the conflicting statements are already in it) and
      // may return a corrected body. On any failure the ORIGINAL report continues: this pass
      // degrades to a no-op rather than risking the whole job's output. `reason` is reported
      // unchanged — it records how the report was PRODUCED, which the review does not alter.
      // The gate's bookkeeping (lead-usage fold, applied/vetoed counts) lives in extract.ts's
      // env-free applyConsistencyGate, unit-testable outside run.ts's env-chained import
      // graph (run.test.ts's convention imports such helpers directly). The warning merge
      // stays at report assembly: the gate runs before groundReport, so grounded.warnings
      // does not exist yet. The outcome returns whole from the callback rather than being
      // written into a closure variable, so it is a const — no nullable bookkeeping.
      const gateOutcome = await withSpan(
        'research.consistency_gate',
        { 'report.reason': reason },
        async (gateSpan) => {
          const review = await reviewConsistency({ report: submitted.report, jobId })
          const merged = applyConsistencyGate({ review, leadUsage })
          leadUsage = merged.leadUsage
          gateSpan.setAttributes({
            'consistency.corrected': review.corrected,
            'consistency.vetoed': review.vetoed,
            'consistency.edits': review.appliedEdits.length,
            'report.chars_before': submitted.report.length,
            'report.chars_after': review.report.length,
          })
          if (review.corrected) {
            log('report.consistency_corrected', { jobId, reason, edits: merged.edits })
          }
          return { reviewed: { ...submitted, report: review.report }, gate: merged }
        },
      )
      submitted = gateOutcome.reviewed
      const gate = gateOutcome.gate

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
          'grounding.pages_missing': result.grounding.pagesMissing,
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
        warnings: gate.corrected === true
          ? [...grounded.warnings, CONSISTENCY_WARNING]
          : grounded.warnings,
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
        'consistency.corrected': gate.corrected,
        'consistency.edits': gate.edits,
        'research.outcome_partial': grounded.status === 'partial',
        'report.status': grounded.status,
        'report.citations': grounded.citations.length,
        'report.sources': grounded.sources.length,
        'grounding.pages_retrieved': grounded.grounding.pagesRetrieved,
        'grounding.pages_missing': grounded.grounding.pagesMissing,
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
        consistencyCorrected: gate.corrected,
        consistencyVetoed: gate.vetoed,
        consistencyEdits: gate.edits,
        citations: grounded.citations.length,
        sources: grounded.sources.length,
        status: grounded.status,
        pagesRetrieved: grounded.grounding.pagesRetrieved,
        pagesMissing: grounded.grounding.pagesMissing,
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
