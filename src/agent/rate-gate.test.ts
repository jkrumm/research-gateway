import { describe, it, expect } from 'bun:test'
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
