import { describe, it, expect } from 'bun:test'
import { createImpersonationMemory } from './impersonate-memory.js'

// Only the pure per-host learning state is tested here — `impersonatedFetch` itself touches a
// native binding and the network, same category as ytdlp.ts/pdf.ts/human-solve.ts (untested by
// convention; exercised live, not in `bun test`).
//
// Each test builds its OWN `createImpersonationMemory` instance with a fake clock — no shared
// module-level state to leak between test cases, unlike the standalone functions this replaced.
function fakeClock(start = 0) {
  let t = start
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

describe('impersonation learning state', () => {
  it('is not preferred for a host that was never learned', () => {
    const memory = createImpersonationMemory()
    expect(memory.prefers('never-seen.example')).toBe(false)
  })

  it('is preferred once a host is learned, within the TTL', () => {
    const clock = fakeClock()
    const memory = createImpersonationMemory({ now: clock.now })
    const host = 'idealo.de'
    memory.noteWorks(host)

    expect(memory.prefers(host)).toBe(true)
    clock.advance(60_000)
    expect(memory.prefers(host)).toBe(true)
  })

  it('expires after the 24h TTL', () => {
    const clock = fakeClock()
    const memory = createImpersonationMemory({ now: clock.now })
    const host = 'idealo.de'
    memory.noteWorks(host)

    clock.advance(24 * 60 * 60_000 - 1)
    expect(memory.prefers(host)).toBe(true)
    clock.advance(2)
    expect(memory.prefers(host)).toBe(false)
  })

  it('is not preferred if the clock steps backward after a host was learned (negative age)', () => {
    const clock = fakeClock(10_000)
    const memory = createImpersonationMemory({ now: clock.now })
    const host = 'idealo.de'
    memory.noteWorks(host) // learnedAt = 10_000
    clock.advance(-20_000) // clock rewinds to -10_000 — age would read as -20_000
    expect(memory.prefers(host)).toBe(false)
  })

  it('drops the learned preference on noteFailed', () => {
    const memory = createImpersonationMemory()
    const host = 'idealo.de'
    memory.noteWorks(host)
    expect(memory.prefers(host)).toBe(true)

    memory.noteFailed(host)
    expect(memory.prefers(host)).toBe(false)
  })

  it('evicts the oldest-learned host once the 1000-host cap is reached', () => {
    const clock = fakeClock()
    const memory = createImpersonationMemory({ now: clock.now })
    for (let i = 0; i < 1000; i++) {
      memory.noteWorks(`host-${i}.example`)
      clock.advance(1)
    }
    // host-0 was the oldest-learned entry and should have been evicted to make room.
    memory.noteWorks('host-1000.example')
    expect(memory.prefers('host-0.example')).toBe(false)
    expect(memory.prefers('host-1000.example')).toBe(true)
    expect(memory.prefers('host-999.example')).toBe(true)
  })

  it('does not leak state between two independent memory instances', () => {
    const a = createImpersonationMemory()
    const b = createImpersonationMemory()
    a.noteWorks('shared-host.example')
    expect(a.prefers('shared-host.example')).toBe(true)
    expect(b.prefers('shared-host.example')).toBe(false)
  })
})
