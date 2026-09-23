// The round loop itself, extracted from `run.ts` so it is unit-testable without booting the
// env/LLM import chain — same convention `round.ts` already established for the per-round
// reducer/retry-rule this file drives. Pure and `env`-free: every side effect (dispatching a
// round, computing the next round's questions, persisting a checkpoint, deciding whether this
// process still owns the job) is injected, never imported.
//
// Also where the fenced-run guard lives: a job whose lease was taken over by another replica
// (`job-store.ts`'s `claimStaleJobs`) must stop at the next checkpoint boundary rather than run
// to completion — the adopter is already resuming from the checkpoint this process last wrote,
// so anything this process produces past that point is duplicate paid LLM calls (and, for a
// paper-reading job, duplicate pdftotext subprocesses) that the owner fence (job-db.ts's `put`)
// will discard anyway. `isFenced` is checked before every round dispatch and before the retry
// dispatch; `run.ts` checks it once more itself, before synthesis, since that step lives outside
// this loop.

import type { SubQuestion, WorkerDigest } from './schema.js'
import type { LedgerSnapshot } from './ledger.js'
import type { UsageStats } from '../lib/usage.js'
import type { DepthProfile } from './depth.js'
import { shouldRetryRound, ROUND_RETRY_BACKOFF_MS, type RoundResult } from './round.js'
import { FencedError } from './fenced-error.js'

// Deliberately NOT `lib/usage.js`'s `emptyUsage`/`addUsage` — that module imports `env.js` at
// the top for `reportUsage`'s ARGO_* gate, which would break this module's "pure, env-free,
// unit-testable with zero env vars" premise. Same reasoning `round.ts`'s own accumulation uses.
const EMPTY_USAGE: UsageStats = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  reasoningTokens: 0,
  cachedInputTokens: 0,
  durationMs: 0,
}

function sumUsage(a: UsageStats, b: UsageStats): UsageStats {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    durationMs: a.durationMs + b.durationMs,
  }
}

// Everything `runRounds` accumulates across rounds — a superset of what a `ResearchCheckpoint`
// needs (run.ts adds `leadUsage`, which this loop never touches, to build the full checkpoint).
export interface RoundsState {
  allDigests: WorkerDigest[]
  allLedgers: LedgerSnapshot[]
  allFailures: string[]
  askedLower: Set<string>
  workerUsage: UsageStats
  workersDispatchedTotal: number
  alreadyRetried: boolean
  /** The round this state reflects — the LAST round dispatched, not the next one to run. */
  round: number
}

// The subset of a `ResearchCheckpoint` this loop needs restored to resume from round N rather
// than round 1 — everything else (`subQuestions`, `round` itself) is passed as
// `initialQuestions`/`initialRound` instead, since those describe what to run NEXT, not state
// accumulated so far.
export interface RoundsRestore {
  digests: WorkerDigest[]
  ledgers: LedgerSnapshot[]
  failures: string[]
  askedLower: string[]
  workerUsage: UsageStats
  workersDispatchedTotal: number
  alreadyRetried: boolean
}

export interface RunRoundsInput {
  profile: DepthProfile
  initialQuestions: SubQuestion[]
  initialRound: number
  restore?: RoundsRestore | null
  dispatchRound: (subQuestions: SubQuestion[], round: number, retry: boolean) => Promise<RoundResult>
  nextRoundQuestions: (digests: WorkerDigest[], askedLower: Set<string>, gapWorkers: number) => SubQuestion[]
  /**
   * Called after a round (including its retry, if one ran) has fully settled, with the NEXT
   * round's questions/number already computed — the hook point for persisting a full resumable
   * checkpoint. NOT called after the round that ends the job (no gap questions left): there is
   * nothing left to resume into.
   */
  onCheckpoint?: (state: RoundsState, nextQuestions: SubQuestion[], nextRound: number) => void
  /**
   * Called once a round has fully settled (including its retry), before `onCheckpoint` — the
   * hook point for a per-round usage snapshot or log line, which need `state` plus which
   * questions this round actually dispatched.
   */
  onRoundComplete?: (args: { round: number; state: RoundsState; roundDigests: WorkerDigest[]; workersDispatched: number }) => void
  /** Called when a round lost every worker and is about to be retried, before the backoff sleep. */
  onRetry?: (args: { round: number; failures: string[] }) => void
  /**
   * True once this process no longer owns the job's lease. Checked before every round dispatch
   * and before the retry dispatch; a positive check throws `FencedError` instead of continuing.
   */
  isFenced: () => boolean
  /** Overridable only for tests — production always wants the real timer. */
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms))

export async function runRounds(input: RunRoundsInput): Promise<RoundsState> {
  const { profile, dispatchRound, nextRoundQuestions, onCheckpoint, onRoundComplete, onRetry, isFenced } = input
  const sleep = input.sleep ?? defaultSleep
  const restore = input.restore ?? null

  const state: RoundsState = {
    allDigests: restore ? [...restore.digests] : [],
    allLedgers: restore ? [...restore.ledgers] : [],
    allFailures: restore ? [...restore.failures] : [],
    askedLower: new Set<string>(restore ? restore.askedLower : []),
    workerUsage: restore ? restore.workerUsage : EMPTY_USAGE,
    workersDispatchedTotal: restore ? restore.workersDispatchedTotal : 0,
    alreadyRetried: restore ? restore.alreadyRetried : false,
    round: input.initialRound,
  }

  let currentQuestions = input.initialQuestions
  let round = input.initialRound

  while (currentQuestions.length > 0) {
    if (isFenced()) throw new FencedError(`research job fenced before dispatching round ${round}`)

    for (const sq of currentQuestions) state.askedLower.add(sq.question.trim().toLowerCase())

    const roundDigests: WorkerDigest[] = []
    const absorb = (result: RoundResult): void => {
      state.workerUsage = sumUsage(state.workerUsage, result.usage)
      state.allDigests.push(...result.digests)
      roundDigests.push(...result.digests)
      state.workersDispatchedTotal += currentQuestions.length
      state.allLedgers.push(...result.ledgers)
      state.allFailures.push(...result.failures)
    }

    const first = await dispatchRound(currentQuestions, round, false)
    absorb(first)

    // One retry per JOB, not per round — see round.ts's header for the evidence and the exact
    // rule `shouldRetryRound` encodes.
    if (shouldRetryRound({ digests: first.digests.length, failures: first.failures.length, alreadyRetried: state.alreadyRetried })) {
      onRetry?.({ round, failures: first.failures })
      await sleep(ROUND_RETRY_BACKOFF_MS)
      if (isFenced()) throw new FencedError(`research job fenced before retrying round ${round}`)
      state.alreadyRetried = true
      absorb(await dispatchRound(currentQuestions, round, true))
    }

    state.round = round
    onRoundComplete?.({ round, state, roundDigests, workersDispatched: currentQuestions.length })

    // Checkpoint after this completed round — including its retry, if one ran — with the NEXT
    // round's questions (empty once there is nothing left to run).
    const gapQuestions = round < profile.rounds ? nextRoundQuestions(roundDigests, state.askedLower, profile.gapWorkers) : []
    const nextRound = gapQuestions.length > 0 ? round + 1 : round
    onCheckpoint?.(state, gapQuestions, nextRound)

    if (gapQuestions.length === 0) break
    currentQuestions = gapQuestions
    round = nextRound
  }

  state.round = round
  return state
}
