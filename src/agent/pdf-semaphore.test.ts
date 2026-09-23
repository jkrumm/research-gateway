import { describe, it, expect } from 'bun:test'
import { createUnboundedSemaphore } from './pdf-semaphore.js'

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

describe('createUnboundedSemaphore', () => {
  it('hands out up to the limit immediately and queues the rest', async () => {
    const sem = createUnboundedSemaphore(2)
    await sem.acquire()
    await sem.acquire()
    expect(sem.active).toBe(2)

    let thirdResolved = false
    const third = sem.acquire().then(() => {
      thirdResolved = true
    })
    await tick()
    expect(sem.queued).toBe(1)
    expect(thirdResolved).toBe(false)

    sem.release()
    await third
    expect(thirdResolved).toBe(true)
    expect(sem.active).toBe(2)
    expect(sem.queued).toBe(0)
  })

  it('never exceeds the limit — the property the concurrency cap rests on', async () => {
    const sem = createUnboundedSemaphore(2)
    let peak = 0
    await Promise.all(
      Array.from({ length: 10 }, async () => {
        await sem.acquire()
        peak = Math.max(peak, sem.active)
        await tick(2)
        sem.release()
      }),
    )
    expect(peak).toBe(2)
    expect(sem.active).toBe(0)
  })

  it('a waiter never rejects or times out — it just waits, however long that takes', async () => {
    const sem = createUnboundedSemaphore(1)
    await sem.acquire()
    let resolved = false
    const waiter = sem.acquire().then(() => {
      resolved = true
    })
    // Wait well past any plausible queue-timeout value and confirm it is STILL just waiting,
    // not rejected.
    await tick(100)
    expect(resolved).toBe(false)
    expect(sem.queued).toBe(1)

    sem.release()
    await waiter
    expect(resolved).toBe(true)
  })

  it('serves waiters in arrival order (FIFO)', async () => {
    const sem = createUnboundedSemaphore(1)
    await sem.acquire()
    const order: number[] = []
    const waiters = [1, 2, 3].map(async (n) => {
      await sem.acquire()
      order.push(n)
    })
    await tick()
    for (const _ of [1, 2, 3]) {
      sem.release()
      await tick()
    }
    await Promise.all(waiters)
    expect(order).toEqual([1, 2, 3])
  })
})
