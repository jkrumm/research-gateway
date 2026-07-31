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
import type { UsageStats } from '../lib/usage.js'
import { env } from '../env.js'

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

interface RoundResult {
  digests: WorkerDigest[]
  usage: UsageStats
  ledgers: LedgerSnapshot[]
}

// Runs one round's sub-questions as workers in parallel, bounded by WORKER_MAX_CONCURRENCY.
// A worker that throws is caught inside runWorker itself; Promise.allSettled here is a
// second, defensive layer so an unexpected throw can never abort the round.
async function dispatchRound(
  subQuestions: SubQuestion[],
  depth: Depth,
  jobId: string,
  round: number,
  researchDeadlineAt: number,
): Promise<RoundResult> {
  const sem = new Semaphore(env.WORKER_MAX_CONCURRENCY)
  const settled = await Promise.allSettled(
    subQuestions.map((sq) =>
      withLimit(sem, () =>
        runWorker({ subQuestion: sq.question, depth, jobId, round, researchDeadlineAt }),
      ),
    ),
  )

  let usage = emptyUsage()
  const digests: WorkerDigest[] = []
  const ledgers: LedgerSnapshot[] = []

  for (const outcome of settled) {
    if (outcome.status !== 'fulfilled') continue
    usage = addUsage(usage, outcome.value.usage)
    ledgers.push(outcome.value.ledger)
    if (outcome.value.digest) digests.push(outcome.value.digest)
  }

  return { digests, usage, ledgers }
}

export async function runResearch(
  input: { query: string; depth?: Depth; jobId?: string },
  onUsage?: (stats: JobUsage) => void,
): Promise<ResearchReport> {
  const depth = input.depth ?? 'standard'
  const jobId = input.jobId ?? '-'
  const profile = profiles[depth]
  const start = Date.now()

  log('research.start', { jobId, depth, queryPreview: input.query.slice(0, 200) })

  let leadUsage = emptyUsage()
  let workerUsage = emptyUsage()
  const allDigests: WorkerDigest[] = []
  const askedLower = new Set<string>()
  const allLedgers: LedgerSnapshot[] = []
  let workersDispatchedTotal = 0

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

    const { digests, usage, ledgers } = await dispatchRound(
      currentQuestions,
      depth,
      jobId,
      round,
      researchDeadlineAt,
    )
    workerUsage = addUsage(workerUsage, usage)
    allDigests.push(...digests)
    workersDispatchedTotal += currentQuestions.length
    allLedgers.push(...ledgers)

    // Emit a cumulative snapshot per round, not just once at the end. argo upserts
    // on (source, source_id, machine), so each snapshot overwrites the last rather
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
      digestsReturned: digests.length,
    })

    if (round >= profile.rounds) break

    const elapsed = Date.now() - start
    if (elapsed + profile.synthesisTimeoutMs >= profile.totalTimeoutMs) break

    const gapQuestions = nextRoundQuestions(digests, askedLower, profile.gapWorkers)
    if (gapQuestions.length === 0) break

    currentQuestions = gapQuestions
    round += 1
  }

  let submitted: SubmittedReport | null = null
  let reason: 'submit_report' | 'assembled' | 'empty' = 'empty'

  if (allDigests.length > 0) {
    const { report: synthesized, usage: synthesisUsage } = await synthesize({
      query: input.query,
      digests: allDigests,
      depth,
      jobId,
    })
    leadUsage = addUsage(leadUsage, synthesisUsage)

    if (synthesized) {
      submitted = synthesized
      reason = 'submit_report'
    } else {
      // Deterministic fallback — assembled in code, no LLM call. See assemble.ts.
      submitted = assembleReport(allDigests)
      reason = 'assembled'
    }
  }

  // Last-resort degraded stub: no digest was ever produced (every worker failed/timed out).
  if (!submitted) {
    submitted = {
      report: 'Research could not gather any evidence for this query before the budget was exhausted.',
      citations: [],
      sources: [],
      unverified: [],
    }
    reason = 'empty'
  }

  // The job-level gate. Every citation the synthesis model asserted is checked against the
  // union of what the workers' tools actually retrieved, `sources` is replaced by the pages
  // genuinely read, and `status`/`grounding` are counted in code. This is the invariant
  // from issue #1: a URL this run could not fetch can never back a citation.
  const jobLedger = mergeLedgers(allLedgers)
  const report: ResearchReport = groundReport(submitted, jobLedger)

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

  log('research.done', {
    jobId,
    reason,
    depth,
    rounds: round,
    workers: workersDispatchedTotal,
    digests: allDigests.length,
    citations: report.citations.length,
    sources: report.sources.length,
    status: report.status,
    pagesRetrieved: report.grounding.pagesRetrieved,
    pagesFailed: report.grounding.pagesFailed,
    citationsDropped: report.grounding.citationsDropped,
    confidenceCapped: report.grounding.confidenceCapped,
    inputTokens: combined.inputTokens,
    cachedInputTokens: combined.cachedInputTokens,
    outputTokens: combined.outputTokens,
    totalTokens: combined.totalTokens,
    reasoningTokens: combined.reasoningTokens,
    costUsd,
    wallMs,
  })

  return report
}
