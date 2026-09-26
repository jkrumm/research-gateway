import { describe, it, expect } from 'bun:test'
import { policyFor, DEFAULT_HOST_POLICY } from './host-policy.js'

describe('policyFor', () => {
  it('returns the default policy for an unlisted host', () => {
    expect(policyFor('example.com')).toEqual(DEFAULT_HOST_POLICY)
  })

  it('matches a table entry on the bare host', () => {
    const p = policyFor('ebay.com')
    expect(p.skip).toEqual(['origin', 'render'])
    expect(p.humanSolve).toBe(true)
    expect(p.minIntervalMs).toBe(DEFAULT_HOST_POLICY.minIntervalMs)
  })

  it('walks labels up to the last two, matching a subdomain', () => {
    expect(policyFor('www.ebay.de').skip).toEqual(['origin', 'render'])
    expect(policyFor('cgi.ebay.com').skip).toEqual(['origin', 'render'])
  })

  it('does not stop the walk short of the last two labels', () => {
    expect(policyFor('offers.mpb.com').skip).toEqual(['origin', 'render'])
  })

  it('does not false-positive on a host that merely contains a listed label', () => {
    expect(policyFor('notebay.com')).toEqual(DEFAULT_HOST_POLICY)
    expect(policyFor('ebay.com.evil.test')).toEqual(DEFAULT_HOST_POLICY)
  })

  it('idealo.de is not in the skip table (origin stays enabled for a future impersonating rung)', () => {
    expect(policyFor('idealo.de')).toEqual(DEFAULT_HOST_POLICY)
  })

  it('matches the newly added g2.com entry', () => {
    expect(policyFor('g2.com').skip).toEqual(['origin', 'render'])
  })

  it('is case-insensitive', () => {
    expect(policyFor('WWW.EBAY.COM').skip).toEqual(['origin', 'render'])
  })
})
