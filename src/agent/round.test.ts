import { describe, it, expect } from 'bun:test'
import {
  shouldRetryRound,
  describeFailures,
  collectRoundOutcome,
  ROUND_RETRY_BACKOFF_MS,
  WORKER_ABORT_GRACE_MS,
  type WorkerOutcome,
} from './round.js'
import type { WorkerDigest } from './schema.js'
import type { LedgerSnapshot } from './ledger.js'

const base = {
  digests: 0,
  failures: 1,
  now: 0,
  researchDeadlineAt: 300_000,
  workerTimeoutMs: 60_000,
  alreadyRetried: false,
}

// base's needed margin: workerTimeoutMs(60_000) + ROUND_RETRY_BACKOFF_MS(20_000) +
// WORKER_ABORT_GRACE_MS(30_000) = 110_000ms.

describe('shouldRetryRound', () => {
  it('retries a round that failed fast with the budget untouched', () => {
    expect(shouldRetryRound(base)).toBe(true)
  })

  it('does not retry once a job has already retried once', () => {
    expect(shouldRetryRound({ ...base, alreadyRetried: true })).toBe(false)
  })

  it('does not retry when the remaining window is smaller than one worker budget', () => {
    // Only 50_000ms left before the research deadline, but a worker needs far more once
    // backoff + abort grace are counted.
    expect(shouldRetryRound({ ...base, now: 250_000 })).toBe(false)
  })

  it('does not retry when at least one digest came back', () => {
    expect(shouldRetryRound({ ...base, digests: 1 })).toBe(false)
  })

  it('does not retry when nothing failed (an empty round with no worker dispatched)', () => {
    expect(shouldRetryRound({ ...base, failures: 0 })).toBe(false)
  })

  it('no longer retries at the old (bare workerTimeoutMs) boundary', () => {
    // Window is workerTimeoutMs + 1 — enough under the old gate, not under the widened one.
    expect(shouldRetryRound({ ...base, now: base.researchDeadlineAt - (60_000 + 1) })).toBe(false)
  })

  it('does not retry when the window exactly equals the full widened margin', () => {
    // Deadline math is a strict `>`, so equality is still "not enough".
    const needed = 60_000 + ROUND_RETRY_BACKOFF_MS + WORKER_ABORT_GRACE_MS
    expect(shouldRetryRound({ ...base, now: base.researchDeadlineAt - needed })).toBe(false)
  })

  it('retries when the window is one millisecond more than the full widened margin', () => {
    const needed = 60_000 + ROUND_RETRY_BACKOFF_MS + WORKER_ABORT_GRACE_MS
    expect(shouldRetryRound({ ...base, now: base.researchDeadlineAt - (needed + 1) })).toBe(true)
  })
})

describe('describeFailures', () => {
  it('reports a fixed message for an empty list', () => {
    expect(describeFailures([])).toBe('no worker produced a digest')
  })

  it('dedupes repeated errors', () => {
    expect(describeFailures(['Forbidden', 'Forbidden', 'Forbidden'])).toBe('Forbidden')
  })

  it('shows up to 3 distinct causes with no marker when nothing was hidden', () => {
    const result = describeFailures(['a', 'b', 'c'])
    expect(result).toBe('a; b; c')
  })

  it('caps at 3 distinct causes and marks how many more were dropped', () => {
    const result = describeFailures(['a', 'b', 'c', 'd', 'e'])
    expect(result).toBe('a; b; c (+2 more)')
  })

  it('caps the joined string length around 300 chars', () => {
    const long = 'x'.repeat(200)
    const result = describeFailures([long, `${long}y`, `${long}z`])
    expect(result.length).toBeLessThanOrEqual(300)
    expect(result.endsWith('...')).toBe(true)
  })

  it('keeps the (+N more) marker intact even when the shown causes must be truncated', () => {
    const long = 'x'.repeat(200)
    const causes = [long, `${long}y`, `${long}z`, `${long}w`, `${long}v`]
    const result = describeFailures(causes)
    expect(result.length).toBeLessThanOrEqual(300)
    expect(result.endsWith('(+2 more)')).toBe(true)
  })
})

describe('ROUND_RETRY_BACKOFF_MS / WORKER_ABORT_GRACE_MS', () => {
  it('are positive numbers of milliseconds', () => {
    expect(ROUND_RETRY_BACKOFF_MS).toBeGreaterThan(0)
    expect(WORKER_ABORT_GRACE_MS).toBeGreaterThan(0)
  })
})

describe('collectRoundOutcome', () => {
  const usageA = {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    reasoningTokens: 1,
    cachedInputTokens: 2,
    durationMs: 100,
  }
  const usageB = {
    inputTokens: 20,
    outputTokens: 7,
    totalTokens: 27,
    reasoningTokens: 0,
    cachedInputTokens: 4,
    durationMs: 200,
  }
  const ledgerA = { retrieved: [], failed: [], snippet: [] } as unknown as LedgerSnapshot
  const ledgerB = { retrieved: ['x'], failed: [], snippet: [] } as unknown as LedgerSnapshot
  const digest = { findings: [] } as unknown as WorkerDigest

  it('records a rejected settled promise as a failure', () => {
    const settled: PromiseSettledResult<WorkerOutcome>[] = [{ status: 'rejected', reason: new Error('boom') }]
    const result = collectRoundOutcome(settled)
    expect(result.failures).toEqual(['Error: boom'])
    expect(result.digests).toEqual([])
  })

  it('collects a digest from a fulfilled outcome', () => {
    const settled: PromiseSettledResult<WorkerOutcome>[] = [
      { status: 'fulfilled', value: { digest, usage: usageA, ledger: ledgerA } },
    ]
    const result = collectRoundOutcome(settled)
    expect(result.digests).toEqual([digest])
    expect(result.failures).toEqual([])
  })

  it('records a fulfilled outcome with no digest but an explicit error', () => {
    const settled: PromiseSettledResult<WorkerOutcome>[] = [
      { status: 'fulfilled', value: { digest: null, usage: usageA, ledger: ledgerA, error: 'Forbidden' } },
    ]
    const result = collectRoundOutcome(settled)
    expect(result.failures).toEqual(['Forbidden'])
    expect(result.digests).toEqual([])
  })

  it('records a synthetic cause for a fulfilled outcome with neither digest nor error (the regression case)', () => {
    const settled: PromiseSettledResult<WorkerOutcome>[] = [
      { status: 'fulfilled', value: { digest: null, usage: usageA, ledger: ledgerA } },
    ]
    const result = collectRoundOutcome(settled)
    expect(result.failures).toEqual(['worker completed without a valid digest'])
    expect(result.digests).toEqual([])
  })

  it('accumulates usage and ledgers across a mixed batch', () => {
    const settled: PromiseSettledResult<WorkerOutcome>[] = [
      { status: 'fulfilled', value: { digest, usage: usageA, ledger: ledgerA } },
      { status: 'fulfilled', value: { digest: null, usage: usageB, ledger: ledgerB, error: 'Forbidden' } },
      { status: 'rejected', reason: 'unexpected throw' },
    ]
    const result = collectRoundOutcome(settled)
    expect(result.digests).toEqual([digest])
    expect(result.ledgers).toEqual([ledgerA, ledgerB])
    expect(result.failures).toEqual(['Forbidden', 'unexpected throw'])
    expect(result.usage).toEqual({
      inputTokens: 30,
      outputTokens: 12,
      totalTokens: 42,
      reasoningTokens: 1,
      cachedInputTokens: 6,
      durationMs: 300,
    })
  })
})
