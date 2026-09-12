// A round's outcome shape (a worker-outcome reducer) and its retry rule. Pure and `env`-free
// so it is unit-testable without booting the env/llm import chain — same convention as
// `src/lib/admission.ts` / `src/lib/wait.ts`.
//
// The motivating evidence (14-day telemetry, 2026-09-11): 9 of 19 `partial` jobs produced ZERO
// worker digests, and every one traces to an upstream IU-endpoint failure that died in
// milliseconds, not to a research budget running out —
//   2026-09-10 12:22-12:32Z: `worker.failed … elapsedMs:66, error:"AI_APICallError: Forbidden"`
//     — three jobs, all instant.
//   2026-08-31 10:35-11:00Z: `AI_RetryError: … Service Unavailable` across 6 workers + 3 plans.
// A round that fails THAT fast is nearly free to retry once. There is no research deadline to
// protect any more (settled 2026-09-12 — the agent loop has no wall-clock ceiling), so the gate
// is just "did every worker fail, and have we not already used the one retry this job gets" —
// see `shouldRetryRound` below.

import type { WorkerDigest } from './schema.js'
import type { LedgerSnapshot } from './ledger.js'
import type { UsageStats } from '../lib/usage.js'

// Fixed pause before a retried round starts — not a step/turn or wall-clock ceiling on the
// agent loop, just a deliberate backoff so a retry doesn't immediately re-hit a provider that
// just 403'd or 503'd.
export const ROUND_RETRY_BACKOFF_MS = 20_000

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

// Whether a round that lost every worker deserves a second try. With no research deadline to
// protect (settled 2026-09-12), the only guards left are the ones that make the retry
// meaningful at all: it actually lost every worker, and this job hasn't already spent its one
// retry.
export function shouldRetryRound(args: {
  digests: number
  failures: number
  alreadyRetried: boolean
}): boolean {
  if (args.digests !== 0) return false
  if (args.failures === 0) return false
  if (args.alreadyRetried) return false
  return true
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
