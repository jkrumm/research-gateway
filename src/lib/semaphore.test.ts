import { describe, it, expect } from 'bun:test'
import { createSemaphore } from './semaphore.js'

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

describe('createSemaphore', () => {
  it('hands out up to the limit immediately and queues the rest', async () => {
    const sem = createSemaphore(2, 1000)
    expect(await sem.acquire()).toBe(true)
    expect(await sem.acquire()).toBe(true)
    expect(sem.active).toBe(2)

    const third = sem.acquire()
    await tick()
    expect(sem.queued).toBe(1)
    expect(sem.active).toBe(2)

    sem.release()
    expect(await third).toBe(true)
    expect(sem.active).toBe(2)
    expect(sem.queued).toBe(0)
  })

  it('never exceeds the limit — the property the concurrency cap rests on', async () => {
    const sem = createSemaphore(3, 1000)
    let peak = 0
    await Promise.all(
      Array.from({ length: 12 }, async () => {
        await sem.acquire()
        peak = Math.max(peak, sem.active)
        await tick(2)
        sem.release()
      }),
    )
    expect(peak).toBe(3)
    expect(sem.active).toBe(0)
  })

  it('times a queued waiter out and leaves no phantom slot behind', async () => {
    const sem = createSemaphore(1, 20)
    expect(await sem.acquire()).toBe(true)

    expect(await sem.acquire()).toBe(false) // timed out waiting
    expect(sem.queued).toBe(0) // spliced out, not left dangling

    // The holder releasing must not promote the waiter that already gave up: if it did,
    // `active` would climb without anyone holding a slot, and the caller would eventually
    // run more concurrent work than the limit allows.
    sem.release()
    expect(sem.active).toBe(0)
    expect(await sem.acquire()).toBe(true)
  })

  it('a release racing a timeout grants exactly one of them', async () => {
    const sem = createSemaphore(1, 15)
    await sem.acquire()
    const queued = sem.acquire()
    await tick(15) // let the timeout fire
    sem.release() // ...and release in the same neighbourhood
    expect(await queued).toBe(false)
    expect(sem.active).toBe(0)
  })

  it('serves waiters in arrival order', async () => {
    const sem = createSemaphore(1, 1000)
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
