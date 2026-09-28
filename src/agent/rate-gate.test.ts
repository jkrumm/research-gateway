import { describe, it, expect, spyOn } from 'bun:test'
import { createRateGate } from './rate-gate.js'

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

describe('createRateGate', () => {
  it('never overlaps two calls when the first is slow', async () => {
    const gate = createRateGate(0)
    let active = 0
    let overlapped = false
    const slow = async () => {
      active++
      if (active > 1) overlapped = true
      await tick(30)
      active--
      return 'first'
    }
    const fast = async () => {
      active++
      if (active > 1) overlapped = true
      active--
      return 'second'
    }

    const [a, b] = await Promise.all([gate(slow), gate(fast)])
    expect(a).toBe('first')
    expect(b).toBe('second')
    expect(overlapped).toBe(false)
  })

  it('does not wedge the next call when a call rejects', async () => {
    const gate = createRateGate(0)
    await expect(gate(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    expect(await gate(() => Promise.resolve('ok'))).toBe('ok')
  })

  it('honours the minimum interval between call starts', async () => {
    const gate = createRateGate(50)
    const starts: number[] = []
    const record = async () => {
      starts.push(Date.now())
      return null
    }
    await gate(record)
    await gate(record)
    await gate(record)
    expect(starts.length).toBe(3)
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(45) // small slack for timer jitter
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(45)
  })

  it('never waits on the first call, even at a nonzero fake clock reading (boot regression)', async () => {
    const nowSpy = spyOn(performance, 'now').mockReturnValue(100)
    const originalSetTimeout = globalThis.setTimeout
    let setTimeoutCalled = false
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((cb: () => void, ms?: number) => {
      setTimeoutCalled = true
      return originalSetTimeout(cb, ms)
    }) as typeof setTimeout)
    try {
      const gate = createRateGate(3000)
      const result = await gate(() => Promise.resolve('ok'))
      expect(result).toBe('ok')
      expect(setTimeoutCalled).toBe(false)
    } finally {
      nowSpy.mockRestore()
      setTimeoutSpy.mockRestore()
    }
  })

  it('rejects a non-finite or negative minIntervalMs rather than silently misbehaving', () => {
    expect(() => createRateGate(-1)).toThrow()
    expect(() => createRateGate(NaN)).toThrow()
    expect(() => createRateGate(Infinity)).toThrow()
  })

  it('still allows 0 — no minimum interval at all', () => {
    expect(() => createRateGate(0)).not.toThrow()
  })

  it('serializes many concurrent calls in arrival order with no overlap', async () => {
    const gate = createRateGate(5)
    let active = 0
    let overlapped = false
    const order: number[] = []
    const work = (n: number) => async () => {
      active++
      if (active > 1) overlapped = true
      await tick(2)
      order.push(n)
      active--
    }
    await Promise.all([1, 2, 3, 4].map((n) => gate(work(n))))
    expect(overlapped).toBe(false)
    expect(order).toEqual([1, 2, 3, 4])
  })
})
