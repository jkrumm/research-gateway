import { describe, it, expect } from 'bun:test'
import { createIdleWatchdog } from './idle-watchdog.js'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('createIdleWatchdog', () => {
  it('does not abort while armed on a steady cadence well inside the idle budget', async () => {
    const watchdog = createIdleWatchdog(200)
    watchdog.arm()
    for (let i = 0; i < 5; i++) {
      await sleep(30)
      watchdog.arm()
    }
    expect(watchdog.signal.aborted).toBe(false)
    watchdog.clear()
  })

  it('aborts once no activity arrives within the idle budget', async () => {
    const watchdog = createIdleWatchdog(30)
    watchdog.arm()
    await sleep(80)
    expect(watchdog.signal.aborted).toBe(true)
    expect(String(watchdog.signal.reason)).toContain('idle')
    watchdog.clear()
  })

  it('never fires if arm() was never called', async () => {
    const watchdog = createIdleWatchdog(20)
    await sleep(60)
    expect(watchdog.signal.aborted).toBe(false)
    watchdog.clear()
  })

  it('clear() prevents a pending abort from firing', async () => {
    const watchdog = createIdleWatchdog(20)
    watchdog.arm()
    watchdog.clear()
    await sleep(60)
    expect(watchdog.signal.aborted).toBe(false)
  })
})
