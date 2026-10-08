import { describe, expect, it } from 'bun:test'
import { scrubBody } from './body-mentions.js'
import type { UnverifiedEntry } from './schema.js'

// The regex-boundary cases, exercised directly against `scrubBody` rather than through
// `groundReport`: this is where the matcher's boundary rules live, so the tests fail next to
// the code that implements them. The integration behaviour (banner order, degraded status,
// ledger vindication) stays in ground.test.ts.
const blocked = (url: string): ReadonlyArray<UnverifiedEntry> => [
  { topic: 'win rates', url, reason: 'rendered page empty' },
]

const flags = (body: string, url: string): boolean => scrubBody(body, blocked(url)).annotated > 0

const bodyCases: Array<{ body: string; want: boolean; why: string }> = [
  { body: 'See https://nunu.gg/patch-notes here.', want: true, why: 'the exact URL' },
  { body: 'See [the notes](https://nunu.gg/patch-notes).', want: true, why: 'a markdown link target' },
  // A bare host is NOT a reference to a specific page on it — see the negative case below.
  { body: 'Per nunu.gg the win rate rose.', want: false, why: 'a bare host (a different reference from a page on it)' },
  { body: 'See https://www.nunu.gg/patch-notes.', want: true, why: 'a www-prefixed URL' },
  { body: 'Per https://nunu.gg/patch-notes.', want: true, why: 'a sentence-final period' },
  { body: 'See https://nunu.gg/patch-notes/ here.', want: true, why: 'a trailing slash' },
  { body: 'See nunu.gg/patch-notes here.', want: true, why: 'a scheme-less host/path' },
  { body: 'See https://NUNU.GG/patch-notes here.', want: true, why: 'host case is insignificant' },
  { body: 'See nunu.gg/patch-notes,and other stuff.', want: true, why: 'a comma glued to the path' },
  { body: 'See nunu.gg/patch-notes;and more.', want: true, why: 'a semicolon glued to the path' },
  { body: 'See nunu.gg/patch-notes: the rate rose.', want: true, why: 'a colon glued to the path' },
  { body: '(see nunu.gg/patch-notes)more', want: true, why: 'a closing paren glued to the path' },
  { body: 'See nunu.gg/patch-notes(archived) here.', want: true, why: 'a glued parenthetical annotation' },
  { body: 'See **https://nunu.gg/patch-notes** here.', want: true, why: 'markdown bold around the URL' },
  { body: 'See _https://nunu.gg/patch-notes_ here.', want: true, why: 'markdown italics around the URL' },
  { body: 'See https://nunu.gg/patch-notes[1] here.', want: true, why: 'a footnote ref glued to the URL' },
  { body: 'See https://nunu.gg/ here.', want: false, why: 'a bare host with a trailing slash' },
  { body: 'See www.nunu.gg/patch-notes here.', want: true, why: 'scheme-less with a www. prefix' },
  { body: 'See NUNU.gg/patch-notes here.', want: true, why: 'scheme-less, mixed-case host' },
  {
    body: 'See https://nunu.gg/patch-notes-archive-2026 for the archive.',
    want: false,
    why: 'a longer path sharing the blocked URL as a prefix',
  },
  { body: 'See https://sub.nunu.gg/patch-notes here.', want: false, why: 'a subdomain' },
  { body: 'See https://notnunu.gg/patch-notes here.', want: false, why: 'a host ending in the blocked one' },
  { body: 'See https://nunu.gg/Patch-Notes here.', want: false, why: 'path case IS significant (HTTP)' },
  { body: 'See nunu.gg/Patch-Notes here.', want: false, why: 'path case, scheme-less' },
  { body: 'See https://nunu.gg/other-page here.', want: false, why: 'a different page on the same host' },
  { body: 'Contact nunu.gg@example.com for help.', want: false, why: 'an email address' },
  { body: 'See nunu.gg:8443/other-page here.', want: false, why: 'the host with a port and another path' },
  {
    body: 'See https://nunu.gg/patch-notes?ref=abc here.',
    want: false,
    why: 'a query string — a different document',
  },
  {
    body: 'See https://nunu.gg/patch-notes#section2 here.',
    want: false,
    why: 'a fragment — a different document',
  },
  { body: 'See https://nunu.gg?ref=abc here.', want: false, why: 'a query on the bare host' },
  { body: 'See https://nunu.gg/patch-notes.2026 here.', want: false, why: 'a longer filename (dot + digit)' },
  { body: 'See https://nunu.gg/patch-notes.html here.', want: false, why: 'a longer filename (dot + letter)' },
  { body: 'See WWW.nunu.gg/patch-notes here.', want: true, why: 'an uppercase WWW. prefix' },
  { body: 'See HTTPS://nunu.gg/patch-notes here.', want: true, why: 'an uppercase scheme (RFC 3986)' },
  { body: 'See Http://nunu.gg/patch-notes here.', want: true, why: 'a mixed-case scheme' },
]

// Review finding: the RIGHT boundary allowed characters that are valid, unencoded URL
// path/query continuations (`_` `~` `!` `*` `'`), so a blocked `.../api` matched inside the
// DISTINCT `.../api_v2` — a false inline-distrust note on a page that was never named.
const boundaryCases: Array<{ body: string; want: boolean; why: string }> = [
  { body: 'See https://example.com/api_v2 for the new version.', want: false, why: 'an underscore continuing the path' },
  { body: 'See https://example.com/api~x here.', want: false, why: 'a tilde continuing the path' },
  { body: 'See https://example.com/api:8080x here.', want: false, why: 'a colon-digit continuing the host as a bogus port' },
  { body: 'see https://example.com/api.', want: true, why: 'a sentence-final period still matches' },
  { body: '(https://example.com/api)', want: true, why: 'a closing paren still matches' },
  { body: '<https://example.com/api>', want: true, why: 'an autolink angle bracket still matches' },
]

describe('scrubBody — RIGHT boundary vs. real URL-continuation characters', () => {
  for (const { body, want, why } of boundaryCases) {
    it(`${want ? 'flags' : 'leaves alone'}: ${why}`, () => {
      expect(flags(body, 'https://example.com/api')).toBe(want)
    })
  }
})

describe('scrubBody — regex boundaries', () => {
  for (const { body, want, why } of bodyCases) {
    it(`${want ? 'flags' : 'leaves alone'}: ${why}`, () => {
      expect(flags(body, 'https://nunu.gg/patch-notes')).toBe(want)
    })
  }

  // Review finding: `urlParts` strips a URL's trailing slash, so `host/?ref=1` arrives as
  // `?ref=1` and `host/a/?q` as `/a?q` — the slash prose writes before the query was never
  // matched, a false negative for any blocked URL whose path is `/` with a query.
  it('matches a path of "/" carrying a query', () => {
    const body = 'See https://nunu.gg/?ref=1 here.'
    expect(flags(body, 'https://nunu.gg/?ref=1')).toBe(true)
    // The slash is optional prose, not part of the document; without it is the same page too.
    expect(flags('See https://nunu.gg?ref=1 here.', 'https://nunu.gg/?ref=1')).toBe(true)
  })

  it('matches a non-root path carrying a query written with its trailing slash', () => {
    expect(flags('See https://nunu.gg/a/?q=1 here.', 'https://nunu.gg/a/?q=1')).toBe(true)
    expect(flags('See https://nunu.gg/a?q=1 here.', 'https://nunu.gg/a/?q=1')).toBe(true)
  })

  // Review finding: normalization was asymmetric — the body went through NFC + strip-Cf, the
  // blocked URL's path/query/fragment did not, so a canonically-equivalent or zero-width-laden
  // spelling in the ledger built a pattern the normalized body could never satisfy.
  it('matches a composed body against a blocked URL recorded in decomposed Unicode', () => {
    // `café` composed, blocked recorded as `cafe` + U+0301.
    expect(flags('See https://nunu.gg/café here.', 'https://nunu.gg/cafe\u0301')).toBe(true)
  })

  it('sees through a zero-width format character in a blocked URL path', () => {
    // A U+200B zero-width space inside the blocked path renders identically to no character.
    expect(flags('See https://nunu.gg/path here.', 'https://nunu.gg/pa\u200bth')).toBe(true)
  })

  // Review finding: `dedupKey` built its key from the raw `host`/`rest`/`hash`, not the
  // NFC + strip-Cf normalized form `referencesBody` matches against \u2014 so two `unverified`
  // entries for the same page that differ only by an invisible format character or a
  // decomposed accent produced two dedup keys, and thus two "Unverified in prose" notes for
  // what a reader sees as one identical URL.
  it('dedups two unverified entries for the same page spelled with an invisible character and its composed form', () => {
    const entries: ReadonlyArray<UnverifiedEntry> = [
      { topic: 'a', url: 'https://nunu.gg/pa\u200bth', reason: 'rendered page empty' },
      { topic: 'b', url: 'https://nunu.gg/path', reason: 'rate limited' },
    ]
    const { annotated } = scrubBody('See https://nunu.gg/path here.', entries)
    expect(annotated).toBe(1)
  })

  it('dedups two unverified entries for the same page spelled in composed vs. decomposed Unicode', () => {
    const entries: ReadonlyArray<UnverifiedEntry> = [
      { topic: 'a', url: 'https://nunu.gg/cafe\u0301', reason: 'rendered page empty' },
      { topic: 'b', url: 'https://nunu.gg/caf\u00e9', reason: 'rate limited' },
    ]
    const { annotated } = scrubBody('See https://nunu.gg/caf\u00e9 here.', entries)
    expect(annotated).toBe(1)
  })
})

// Wave 3: a scrub note counts as evidence lost, so it must fire on an ASSERTION resting on an
// unverified source — not on a homepage named in passing or a sentence that already says the
// source could not be read (22 of 35 partials in the 2026-10-08 audit were these alone).
describe('scrubBody — mentions that are not claims', () => {
  const home = 'https://www.bike24.de/'
  const cases: Array<{ body: string; want: boolean; why: string }> = [
    { body: 'Per bike24.de the Tarmac costs 1,299 EUR.', want: true, why: 'issue #7: a figure resting on the unverified host' },
    { body: 'According to https://www.bike24.de/ the frame is in stock.', want: true, why: 'an attribution to the unverified homepage' },
    { body: 'Retailers checked: https://www.bike24.de/.', want: false, why: 'a bare homepage with no claim' },
    { body: 'Sources consulted\n- https://www.bike24.de/\n- https://example.org/', want: false, why: 'a bare homepage in a list' },
    { body: 'https://www.bike24.de/ could not be read, so its stock is unknown.', want: false, why: 'the sentence already says it could not be read' },
    { body: 'Prices on bike24.de were unverified. Per bike24.de the frame costs 1,299 EUR.', want: true, why: 'a later asserting sentence is still flagged' },
  ]
  for (const { body, want, why } of cases) {
    it(`${want ? 'flags' : 'leaves alone'}: ${why}`, () => {
      expect(flags(body, home)).toBe(want)
    })
  }

  it('a path-bearing source named with "could not be verified" is exempt', () => {
    expect(flags('The page https://nunu.gg/patch-notes could not be verified.', 'https://nunu.gg/patch-notes')).toBe(false)
  })

  it('a path-bearing source named without a claim is still flagged', () => {
    expect(flags('See https://nunu.gg/patch-notes here.', 'https://nunu.gg/patch-notes')).toBe(true)
  })
})
