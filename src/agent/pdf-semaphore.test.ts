import { describe, it, expect } from 'bun:test'
import { pdfExtractionSemaphore } from './pdf-semaphore.js'

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

// `pdfExtractionSemaphore` is now a plain `lib/semaphore.ts` instance (no `queueTimeoutMs`,
// see this module's header) — the FIFO/never-exceeds-limit/abort-tied behaviour itself is
// exercised generically in semaphore.test.ts. This file only covers what is actually specific
// to THIS instance: its concurrency cap and the fact that a queued waiter never times out.
describe('pdfExtractionSemaphore', () => {
  it('caps concurrency at 2 and queues the rest without a timeout', async () => {
    expect(await pdfExtractionSemaphore.acquire()).toBe(true)
    expect(await pdfExtractionSemaphore.acquire()).toBe(true)
    expect(pdfExtractionSemaphore.active).toBe(2)

    let thirdResolved = false
    const third = pdfExtractionSemaphore.acquire().then(() => {
      thirdResolved = true
    })
    await tick(50) // well past any plausible queue-timeout value
    expect(pdfExtractionSemaphore.queued).toBe(1)
    expect(thirdResolved).toBe(false)

    pdfExtractionSemaphore.release()
    await third
    expect(thirdResolved).toBe(true)
    expect(pdfExtractionSemaphore.active).toBe(2)

    // Drain back to a clean slate for any other test in this process that shares the module-
    // level singleton.
    pdfExtractionSemaphore.release()
    pdfExtractionSemaphore.release()
    expect(pdfExtractionSemaphore.active).toBe(0)
  })

  it('ties a queued wait to a caller-supplied signal — pdf.ts threads the fetch chain budget through this', async () => {
    expect(await pdfExtractionSemaphore.acquire()).toBe(true)
    expect(await pdfExtractionSemaphore.acquire()).toBe(true)

    const controller = new AbortController()
    const queued = pdfExtractionSemaphore.acquire(controller.signal)
    await tick()
    expect(pdfExtractionSemaphore.queued).toBe(1)

    controller.abort()
    expect(await queued).toBe(false)
    expect(pdfExtractionSemaphore.queued).toBe(0)

    pdfExtractionSemaphore.release()
    pdfExtractionSemaphore.release()
    expect(pdfExtractionSemaphore.active).toBe(0)
  })
})
