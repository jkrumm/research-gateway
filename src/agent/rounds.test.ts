import { describe, it, expect } from 'bun:test'
import { runRounds, type RoundsRestore } from './rounds.js'
import { FencedError } from './fenced-error.js'
import type { RoundResult } from './round.js'
import type { SubQuestion, WorkerDigest } from './schema.js'
import type { DepthProfile } from './depth.js'

const profile = { rounds: 3, gapWorkers: 2 } as DepthProfile

const usage = (n: number) => ({
  inputTokens: n,
  outputTokens: n,
  totalTokens: n * 2,
  reasoningTokens: 0,
  cachedInputTokens: 0,
  durationMs: n,
})

const digest = (q: string): WorkerDigest => ({ findings: [], question: q }) as unknown as WorkerDigest
const sq = (q: string): SubQuestion => ({ question: q }) as SubQuestion

function okResult(qs: SubQuestion[], n: number): RoundResult {
  return {
    digests: qs.map((q) => digest(q.question)),
    usage: usage(n),
    ledgers: [],
    failures: [],
  }
}

function emptyResult(failures: string[]): RoundResult {
  return { digests: [], usage: usage(0), ledgers: [], failures }
}

const noSleep = () => Promise.resolve()

describe('runRounds', () => {
  it('runs a single round with no gap questions and returns the accumulated state', async () => {
    const questions = [sq('a'), sq('b')]
    const dispatched: Array<{ round: number; retry: boolean }> = []
    const result = await runRounds({
      profile,
      initialQuestions: questions,
      initialRound: 1,
      isFenced: () => false,
      dispatchRound: async (qs, round, retry) => {
        dispatched.push({ round, retry })
        return okResult(qs, 5)
      },
      nextRoundQuestions: () => [],
    })

    expect(dispatched).toEqual([{ round: 1, retry: false }])
    expect(result.allDigests.length).toBe(2)
    expect(result.workerUsage).toEqual(usage(5))
    expect(result.workersDispatchedTotal).toBe(2)
    expect(result.round).toBe(1)
    expect([...result.askedLower]).toEqual(['a', 'b'])
  })

  it('advances through gap rounds using nextRoundQuestions, and checkpoints between them', async () => {
    const checkpoints: Array<{ nextQuestions: SubQuestion[]; nextRound: number }> = []
    const result = await runRounds({
      profile,
      initialQuestions: [sq('a')],
      initialRound: 1,
      isFenced: () => false,
      dispatchRound: async (qs) => okResult(qs, 1),
      nextRoundQuestions: (_digests, _asked, gapWorkers) => {
        // Round 1 -> gap round 2 with `gapWorkers` new questions; round 2 -> stop.
        return checkpoints.length === 0 ? Array.from({ length: gapWorkers }, (_, i) => sq(`gap-${i}`)) : []
      },
      onCheckpoint: (_state, nextQuestions, nextRound) => {
        checkpoints.push({ nextQuestions, nextRound })
      },
    })

    expect(checkpoints.length).toBe(2)
    expect(checkpoints[0]!.nextRound).toBe(2)
    expect(checkpoints[0]!.nextQuestions.length).toBe(2)
    expect(checkpoints[1]!.nextRound).toBe(2) // no more gap questions — round number does not advance again
    expect(checkpoints[1]!.nextQuestions).toEqual([])
    expect(result.round).toBe(2)
    expect(result.allDigests.length).toBe(3) // 1 from round 1 + 2 from round 2
  })

  it('retries a round that lost every worker exactly once, then proceeds', async () => {
    let calls = 0
    const onRetry: Array<{ round: number; failures: string[] }> = []
    const result = await runRounds({
      profile,
      initialQuestions: [sq('a')],
      initialRound: 1,
      isFenced: () => false,
      sleep: noSleep,
      dispatchRound: async (qs, _round, retry) => {
        calls++
        if (!retry) return emptyResult(['Forbidden'])
        return okResult(qs, 3)
      },
      nextRoundQuestions: () => [],
      onRetry: (args) => onRetry.push(args),
    })

    expect(calls).toBe(2) // first pass + one retry, never a second retry
    expect(onRetry).toEqual([{ round: 1, failures: ['Forbidden'] }])
    expect(result.allDigests.length).toBe(1)
    expect(result.alreadyRetried).toBe(true)
  })

  it('throws FencedError before dispatching a round once fenced, and never dispatches it', async () => {
    let fenced = false
    const dispatched: number[] = []
    const promise = runRounds({
      profile,
      initialQuestions: [sq('a')],
      initialRound: 1,
      sleep: noSleep,
      isFenced: () => fenced,
      dispatchRound: async (qs, round) => {
        dispatched.push(round)
        fenced = true // fenced by the time round 2 would be considered
        return okResult(qs, 1)
      },
      nextRoundQuestions: (_d, _a, gapWorkers) => (dispatched.length === 1 ? [sq('gap')] : []),
    })

    await expect(promise).rejects.toBeInstanceOf(FencedError)
    expect(dispatched).toEqual([1]) // round 2 never dispatched
  })

  it('throws FencedError before the retry dispatch when fenced during the backoff', async () => {
    const dispatched: Array<{ round: number; retry: boolean }> = []
    const promise = runRounds({
      profile,
      initialQuestions: [sq('a')],
      initialRound: 1,
      isFenced: () => dispatched.length > 0, // fenced right after the first pass
      sleep: noSleep,
      dispatchRound: async (qs, round, retry) => {
        dispatched.push({ round, retry })
        return emptyResult(['boom'])
      },
      nextRoundQuestions: () => [],
    })

    await expect(promise).rejects.toBeInstanceOf(FencedError)
    expect(dispatched).toEqual([{ round: 1, retry: false }]) // the retry dispatch never happened
  })

  it('restoring from a round-2 checkpoint skips round 1 entirely and carries prior state through', async () => {
    const restore: RoundsRestore = {
      digests: [digest('round1-a')],
      ledgers: [],
      failures: ['earlier failure'],
      askedLower: ['already asked'],
      workerUsage: usage(10),
      workersDispatchedTotal: 4,
      alreadyRetried: true,
    }
    const dispatched: number[] = []

    const result = await runRounds({
      profile,
      initialQuestions: [sq('round2-question')],
      initialRound: 2,
      restore,
      isFenced: () => false,
      dispatchRound: async (qs, round) => {
        dispatched.push(round)
        return okResult(qs, 5)
      },
      nextRoundQuestions: () => [],
    })

    expect(dispatched).toEqual([2]) // round 1 never re-dispatched
    // Prior state carried through and the new round's results appended to it.
    expect(result.allDigests.map((d) => (d as unknown as { question: string }).question)).toEqual([
      'round1-a',
      'round2-question',
    ])
    expect(result.allFailures).toEqual(['earlier failure'])
    expect([...result.askedLower].sort()).toEqual(['already asked', 'round2-question'].sort())
    expect(result.workerUsage).toEqual(usage(15)) // 10 restored + 5 from round 2
    expect(result.workersDispatchedTotal).toBe(5) // 4 restored + 1
    expect(result.alreadyRetried).toBe(true) // no retry ran, but the restored flag survives
  })
})
