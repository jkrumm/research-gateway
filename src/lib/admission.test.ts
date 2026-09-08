import { describe, it, expect } from 'bun:test'
import { admit, canDispatch, type AdmissionState } from './admission.js'

const idle: AdmissionState = { draining: false, memoryPressure: false, running: 0, queued: 0, maxQueue: 10 }

describe('admit', () => {
  it('admits when idle', () => {
    expect(admit(idle)).toBeNull()
  })

  it('refuses with draining in isolation', () => {
    const refusal = admit({ ...idle, draining: true })
    expect(refusal?.reason).toBe('draining')
    expect(refusal?.httpStatus).toBe(503)
    expect(refusal?.retryAfterSeconds).toBe(30)
  })

  it('refuses with memory_pressure in isolation', () => {
    const refusal = admit({ ...idle, memoryPressure: true })
    expect(refusal?.reason).toBe('memory_pressure')
    expect(refusal?.httpStatus).toBe(503)
    expect(refusal?.retryAfterSeconds).toBe(60)
  })

  it('refuses with queue_full in isolation', () => {
    const refusal = admit({ ...idle, running: 5, queued: 5, maxQueue: 10 })
    expect(refusal?.reason).toBe('queue_full')
    expect(refusal?.httpStatus).toBe(429)
    expect(refusal?.retryAfterSeconds).toBe(30)
  })

  it('draining beats memory_pressure and queue_full when all three hold', () => {
    const refusal = admit({ draining: true, memoryPressure: true, running: 10, queued: 10, maxQueue: 5 })
    expect(refusal?.reason).toBe('draining')
  })

  it('memory_pressure beats queue_full when both hold', () => {
    const refusal = admit({ draining: false, memoryPressure: true, running: 10, queued: 10, maxQueue: 5 })
    expect(refusal?.reason).toBe('memory_pressure')
  })

  it('admits at exactly one below the maxQueue boundary', () => {
    expect(admit({ ...idle, running: 4, queued: 5, maxQueue: 10 })).toBeNull()
  })

  it('refuses at exactly the maxQueue boundary', () => {
    const refusal = admit({ ...idle, running: 5, queued: 5, maxQueue: 10 })
    expect(refusal?.reason).toBe('queue_full')
  })

  it('refuses one above the maxQueue boundary', () => {
    const refusal = admit({ ...idle, running: 6, queued: 5, maxQueue: 10 })
    expect(refusal?.reason).toBe('queue_full')
  })
})

// The other half of the shedding policy. `admit()` alone is not enough: refusing new
// submissions while the queue keeps handing freed slots to backlogged jobs replaces exactly
// the memory a finishing job released, which is the failure the 2026-09-04 OOM kill was.
describe('canDispatch', () => {
  const idleDispatch = { memoryPressure: false, running: 0, queued: 1, maxConcurrency: 3 }

  it('dispatches when a slot is free and work is waiting', () => {
    expect(canDispatch(idleDispatch)).toBe(true)
  })

  it('refuses to start queued work while under memory pressure, even with free slots', () => {
    expect(canDispatch({ ...idleDispatch, memoryPressure: true })).toBe(false)
  })

  it('refuses when every slot is taken', () => {
    expect(canDispatch({ ...idleDispatch, running: 3 })).toBe(false)
  })

  it('refuses when nothing is queued', () => {
    expect(canDispatch({ ...idleDispatch, queued: 0 })).toBe(false)
  })

  it('resumes the moment pressure clears, with the backlog untouched', () => {
    const underPressure = { memoryPressure: true, running: 0, queued: 5, maxConcurrency: 3 }
    expect(canDispatch(underPressure)).toBe(false)
    expect(canDispatch({ ...underPressure, memoryPressure: false })).toBe(true)
  })
})
