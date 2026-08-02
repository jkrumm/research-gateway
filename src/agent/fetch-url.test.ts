import { describe, it, expect } from 'bun:test'
import { rewriteFetchUrl } from './fetch-url.js'
import { normalizeUrl } from './ledger.js'

describe('rewriteFetchUrl', () => {
  it('sends modern Reddit to old.reddit.com, which serves real HTML instead of a JS shell', () => {
    expect(rewriteFetchUrl('https://www.reddit.com/r/bun/comments/abc/title/')).toBe(
      'https://old.reddit.com/r/bun/comments/abc/title/',
    )
    expect(rewriteFetchUrl('https://reddit.com/r/bun/comments/abc/title/')).toBe(
      'https://old.reddit.com/r/bun/comments/abc/title/',
    )
  })

  it('preserves path, query and fragment', () => {
    expect(rewriteFetchUrl('https://www.reddit.com/r/x/?sort=top#c1')).toBe(
      'https://old.reddit.com/r/x/?sort=top#c1',
    )
  })

  it('is case-insensitive on the host', () => {
    expect(rewriteFetchUrl('https://WWW.Reddit.COM/r/x')).toBe('https://old.reddit.com/r/x')
  })

  it('leaves already-old Reddit alone (no double rewrite)', () => {
    const url = 'https://old.reddit.com/r/x'
    expect(rewriteFetchUrl(url)).toBe(url)
  })

  it('leaves every other host untouched', () => {
    for (const url of [
      'https://github.com/oven-sh/bun/issues/1',
      'https://bun.com/docs/api/http',
      'https://redditmedia.com/x',
      'https://notreddit.com/r/x',
    ]) {
      expect(rewriteFetchUrl(url)).toBe(url)
    }
  })

  it('returns unparseable input unchanged rather than throwing — the SSRF guard rejects it downstream', () => {
    expect(rewriteFetchUrl('not a url')).toBe('not a url')
    expect(rewriteFetchUrl('')).toBe('')
  })

  it('does NOT normalize to the same ledger key as the original — which is why the caller must record the original', () => {
    // This is the trap the rewrite has to avoid. `normalizeUrl` strips `www.`, not arbitrary
    // subdomains, so the rewritten host is a DIFFERENT ledger key. If fetchPage recorded the
    // rewritten URL, every citation naming the URL the model was actually given would fail
    // grounding and be dropped.
    const original = 'https://www.reddit.com/r/bun/comments/abc/title/'
    expect(normalizeUrl(rewriteFetchUrl(original))).not.toBe(normalizeUrl(original))
  })
})
