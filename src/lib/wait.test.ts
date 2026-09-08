import { describe, it, expect } from 'bun:test'
import { waitDeadline, shouldKeepWaiting, POLL_INTERVAL_MS } from './wait.js'

const NOW = 1_700_000_000_000

describe('waitDeadline', () => {
  it('is unbounded when the caller asks for no limit — the default job_wait shape', () => {
    expect(waitDeadline(NOW)).toBeNull()
  })

  it('honours an explicit budget', () => {
    expect(waitDeadline(NOW, 30_000)).toBe(NOW + 30_000)
  })

  it('does not cap a large budget — a deep job legitimately runs past 20 minutes', () => {
    expect(waitDeadline(NOW, 2_400_000)).toBe(NOW + 2_400_000)
  })

  it('floors a nonsensical budget rather than turning the call into a status read', () => {
    expect(waitDeadline(NOW, 0)).toBe(NOW + 1_000)
    expect(waitDeadline(NOW, -5)).toBe(NOW + 1_000)
  })
})

describe('shouldKeepWaiting', () => {
  const base = { now: NOW, deadline: null, aborted: false } as const

  it('keeps waiting on a queued or running job with no deadline', () => {
    expect(shouldKeepWaiting({ ...base, status: 'queued' })).toBe(true)
    expect(shouldKeepWaiting({ ...base, status: 'running' })).toBe(true)
  })

  it('stops on a terminal status — the guarantee the unbounded wait rests on', () => {
    expect(shouldKeepWaiting({ ...base, status: 'done' })).toBe(false)
    expect(shouldKeepWaiting({ ...base, status: 'error' })).toBe(false)
  })

  it('stops when the client aborts, even with time and a live job left', () => {
    expect(shouldKeepWaiting({ ...base, status: 'running', aborted: true })).toBe(false)
  })

  it('stops at an explicit deadline, and not one tick before it', () => {
    expect(shouldKeepWaiting({ ...base, status: 'running', deadline: NOW + 1 })).toBe(true)
    expect(shouldKeepWaiting({ ...base, status: 'running', deadline: NOW })).toBe(false)
  })

  it('a terminal job wins over a deadline that has not elapsed', () => {
    expect(shouldKeepWaiting({ ...base, status: 'done', deadline: NOW + 60_000 })).toBe(false)
  })
})

describe('POLL_INTERVAL_MS', () => {
  it('stays well inside the SDK 15s SSE keep-alive so a poll never races the stream', () => {
    expect(POLL_INTERVAL_MS).toBeLessThan(15_000)
  })
})
