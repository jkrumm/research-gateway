import { describe, it, expect } from 'bun:test'
import { commitRead, createPageBudget, describeAttempts, isProxyUrl } from './fetch-guard.js'
import { createLedger } from './ledger.js'

describe('createPageBudget', () => {
  it('passes pages through whole until the budget runs out, then cuts with a note', () => {
    const budget = createPageBudget(10_000) // 22,000 chars
    expect(budget.take('a'.repeat(15_000))).toHaveLength(15_000)
    const cut = budget.take('b'.repeat(15_000))
    expect(cut?.startsWith('b'.repeat(7_000))).toBe(true)
    expect(cut).toContain('cut at 7000 of 15000 characters')
    expect(budget.hasRoom()).toBe(false)
  })

  it('withholds a page entirely once the budget is spent — parallel fetches pass hasRoom first', () => {
    const budget = createPageBudget(10_000)
    expect(budget.hasRoom()).toBe(true)
    budget.take('a'.repeat(30_000))
    expect(budget.take('late page')).toBeNull()
  })

  it('charges CJK text at its token weight, not its character count', () => {
    const budget = createPageBudget(10_000) // 22,000 units; a CJK char costs 4
    const page = '龙'.repeat(8_000) // 32,000 units
    const cut = budget.take(page)
    expect(cut).toContain('cut at 5500 of 8000 characters')
  })

  it('reports no room once less than a useful page is left', () => {
    const budget = createPageBudget(1_000) // 2,200 chars
    expect(budget.hasRoom()).toBe(true)
    budget.take('x'.repeat(500))
    expect(budget.hasRoom()).toBe(false)
  })
})

describe('describeAttempts', () => {
  it('names every failed step, not just the last one', () => {
    expect(
      describeAttempts(
        [
          { step: 'readability', ok: false, error: 'HTTP 403', ms: 10 },
          { step: 'lightpanda', ok: false, error: 'HTTP 403', ms: 900 },
          { step: 'tavily-extract', ok: false, error: 'Failed to fetch url', ms: 2000 },
        ],
        'Failed to fetch url',
      ),
    ).toBe('readability: HTTP 403 · lightpanda: HTTP 403 · tavily-extract: Failed to fetch url')
  })

  it('falls back when no step recorded an error', () => {
    expect(describeAttempts([], 'refused')).toBe('refused')
  })
})

describe('isProxyUrl', () => {
  it('flags reader and CORS proxies, including a wrapped target', () => {
    expect(isProxyUrl('https://r.jina.ai/https://wrchina.gg/c/rammus/')).toBe(true)
    expect(isProxyUrl('https://api.allorigins.win/raw?url=https://wrbase.com')).toBe(true)
    expect(isProxyUrl('https://corsproxy.io/?https://wrchina.gg')).toBe(true)
  })

  it('leaves real sites alone', () => {
    expect(isProxyUrl('https://wrchina.gg/c/rammus/')).toBe(false)
    expect(isProxyUrl('https://jina.ai/news')).toBe(false)
    expect(isProxyUrl('not a url')).toBe(false)
  })
})

describe('commitRead', () => {
  const stagedWith = () => {
    const staged = createLedger()
    staged.recordRetrieved('https://wrchina.gg/c/rammus/')
    staged.recordFailed('https://riftgg.app/api/x', 'readability: HTTP 403')
    staged.recordMissing('https://wrbase.com/gone', 'HTTP 404')
    return staged.snapshot()
  }

  it('commits the page as retrieved when the model received its text', () => {
    const ledger = createLedger()
    commitRead({ staged: stagedWith(), into: ledger, delivered: true })
    expect(ledger.tierOf('https://wrchina.gg/c/rammus/')).toBe('retrieved')
  })

  it('never commits a withheld page as retrieved, but keeps failures and 404s', () => {
    const ledger = createLedger()
    commitRead({ staged: stagedWith(), into: ledger, delivered: false })
    expect(ledger.tierOf('https://wrchina.gg/c/rammus/')).toBe('unseen')
    expect(ledger.tierOf('https://riftgg.app/api/x')).toBe('failed')
    expect(ledger.tierOf('https://wrbase.com/gone')).toBe('missing')
  })
})

