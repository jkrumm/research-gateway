import { describe, it, expect } from 'bun:test'
import { consistencySkipReason, CONSISTENCY_MIN_REPORT_CHARS } from './consistency-gate.js'

const base = { depth: 'standard', digestCount: 3, reportChars: 15_000 } as const

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
})
