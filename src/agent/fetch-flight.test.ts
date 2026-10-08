import { describe, expect, test } from 'bun:test'
import { createFlightRegistry, isTerminalOutcome, missingHint, type FetchOutcome } from './fetch-flight.js'
import type { LedgerSnapshot } from './ledger.js'

const emptyStaged = (over: Partial<LedgerSnapshot> = {}): LedgerSnapshot => ({
  retrieved: [],
  missing: [],
  snippet: [],
  failed: [],
  ...over,
})

const page = (text = 'body'): FetchOutcome => ({
  text,
  error: null,
  staged: emptyStaged({ retrieved: ['https://a.example/x'] }),
  terminal: true,
})
const transient: FetchOutcome = {
  text: null,
  error: 'HTTP 503',
  staged: emptyStaged({ failed: [{ url: 'https://a.example/x', reason: 'HTTP 503' }] }),
  terminal: false,
}

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

describe('createFlightRegistry', () => {
  test('concurrent callers share one run', async () => {
    const reg = createFlightRegistry()
    const gate = deferred<FetchOutcome>()
    let runs = 0
    const exec = () => {
      runs++
      return gate.promise
    }
    const a = reg.run('j', 'https://a.example/x', exec)
    const b = reg.run('j', 'https://www.a.example/x/#frag', exec)
    gate.resolve(page())
    const [ra, rb] = await Promise.all([a, b])
    expect(runs).toBe(1)
    expect([ra.source, rb.source]).toEqual(['ran', 'joined'])
    expect(rb.outcome.text).toBe('body')
  })

  test('a settled terminal outcome is replayed', async () => {
    const reg = createFlightRegistry()
    let runs = 0
    const exec = async () => (runs++, page())
    await reg.run('j', 'https://a.example/x', exec)
    const again = await reg.run('j', 'https://a.example/x', exec)
    expect(runs).toBe(1)
    expect(again.source).toBe('replayed')
  })

  test('a transient failure is not remembered', async () => {
    const reg = createFlightRegistry()
    let runs = 0
    const exec = async () => (runs++, transient)
    await reg.run('j', 'https://a.example/x', exec)
    await reg.run('j', 'https://a.example/x', exec)
    expect(runs).toBe(2)
  })

  test('a thrown exec is not remembered and rethrows', async () => {
    const reg = createFlightRegistry()
    await expect(reg.run('j', 'https://a.example/x', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    const ok = await reg.run('j', 'https://a.example/x', async () => page())
    expect(ok.source).toBe('ran')
  })

  test('jobs are isolated and clear() forgets', async () => {
    const reg = createFlightRegistry()
    let runs = 0
    const exec = async () => (runs++, page())
    await reg.run('j1', 'https://a.example/x', exec)
    await reg.run('j2', 'https://a.example/x', exec)
    expect(runs).toBe(2)
    reg.clear('j1')
    await reg.run('j1', 'https://a.example/x', exec)
    expect(runs).toBe(3)
  })
})

describe('isTerminalOutcome', () => {
  test('page, block and 404 are terminal; a plain failure is not', () => {
    expect(isTerminalOutcome({ text: 'x', staged: emptyStaged(), blocked: false })).toBe(true)
    expect(isTerminalOutcome({ text: null, staged: emptyStaged(), blocked: true })).toBe(true)
    expect(isTerminalOutcome({ text: null, staged: emptyStaged({ missing: [{ url: 'u', reason: 'HTTP 404' }] }), blocked: false })).toBe(true)
    expect(isTerminalOutcome({ text: null, staged: emptyStaged(), blocked: false })).toBe(false)
  })
})

describe('missingHint', () => {
  test('names the host and tells the worker to search', () => {
    const hint = missingHint('https://www.bike24.de/p/xyz', {
      text: null,
      staged: emptyStaged({ missing: [{ url: 'u', reason: 'HTTP 404' }] }),
    })
    expect(hint).toContain('on bike24.de')
    expect(hint).toContain('searchWeb')
  })
  test('null for a retrieved page or a plain failure', () => {
    expect(missingHint('https://a.example', { text: 'x', staged: emptyStaged() })).toBeNull()
    expect(missingHint('https://a.example', { text: null, staged: emptyStaged() })).toBeNull()
  })
})
