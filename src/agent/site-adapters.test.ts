import { describe, it, expect } from 'bun:test'
import { parseHTML } from 'linkedom'
import { resolveSite } from './site-adapters.js'
import { normalizeUrl } from './ledger.js'

const doc = (html: string) => parseHTML(`<html><body>${html}</body></html>`).document as never

describe('resolveSite', () => {
  it('sends modern Reddit to old.reddit.com and attaches the comment-tree reader', () => {
    for (const host of ['www.reddit.com', 'reddit.com']) {
      const site = resolveSite(`https://${host}/r/bun/comments/abc/title/`)
      expect(site.fetchUrl).toBe('https://old.reddit.com/r/bun/comments/abc/title/')
      expect(site.extract).not.toBeNull()
    }
  })

  it('attaches the reader without rewriting when old.reddit is cited directly', () => {
    const url = 'https://old.reddit.com/r/bun/comments/abc/title/'
    const site = resolveSite(url)
    expect(site.fetchUrl).toBe(url)
    expect(site.extract).not.toBeNull()
  })

  it('preserves path, query and fragment through a rewrite', () => {
    expect(resolveSite('https://www.reddit.com/r/x/?sort=top#c1').fetchUrl).toBe(
      'https://old.reddit.com/r/x/?sort=top#c1',
    )
  })

  it('matches the host case-insensitively', () => {
    expect(resolveSite('https://WWW.Reddit.COM/r/x').fetchUrl).toBe('https://old.reddit.com/r/x')
  })

  it('leaves unknown hosts entirely alone — no rewrite, no adapter', () => {
    for (const url of [
      'https://github.com/oven-sh/bun/issues/1',
      'https://bun.com/docs/api/http',
      'https://notreddit.com/r/x',
      'https://redditmedia.com/x',
    ]) {
      const site = resolveSite(url)
      expect(site.fetchUrl).toBe(url)
      expect(site.extract).toBeNull()
    }
  })

  it('returns unparseable input unchanged rather than throwing', () => {
    expect(resolveSite('not a url')).toEqual({ fetchUrl: 'not a url', extract: null })
  })

  it('keys the adapter on the ORIGINAL host, not on whether a rewrite happened', () => {
    // The bug this design replaces: an earlier version ran the Reddit extractor whenever
    // `fetchUrl !== url`, so the moment a second rewrite entry existed it would have pointed
    // Reddit's parser at another site's markup. A rewritten non-Reddit host must not pick up
    // Reddit's reader, and an unrewritten host must not pick up any reader.
    expect(resolveSite('https://example.com/a').extract).toBeNull()
  })

  it('the attached reader actually reads a Reddit thread', () => {
    const site = resolveSite('https://www.reddit.com/r/bun/comments/abc/t/')
    const out = site.extract!(
      doc(`<a class="title">Bun memory</a>
           <div class="entry"><span class="score unvoted">240 points</span>
             <div class="usertext-body"><div class="md"><p>RSS climbed past 900 MiB.</p></div></div>
           </div>`),
    )
    expect(out).toContain('[240 points] RSS climbed past 900 MiB.')
  })

  it('the rewritten URL is a DIFFERENT ledger key, which is why callers must record the original', () => {
    // normalizeUrl strips `www.`, not arbitrary subdomains. Recording the rewritten host
    // would leave every honest Reddit citation ungrounded.
    const original = 'https://www.reddit.com/r/bun/comments/abc/title/'
    expect(normalizeUrl(resolveSite(original).fetchUrl)).not.toBe(normalizeUrl(original))
  })
})
