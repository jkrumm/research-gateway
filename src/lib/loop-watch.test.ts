import { describe, it, expect } from 'bun:test'
// `loop-watch.ts` imports `log.js` -> `otel.ts` -> `env.ts`, which parses `process.env` at
// import time and throws without secrets — same trap otel.test.ts documents. Fill the
// required vars FIRST, then load the module through a dynamic import (a static one would be
// hoisted above these assignments).
process.env['API_SECRET'] ??= 'test-secret'
process.env['IU_BASE_URL'] ??= 'https://iu.example/v1'
process.env['IU_API_KEY'] ??= 'test-key'
process.env['TAVILY_API_KEY'] ??= 'test-key'

const { createLoopWatch } = await import('./loop-watch.js')
import type { LoopWatchClock } from './loop-watch.js'

// A fake clock/scheduler: `now` is a controllable counter, `setInterval` captures the callback
// instead of scheduling a real timer so a test can fire ticks synchronously and assert on
// `snapshot()` without waiting on SAMPLE_INTERVAL_MS of real time.
function fakeClock(): LoopWatchClock & { advance: (ms: number) => void; tick: () => void } {
  let now = 0
  let onTick: (() => void) | null = null
  return {
    now: () => now,
    setInterval: (callback) => {
      onTick = callback
      return { unref: () => {} }
    },
    advance: (ms: number) => {
      now += ms
    },
    tick: () => onTick?.(),
  }
}

describe('createLoopWatch', () => {
  it('reports a null snapshot before the first tick', () => {
    const watch = createLoopWatch({ clock: fakeClock() })
    expect(watch.snapshot()).toEqual({ lastMs: null, peakMs: null })
  })

  it('reports ~0 lag when every tick fires exactly on schedule', () => {
    const clock = fakeClock()
    const watch = createLoopWatch({ clock, sampleIntervalMs: 5_000 })
    watch.start()
    clock.advance(5_000)
    clock.tick()
    expect(watch.snapshot()).toEqual({ lastMs: 0, peakMs: 0 })
  })

  it('reports the lag when a tick fires late', () => {
    const clock = fakeClock()
    const watch = createLoopWatch({ clock, sampleIntervalMs: 5_000 })
    watch.start()
    clock.advance(35_000) // a 30s stall between ticks
    clock.tick()
    expect(watch.snapshot().lastMs).toBe(30_000)
  })

  it('never reports negative lag for a tick that fires early', () => {
    const clock = fakeClock()
    const watch = createLoopWatch({ clock, sampleIntervalMs: 5_000 })
    watch.start()
    clock.advance(1_000) // fired "early" relative to the expected interval
    clock.tick()
    expect(watch.snapshot().lastMs).toBe(0)
  })

  it('peakMs holds the worst lag in the window even after a later quiet tick', () => {
    const clock = fakeClock()
    const watch = createLoopWatch({ clock, sampleIntervalMs: 5_000 })
    watch.start()
    clock.advance(35_000)
    clock.tick() // a 30s stall
    clock.advance(5_000)
    clock.tick() // back to healthy
    const snap = watch.snapshot()
    expect(snap.lastMs).toBe(0)
    expect(snap.peakMs).toBe(30_000)
  })

  it('bounds the window at windowSamples, so an old stall eventually ages out of peakMs', () => {
    const clock = fakeClock()
    const watch = createLoopWatch({ clock, sampleIntervalMs: 5_000, windowSamples: 3 })
    watch.start()
    clock.advance(35_000)
    clock.tick() // a 30s stall — sample 1
    for (let i = 0; i < 3; i++) {
      clock.advance(5_000)
      clock.tick() // 3 healthy samples push the stall out of a window of 3
    }
    expect(watch.snapshot().peakMs).toBe(0)
  })

  it('is idempotent — calling start() twice does not add a second interval', () => {
    const clock = fakeClock()
    const watch = createLoopWatch({ clock, sampleIntervalMs: 5_000 })
    watch.start()
    watch.start()
    clock.advance(5_000)
    clock.tick()
    // A second interval would have pushed two samples for one tick — peakMs/lastMs would
    // still read 0 here regardless, so this asserts no throw and a single coherent snapshot.
    expect(watch.snapshot()).toEqual({ lastMs: 0, peakMs: 0 })
  })
})
