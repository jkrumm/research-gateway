import { describe, it, expect } from 'bun:test'
import { consistencySkipReason, noopConsistencyReview, CONSISTENCY_MIN_REPORT_CHARS } from './consistency-gate.js'
import type { UsageStats } from '../lib/usage.js'

const base = { depth: 'standard', digestCount: 3, reportChars: 15_000, divergenceCount: 1 } as const

describe('consistencySkipReason', () => {
  it('runs for a multi-digest standard/deep report of real size', () => {
    expect(consistencySkipReason(base)).toBeNull()
    expect(consistencySkipReason({ ...base, depth: 'deep' })).toBeNull()
  })
  it('skips quick regardless of size', () => {
    expect(consistencySkipReason({ ...base, depth: 'quick' })).toBe('quick-depth')
  })
  it('skips a single-digest report — nothing to disagree with', () => {
    expect(consistencySkipReason({ ...base, digestCount: 1 })).toBe('single-digest')
  })
  it('skips below the size floor, runs at it', () => {
    expect(consistencySkipReason({ ...base, reportChars: CONSISTENCY_MIN_REPORT_CHARS - 1 })).toBe('short-report')
    expect(consistencySkipReason({ ...base, reportChars: CONSISTENCY_MIN_REPORT_CHARS })).toBeNull()
  })
  it('skips when the digests carry no divergence signal, however large the report', () => {
    expect(consistencySkipReason({ ...base, divergenceCount: 0 })).toBe('no-divergence')
  })
  it('checks the cheap structural reasons before the divergence signal', () => {
    expect(consistencySkipReason({ ...base, depth: 'quick', divergenceCount: 0 })).toBe('quick-depth')
    expect(consistencySkipReason({ ...base, digestCount: 1, divergenceCount: 0 })).toBe('single-digest')
  })
})

describe('noopConsistencyReview', () => {
  it('returns the original report untouched, with no edits and no veto', () => {
    const usage: UsageStats = {
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 3,
      reasoningTokens: 0,
      cachedInputTokens: 0,
      durationMs: 4,
      reportedCostUsd: 0,
      unreportedCalls: 0,
    }
    expect(noopConsistencyReview('the report', usage)).toEqual({
      report: 'the report',
      corrected: false,
      appliedEdits: [],
      vetoed: false,
      usage,
    })
  })
})
