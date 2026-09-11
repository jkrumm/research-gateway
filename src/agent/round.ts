// A round's outcome shape (a worker-outcome reducer) and its retry rule. Pure and `env`-free
// so it is unit-testable without booting the env/llm import chain — same convention as
// `src/lib/admission.ts` / `src/lib/wait.ts`.
//
// The motivating evidence (14-day telemetry, 2026-09-11): 9 of 19 `partial` jobs produced ZERO
// worker digests, and every one traces to an upstream IU-endpoint failure that died in
// milliseconds, not to the research budget running out —
//   2026-09-10 12:22-12:32Z: `worker.failed … elapsedMs:66, budgetMs:300000,
//     error:"AI_APICallError: Forbidden"` — a worker that had 300 000 ms to work with died in
//     66 ms. Three jobs, all instant.
//   2026-08-31 10:35-11:00Z: `AI_RetryError: … Service Unavailable` across 6 workers + 3 plans,
//     plus `research.plan` hitting `TimeoutError` at exactly 120 003 ms.
// A round that fails THAT fast leaves its research budget almost entirely untouched, so a second
// pass is nearly free — but only if there is genuinely enough time left for a FULL worker pass,
// including the retry's own backoff sleep and its worker's own outer abort grace (see the exact
// arithmetic on `shouldRetryRound` below). That is the whole principle behind the deadline check:
// a retry must never eat into the window synthesis is reserved (see run.ts's
// `researchDeadlineAt`). It also self-selects the right cases for free — a round that failed
// fast (provider 403/503) has budget left and retries; a round that actually consumed its
// budget chasing real work does not.
//
// The gate also assumes a round's workers all fit in one `WORKER_MAX_CONCURRENCY` batch (the
// worker-count check against `researchDeadlineAt` treats the whole round as running in
// parallel). If that env var ever drops below a round's worker count, the round runs in
// sequential batches and this under-estimates the true wall-clock cost of a retry — harmless
// today because worker.ts's `nearJobDeadline` arm force-submits regardless, but the gate would
// no longer actually be checking the invariant it claims to.

import type { WorkerDigest } from './schema.js'
import type { LedgerSnapshot } from './ledger.js'
import type { UsageStats } from '../lib/usage.js'

export const ROUND_RETRY_BACKOFF_MS = 20_000

// The grace `worker.ts`'s outer `AbortSignal.timeout` adds on top of a worker's own timeout
// budget, so a worker that is about to be force-submitted (its in-loop deadline arms) still has
// room to actually finish that last step before the hard abort lands. Stated once here — and
// imported by worker.ts — instead of the same number living in two files.
export const WORKER_ABORT_GRACE_MS = 30_000

export interface RoundResult {
  digests: WorkerDigest[]
  usage: UsageStats
  ledgers: LedgerSnapshot[]
  // Every worker's failure cause (from its own catch, from a clean resolve that still carries
  // no digest, or from this module's own defensive `rejected` branch below), kept so a round
  // that lost every worker can be told apart in the job's outcome from one that simply had no
  // questions — and so `describeFailures` can name the real cause instead of a fabricated
  // "budget exhausted".
  failures: string[]
}

// What one worker settles to, from `run.ts`'s point of view: either `runWorker`'s resolved
// value, or (via `Promise.allSettled`) the rejection the run.ts side must also account for.
export interface WorkerOutcome {
  digest: WorkerDigest | null
  usage: UsageStats
  ledger: LedgerSnapshot
  error?: string
}

// Reduces one round's settled worker outcomes into a `RoundResult`. `Promise.allSettled`'s
// `rejected` branch is a second, defensive layer — `runWorker` already catches internally — so
// an unexpected throw can never abort the round. Usage/ledger accumulation intentionally avoids
// `lib/usage.js`'s `addUsage`/`emptyUsage`: that module imports `env.js` at the top for
// `reportUsage`'s ARGO_* gate, which parses `process.env` at import time and throws without
// secrets — pulling it in here would silently break this module's whole "pure, env-free, unit
// testable with zero env vars" premise.
export function collectRoundOutcome(settled: PromiseSettledResult<WorkerOutcome>[]): RoundResult {
  let usage: UsageStats = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    durationMs: 0,
  }
  const digests: WorkerDigest[] = []
  const ledgers: LedgerSnapshot[] = []
  const failures: string[] = []

  for (const outcome of settled) {
    if (outcome.status === 'rejected') {
      failures.push(String(outcome.reason))
      continue
    }

    usage = {
      inputTokens: usage.inputTokens + outcome.value.usage.inputTokens,
      outputTokens: usage.outputTokens + outcome.value.usage.outputTokens,
      totalTokens: usage.totalTokens + outcome.value.usage.totalTokens,
      reasoningTokens: usage.reasoningTokens + outcome.value.usage.reasoningTokens,
      cachedInputTokens: usage.cachedInputTokens + outcome.value.usage.cachedInputTokens,
      durationMs: usage.durationMs + outcome.value.usage.durationMs,
    }
    ledgers.push(outcome.value.ledger)

    if (outcome.value.digest) {
      digests.push(outcome.value.digest)
    } else {
      // A worker can resolve cleanly (no throw, so it never hits the `.error` branch in
      // worker.ts's catch) and still carry no digest — the model never called
      // `submit_digest`, or `extractDigest` got malformed tool args back. Left unrecorded,
      // this class lands in neither `digests` nor `failures`: `shouldRetryRound`'s
      // `failures === 0` guard then skips the retry for exactly this case, and if it
      // happens to every worker in a round, the job throws with `describeFailures([])`'s
      // generic fallback — mislabelling an LLM formatting slip as an upstream outage. The
      // retry gate still self-selects correctly here: a worker that burned its whole budget
      // failing to submit leaves no room under the deadline check below, so this does not
      // turn every malformed digest into a doubled worker spend.
      failures.push(outcome.value.error ?? 'worker completed without a valid digest')
    }
  }

  return { digests, usage, ledgers, failures }
}

// Whether a round that lost every worker deserves a second try.
//
// Worst-case arithmetic for the margin below: taking the retry costs `ROUND_RETRY_BACKOFF_MS`
// (20s) of sleep before the retried round even starts, and the retried worker's own outer
// backstop is `AbortSignal.timeout(workerTimeoutMs + WORKER_ABORT_GRACE_MS)` (worker.ts) — up
// to 30s more than a bare `workerTimeoutMs` budget. A gate that only checked
// `> workerTimeoutMs` could clear and still let the retry overrun the window synthesis is
// reserved. Requiring the full `workerTimeoutMs + ROUND_RETRY_BACKOFF_MS +
// WORKER_ABORT_GRACE_MS` is what actually protects that invariant.
//
// Sanity-checked against `depth.ts`'s real profiles — all three still clear this widened gate
// on a fast (near-zero-elapsed) failure, worst case (now == start):
//   quick:    window = totalTimeoutMs(600s) - synthesisTimeoutMs(300s) = 300s vs needed
//             workerTimeoutMs(180s) + 20s + 30s = 230s
//   standard: window = 1500s - 600s = 900s vs needed 300s + 20s + 30s = 350s
//   deep:     window = 3000s - 900s = 2100s vs needed 420s + 20s + 30s = 470s
export function shouldRetryRound(args: {
  digests: number
  failures: number
  now: number
  researchDeadlineAt: number
  workerTimeoutMs: number
  alreadyRetried: boolean
}): boolean {
  if (args.digests !== 0) return false
  if (args.failures === 0) return false
  if (args.alreadyRetried) return false
  return (
    args.researchDeadlineAt - args.now >
    args.workerTimeoutMs + ROUND_RETRY_BACKOFF_MS + WORKER_ABORT_GRACE_MS
  )
}

// Turns a round's raw worker error strings into one short, human-readable cause for the
// `round.retry` log line — and, when a round loses every worker on every attempt, the terminal
// job error an operator reads. Dedupe first (the same "Forbidden" repeats across every worker
// in a round), then show at most 3 distinct causes plus a `(+N more)` marker when more were
// deduped, so the string never silently hides how wide the blast radius was. Capped at ~300
// chars total, with the marker surviving that cap rather than being sliced off.
export function describeFailures(failures: string[]): string {
  if (failures.length === 0) return 'no worker produced a digest'

  const deduped = [...new Set(failures)]
  const shown = deduped.slice(0, 3)
  const moreCount = deduped.length - shown.length
  const suffix = moreCount > 0 ? ` (+${moreCount} more)` : ''

  const joined = shown.join('; ')
  const budget = 300 - suffix.length
  const truncated = joined.length > budget ? `${joined.slice(0, budget - 3)}...` : joined
  return `${truncated}${suffix}`
}
