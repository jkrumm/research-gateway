import { describe, it, expect } from 'bun:test'
// Imported directly from the pure modules (no `env.js` chain) — same convention as
// run.test.ts. See the note at the top of assemble.ts.
import { createLedger, mergeLedgers, normalizeUrl } from './ledger.js'
import { groundClaims, groundDigest, groundReport } from './ground.js'
import type { SubmittedReport, WorkerDigest } from './schema.js'

function digest(overrides: Partial<WorkerDigest> = {}): WorkerDigest {
  return {
    subQuestion: 'What is X?',
    summary: 'X is Y.',
    findings: [],
    sourcesRead: [],
    openGaps: [],
    blockedSources: [],
    ...overrides,
  }
}

function submitted(overrides: Partial<SubmittedReport> = {}): SubmittedReport {
  return {
    report: 'A report long enough to be plausible.',
    citations: [],
    sources: [],
    unverified: [],
    ...overrides,
  }
}

describe('normalizeUrl', () => {
  it('treats fragment, trailing slash, www and scheme differences as the same page', () => {
    const canonical = normalizeUrl('https://immich.app/docs/install/docker-compose')
    expect(normalizeUrl('https://immich.app/docs/install/docker-compose/')).toBe(canonical)
    expect(normalizeUrl('https://immich.app/docs/install/docker-compose#step-1')).toBe(canonical)
    expect(normalizeUrl('https://www.immich.app/docs/install/docker-compose')).toBe(canonical)
    expect(normalizeUrl('http://immich.app/docs/install/docker-compose')).toBe(canonical)
  })

  it('keeps the query string — ?v=2 is a different document', () => {
    expect(normalizeUrl('https://a.example/doc?v=2')).not.toBe(normalizeUrl('https://a.example/doc'))
  })

  it('does not throw on a non-URL string', () => {
    expect(normalizeUrl('not a url')).toBe('not a url')
  })
})

describe('ledger tier precedence', () => {
  it('retrieved outranks a prior failed attempt (readability fails, Tavily Extract succeeds)', () => {
    const ledger = createLedger()
    ledger.recordFailed('https://a.example', 'timeout')
    ledger.recordRetrieved('https://a.example')
    expect(ledger.tierOf('https://a.example')).toBe('retrieved')
  })

  it('a failed fetch outranks a search snippet of the same URL', () => {
    const ledger = createLedger()
    ledger.recordSnippet('https://a.example')
    ledger.recordFailed('https://a.example', 'rate limited')
    expect(ledger.tierOf('https://a.example')).toBe('failed')
  })

  it('an unrecorded URL is unseen', () => {
    expect(createLedger().tierOf('https://nowhere.example')).toBe('unseen')
  })

  it('merging worker ledgers keeps a page citable if ANY worker read it', () => {
    const a = createLedger()
    a.recordFailed('https://shared.example', 'rate limited')
    const b = createLedger()
    b.recordRetrieved('https://shared.example')
    expect(mergeLedgers([a.snapshot(), b.snapshot()]).tierOf('https://shared.example')).toBe('retrieved')
  })
})

describe('groundClaims', () => {
  it('keeps a claim citing a retrieved page at its asserted confidence', () => {
    const ledger = createLedger()
    ledger.recordRetrieved('https://a.example')
    const { kept, dropped } = groundClaims(
      [{ claim: 'A', url: 'https://a.example', confidence: 'high' }],
      ledger,
    )
    expect(kept).toEqual([{ claim: 'A', url: 'https://a.example', confidence: 'high' }])
    expect(dropped).toEqual([])
  })

  it('caps a snippet-backed claim at medium, however high the model asserted', () => {
    const ledger = createLedger()
    ledger.recordSnippet('https://a.example')
    const { kept, cappedCount } = groundClaims(
      [{ claim: 'A', url: 'https://a.example', confidence: 'high' }],
      ledger,
    )
    expect(kept[0]?.confidence).toBe('medium')
    expect(cappedCount).toBe(1)
  })

  it('does not UPGRADE a low-confidence claim about a fully retrieved page', () => {
    const ledger = createLedger()
    ledger.recordRetrieved('https://a.example')
    const { kept, cappedCount } = groundClaims(
      [{ claim: 'A', url: 'https://a.example', confidence: 'low' }],
      ledger,
    )
    expect(kept[0]?.confidence).toBe('low')
    expect(cappedCount).toBe(0)
  })

  it('drops a claim whose fetch failed, carrying the failure reason into the drop note', () => {
    const ledger = createLedger()
    ledger.recordFailed('https://a.example', 'Request exceeded pay-as-you-go limit')
    const { kept, dropped } = groundClaims(
      [{ claim: 'A', url: 'https://a.example', confidence: 'high' }],
      ledger,
    )
    expect(kept).toEqual([])
    expect(dropped[0]?.url).toBe('https://a.example')
    expect(dropped[0]?.reason).toContain('Request exceeded pay-as-you-go limit')
  })

  it('drops a claim citing a URL no tool ever returned', () => {
    const { kept, dropped } = groundClaims(
      [{ claim: 'invented', url: 'https://never-seen.example', confidence: 'high' }],
      createLedger(),
    )
    expect(kept).toEqual([])
    expect(dropped).toHaveLength(1)
  })

  it('drops a claim whose URL the run itself listed as unverifiable, even if retrieved', () => {
    const ledger = createLedger()
    ledger.recordRetrieved('https://a.example')
    const { kept } = groundClaims(
      [{ claim: 'A', url: 'https://a.example', confidence: 'high' }],
      ledger,
      new Set(['https://a.example']),
    )
    expect(kept).toEqual([])
  })
})

describe('groundDigest — the worker boundary', () => {
  it('strips ungrounded findings before they can reach the synthesis prompt', () => {
    const ledger = createLedger()
    ledger.recordRetrieved('https://real.example')
    ledger.recordFailed('https://blocked.example', 'rate limited')

    const grounded = groundDigest(
      digest({
        findings: [
          { claim: 'real', url: 'https://real.example', confidence: 'high' },
          { claim: 'from priors', url: 'https://blocked.example', confidence: 'high' },
        ],
      }),
      ledger,
    )

    expect(grounded.findings).toEqual([{ claim: 'real', url: 'https://real.example', confidence: 'high' }])
    expect(grounded.blockedSources.some((b) => b.url === 'https://blocked.example')).toBe(true)
  })

  it('replaces the model-asserted sourcesRead with what the tools actually retrieved', () => {
    const ledger = createLedger()
    ledger.recordRetrieved('https://real.example')
    const grounded = groundDigest(digest({ sourcesRead: ['https://claimed-but-never-read.example'] }), ledger)
    expect(grounded.sourcesRead).toEqual(['https://real.example'])
  })

  it('marks a summary as unverified when every one of its findings was ungrounded', () => {
    const grounded = groundDigest(
      digest({ findings: [{ claim: 'guess', url: 'https://x.example', confidence: 'high' }] }),
      createLedger(),
    )
    expect(grounded.summary.startsWith('> **Unverified:**')).toBe(true)
  })

  it('leaves a fully grounded digest summary untouched', () => {
    const ledger = createLedger()
    ledger.recordRetrieved('https://a.example')
    const grounded = groundDigest(
      digest({ summary: 'Clean.', findings: [{ claim: 'A', url: 'https://a.example', confidence: 'high' }] }),
      ledger,
    )
    expect(grounded.summary).toBe('Clean.')
  })
})

describe('groundReport — the job boundary', () => {
  // ── The issue #1 regression. This is the exact shape of the 2026-07-30 Immich run:
  // every fetch rate-limited, yet the report shipped `confidence: "high"` citations to a
  // URL the SAME payload listed under `unverified` as unfetchable.
  it('emits NO citation to a URL the same run recorded as unfetched', () => {
    const ledger = createLedger()
    ledger.recordFailed(
      'https://immich.app/docs/install/docker-compose',
      'Request exceeded pay-as-you-go limit; page could not be fetched',
    )
    ledger.recordFailed(
      'https://raw.githubusercontent.com/immich-app/immich/main/docker/docker-compose.yml',
      'Request exceeded pay-as-you-go limit; page could not be fetched',
    )

    const report = groundReport(
      submitted({
        report: 'Immich publishes port 2283:3001 and uses valkey/valkey:8.',
        citations: [
          { claim: 'ports are 2283:3001', url: 'https://immich.app/docs/install/docker-compose', confidence: 'high' },
          { claim: 'redis image is valkey/valkey:8', url: 'https://immich.app/docs/install/docker-compose', confidence: 'high' },
        ],
        unverified: [
          {
            topic: 'official compose file',
            url: 'https://immich.app/docs/install/docker-compose',
            reason: 'Request exceeded pay-as-you-go limit; page could not be fetched',
          },
        ],
      }),
      ledger,
    )

    expect(report.citations).toEqual([])
    expect(report.status).toBe('partial')
    expect(report.grounding.citationsDropped).toBe(2)
  })

  // The invariant stated in the issue, checked as a property over the whole payload.
  it('holds the invariant: no citation URL ever appears in unverified', () => {
    const ledger = createLedger()
    ledger.recordRetrieved('https://good.example')
    ledger.recordFailed('https://bad.example', 'rate limited')

    const report = groundReport(
      submitted({
        citations: [
          { claim: 'ok', url: 'https://good.example', confidence: 'high' },
          { claim: 'not ok', url: 'https://bad.example', confidence: 'high' },
        ],
        unverified: [{ topic: 'thing', url: 'https://bad.example', reason: 'rate limited' }],
      }),
      ledger,
    )

    const unverifiedUrls = new Set(report.unverified.map((u) => u.url))
    for (const citation of report.citations) {
      expect(unverifiedUrls.has(citation.url)).toBe(false)
    }
    expect(report.citations.map((c) => c.url)).toEqual(['https://good.example'])
  })

  it('prepends a partial-result banner so text-only clients see the degradation too', () => {
    const ledger = createLedger()
    ledger.recordFailed('https://bad.example', 'rate limited')
    const report = groundReport(
      submitted({
        report: 'Body.',
        citations: [{ claim: 'x', url: 'https://bad.example', confidence: 'high' }],
      }),
      ledger,
    )
    expect(report.report.startsWith('> **Partial result')).toBe(true)
    expect(report.report).toContain('Body.')
    expect(report.warnings.length).toBeGreaterThan(0)
  })

  it('leaves a clean run untouched: status ok, no banner, citations preserved', () => {
    const ledger = createLedger()
    ledger.recordRetrieved('https://a.example')
    ledger.recordRetrieved('https://b.example')

    const report = groundReport(
      submitted({
        report: 'Body.',
        citations: [
          { claim: 'A', url: 'https://a.example', confidence: 'high' },
          { claim: 'B', url: 'https://b.example', confidence: 'medium' },
        ],
      }),
      ledger,
    )

    expect(report.status).toBe('ok')
    expect(report.report).toBe('Body.')
    expect(report.warnings).toEqual([])
    expect(report.citations).toHaveLength(2)
    expect(report.grounding).toEqual({
      pagesRetrieved: 2,
      pagesFailed: 0,
      citationsKept: 2,
      citationsDropped: 0,
      confidenceCapped: 0,
    })
  })

  it('reports sources as the pages actually retrieved, not the model\'s account of them', () => {
    const ledger = createLedger()
    ledger.recordRetrieved('https://really-read.example')
    const report = groundReport(submitted({ sources: ['https://claimed.example'] }), ledger)
    expect(report.sources).toEqual(['https://really-read.example'])
  })

  it('flags partial when nothing at all could be retrieved', () => {
    const report = groundReport(submitted({ report: 'Body.' }), createLedger())
    expect(report.status).toBe('partial')
    expect(report.warnings.some((w) => w.includes('No source page'))).toBe(true)
  })

  it('does not double-list a dropped citation already present in unverified', () => {
    const ledger = createLedger()
    ledger.recordFailed('https://bad.example', 'rate limited')
    const report = groundReport(
      submitted({
        citations: [{ claim: 'dupe topic', url: 'https://bad.example', confidence: 'high' }],
        unverified: [{ topic: 'dupe topic', url: 'https://bad.example', reason: 'rate limited' }],
      }),
      ledger,
    )
    expect(report.unverified).toHaveLength(1)
  })

  // ── Issue #7: the body is untrusted text too ────────────────────────────────
  // A synthesizer can name a blocked source in the PROSE while listing it under
  // `unverified` — the 2026-08-06 Nunu/Blitz.gg shape. The citation gate never sees that
  // text, so the body is scanned against the final unverified set and annotated.
  describe('body scrub', () => {
    const ledgerWithBad = () => {
      const ledger = createLedger()
      ledger.recordFailed('https://nunu.gg/patch-notes', 'rendered page empty')
      return ledger
    }

    it('annotates a raw-URL mention of an unverified source', () => {
      const report = groundReport(
        submitted({
          report: 'Per https://nunu.gg/patch-notes the win rate rose.\n\nMore body.',
          unverified: [{ topic: 'win rates', url: 'https://nunu.gg/patch-notes', reason: 'rendered page empty' }],
        }),
        ledgerWithBad(),
      )
      expect(report.report).toContain('Unverified in prose')
      expect(report.report).toContain('https://nunu.gg/patch-notes')
      expect(report.report).toContain('rendered page empty')
    })

    it('annotates a markdown-link target and a bare-host mention', () => {
      const report = groundReport(
        submitted({
          report: 'The [patch notes](https://nunu.gg/patch-notes) say so, and per nunu.gg it matches.',
          unverified: [{ topic: 'win rates', url: 'https://nunu.gg/patch-notes', reason: 'rendered page empty' }],
        }),
        ledgerWithBad(),
      )
      expect(report.report).toContain('Unverified in prose')
    })

    it('annotates a www-prefixed mention of the same page', () => {
      const report = groundReport(
        submitted({
          report: 'See https://www.nunu.gg/patch-notes for details.',
          unverified: [{ topic: 'win rates', url: 'https://nunu.gg/patch-notes', reason: 'rendered page empty' }],
        }),
        ledgerWithBad(),
      )
      expect(report.report).toContain('Unverified in prose')
    })

    it('leaves a body that never names the unverified source untouched', () => {
      const ledger = ledgerWithBad()
      ledger.recordRetrieved('https://good.example')
      const report = groundReport(
        submitted({
          report: 'Body never mentions it.',
          citations: [{ claim: 'ok', url: 'https://good.example', confidence: 'high' }],
          unverified: [{ topic: 'win rates', url: 'https://nunu.gg/patch-notes', reason: 'rendered page empty' }],
        }),
        ledger,
      )
      expect(report.status).toBe('ok')
      expect(report.report).toBe('Body never mentions it.')
    })

    it('does not flag a host that merely contains the blocked one as a substring', () => {
      const report = groundReport(
        submitted({
          report: 'See https://notnunu.gg/patch-notes or per subnunu.gg for details.',
          unverified: [{ topic: 'win rates', url: 'https://nunu.gg/patch-notes', reason: 'rendered page empty' }],
        }),
        ledgerWithBad(),
      )
      expect(report.report).not.toContain('Unverified in prose')
    })

    it('never flags a URL the ledger vindicated — it backs a real citation', () => {
      const ledger = createLedger()
      ledger.recordRetrieved('https://www.npmjs.com/package/x')
      const report = groundReport(
        submitted({
          report: 'The current version is 2.0.0 per https://www.npmjs.com/package/x.',
          citations: [{ claim: 'latest is 2.0.0', url: 'https://www.npmjs.com/package/x', confidence: 'high' }],
          unverified: [{ topic: 'npm page', url: 'https://www.npmjs.com/package/x', reason: 'first fetch failed' }],
        }),
        ledger,
      )
      expect(report.citations).toHaveLength(1)
      expect(report.unverified[0]?.url).toBeNull()
      expect(report.report).not.toContain('Unverified in prose')
    })

    it('emits one note per distinct unverified URL, deduplicated', () => {
      const report = groundReport(
        submitted({
          report: 'https://nunu.gg/patch-notes and https://nunu.gg/patch-notes again.',
          unverified: [
            { topic: 'a', url: 'https://nunu.gg/patch-notes', reason: 'rendered page empty' },
            { topic: 'b', url: 'https://nunu.gg/patch-notes', reason: 'rendered page empty' },
          ],
        }),
        ledgerWithBad(),
      )
      expect(report.report.split('Unverified in prose')).toHaveLength(2)
    })

    it('orders the scrub notes below the partial-result banner', () => {
      const report = groundReport(
        submitted({
          report: 'Per https://nunu.gg/patch-notes the win rate rose.',
          unverified: [{ topic: 'win rates', url: 'https://nunu.gg/patch-notes', reason: 'rendered page empty' }],
        }),
        ledgerWithBad(),
      )
      expect(report.report.startsWith('> **Partial result')).toBe(true)
      expect(report.report.indexOf('Partial result')).toBeLessThan(report.report.indexOf('Unverified in prose'))
    })

    // ── Boundaries. A mechanical matcher that over-matches annotates sources the report
    // never named, which is worse than no annotation: it discredits a correct sentence.
    // Every negative case below is paired with the positive it must not be confused with.
    // Comparison runs through `normalizeUrl`, so host case, `www.`, scheme and a trailing
    // slash are one rule — and path case stays significant, as HTTP requires.
    const bodyCases: Array<{ body: string; want: boolean; why: string }> = [
      { body: 'See https://nunu.gg/patch-notes here.', want: true, why: 'the exact URL' },
      { body: 'See [the notes](https://nunu.gg/patch-notes).', want: true, why: 'a markdown link target' },
      { body: 'Per nunu.gg the win rate rose.', want: true, why: 'a bare host' },
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
      { body: 'See https://nunu.gg/ here.', want: true, why: 'a bare host with a trailing slash' },
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
    ]

    // A hostname embedded in an internationalized domain must not be read as a mention: with
    // an ASCII-only boundary, `münchen.de` yields the token `nchen.de`.
    for (const { body, want, why } of bodyCases) {
      it(`${want ? 'flags' : 'leaves alone'}: ${why}`, () => {
        const report = groundReport(
          submitted({
            report: body,
            unverified: [{ topic: 'win rates', url: 'https://nunu.gg/patch-notes', reason: 'rendered page empty' }],
          }),
          ledgerWithBad(),
        )
        if (want) expect(report.report).toContain('Unverified in prose')
        else expect(report.report).not.toContain('Unverified in prose')
      })
    }

    it('leaves alone: an IDN host that merely ends with the blocked one', () => {
      const ledger = createLedger()
      ledger.recordRetrieved('https://good.example')
      ledger.recordFailed('https://nchen.de/x', 'rendered page empty')
      const report = groundReport(
        submitted({
          report: 'See https://münchen.de/x here.',
          citations: [{ claim: 'ok', url: 'https://good.example', confidence: 'high' }],
          unverified: [{ topic: 't', url: 'https://nchen.de/x', reason: 'rendered page empty' }],
        }),
        ledger,
      )
      expect(report.report).not.toContain('Unverified in prose')
    })

    // The same host in DECOMPOSED Unicode (`u` + U+0308 instead of `ü`): the combining mark
    // must count as part of the hostname, or the matcher starts after it and reads the tail
    // `nchen.de` as a mention of a source the report never named.
    it('leaves alone: a decomposed IDN host that ends with the blocked one', () => {
      const ledger = createLedger()
      ledger.recordRetrieved('https://good.example')
      ledger.recordFailed('https://nchen.de/x', 'rendered page empty')
      const report = groundReport(
        submitted({
          report: 'See https://mu\u0308nchen.de/x here.',
          citations: [{ claim: 'ok', url: 'https://good.example', confidence: 'high' }],
          unverified: [{ topic: 't', url: 'https://nchen.de/x', reason: 'rendered page empty' }],
        }),
        ledger,
      )
      expect(report.report).not.toContain('Unverified in prose')
    })

    // The positive counterpart: `new URL()` IDNA-encodes a Unicode host to punycode, while the
    // body and the caller's own entry both carry the Unicode spelling. Without matching both,
    // a genuinely Unicode blocked URL is never flagged even when the body names it verbatim.
    it('flags a genuinely Unicode (IDN) host mentioned verbatim', () => {
      const ledger = createLedger()
      ledger.recordRetrieved('https://good.example')
      ledger.recordFailed('https://münchen.de/x', 'rendered page empty')
      const report = groundReport(
        submitted({
          report: 'See https://münchen.de/x here.',
          citations: [{ claim: 'ok', url: 'https://good.example', confidence: 'high' }],
          unverified: [{ topic: 't', url: 'https://münchen.de/x', reason: 'rendered page empty' }],
        }),
        ledger,
      )
      expect(report.report).toContain('Unverified in prose')
    })

    // A query or fragment makes it a DIFFERENT document, the same call `normalizeUrl` makes
    // for citations. Matching is symmetric: present on both sides, it is the same page.
    it('matches when the query string is present on both sides', () => {
      const ledger = createLedger()
      ledger.recordRetrieved('https://good.example')
      ledger.recordFailed('https://nunu.gg/patch-notes?v=2', 'rendered page empty')
      const report = groundReport(
        submitted({
          report: 'See https://nunu.gg/patch-notes?v=2 here.',
          citations: [{ claim: 'ok', url: 'https://good.example', confidence: 'high' }],
          unverified: [{ topic: 't', url: 'https://nunu.gg/patch-notes?v=2', reason: 'rendered page empty' }],
        }),
        ledger,
      )
      expect(report.report).toContain('Unverified in prose')
    })

    // A fragment is the one place the body matcher deliberately diverges from `normalizeUrl`,
    // which drops it so citations match across a section anchor. The directions are not
    // symmetrical here: naming `page#section` IS naming the blocked `page#section` (dropping
    // the fragment would silently miss it), while naming the fragmentless `page` must not be
    // annotated for a blocked `page#section`.
    it('flags a verbatim fragment mention but not the fragmentless one', () => {
      const ledger = createLedger()
      ledger.recordRetrieved('https://good.example')
      ledger.recordFailed('https://nunu.gg/patch-notes#section', 'rendered page empty')
      const blocked = { topic: 't', url: 'https://nunu.gg/patch-notes#section', reason: 'rendered page empty' }
      const verbatim = groundReport(
        submitted({
          report: 'See https://nunu.gg/patch-notes#section here.',
          citations: [{ claim: 'ok', url: 'https://good.example', confidence: 'high' }],
          unverified: [blocked],
        }),
        ledger,
      )
      expect(verbatim.report).toContain('Unverified in prose')
      const fragmentless = groundReport(
        submitted({
          report: 'See https://nunu.gg/patch-notes here.',
          citations: [{ claim: 'ok', url: 'https://good.example', confidence: 'high' }],
          unverified: [blocked],
        }),
        ledger,
      )
      expect(fragmentless.report).not.toContain('Unverified in prose')
    })

    // A non-ASCII host must fold case too: folding only `[a-zA-Z]` would silently miss a
    // body's `MÜNCHEN.DE` against a blocked `münchen.de`.
    it('flags a non-ASCII host in a different case', () => {
      const ledger = createLedger()
      ledger.recordRetrieved('https://good.example')
      ledger.recordFailed('https://münchen.de/x', 'rendered page empty')
      const report = groundReport(
        submitted({
          report: 'See https://MÜNCHEN.DE/x here.',
          citations: [{ claim: 'ok', url: 'https://good.example', confidence: 'high' }],
          unverified: [{ topic: 't', url: 'https://münchen.de/x', reason: 'rendered page empty' }],
        }),
        ledger,
      )
      expect(report.report).toContain('Unverified in prose')
    })

    // A port is part of the authority: `nunu.gg:8443` is not `nunu.gg`, and an exact
    // reference to a ported URL must still be flagged.
    it('flags an exact mention of a URL carrying a port', () => {
      const ledger = createLedger()
      ledger.recordRetrieved('https://good.example')
      ledger.recordFailed('https://nunu.gg:8443/patch-notes', 'rendered page empty')
      const report = groundReport(
        submitted({
          report: 'See https://nunu.gg:8443/patch-notes here.',
          citations: [{ claim: 'ok', url: 'https://good.example', confidence: 'high' }],
          unverified: [{ topic: 't', url: 'https://nunu.gg:8443/patch-notes', reason: 'rendered page empty' }],
        }),
        ledger,
      )
      expect(report.report).toContain('Unverified in prose')
    })

    // `domainToUnicode` returns an EMPTY STRING for anything that is not a bare domain —
    // notably `host:port`. An alternation with an empty branch always succeeds, and with the
    // path optional that made a ported blocked URL match almost any prose. Every body here
    // names no such source and must stay untouched.
    it('does not flag ordinary prose for a ported blocked URL', () => {
      const ledger = createLedger()
      ledger.recordRetrieved('https://good.example')
      ledger.recordFailed('https://internal.example:8443/dashboard', 'rendered page empty')
      const blocked = {
        topic: 't',
        url: 'https://internal.example:8443/dashboard',
        reason: 'rendered page empty',
      }
      for (const body of [
        'The rate rose to 55%.',
        'Revenue grew 12% year over year.',
        'Nothing relevant here.',
        'See https://other.example/thing here.',
      ]) {
        const report = groundReport(
          submitted({
            report: body,
            citations: [{ claim: 'ok', url: 'https://good.example', confidence: 'high' }],
            unverified: [blocked],
          }),
          ledger,
        )
        expect(report.report).not.toContain('Unverified in prose')
      }
    })

    // A blocked URL WITH a fragment must not be satisfied by a body naming the bare page:
    // `#section` and `#section2` are different sections, and an optional fragment group would
    // let the fragmentless mention through.
    it('does not confuse two different fragments on the same page', () => {
      const ledger = createLedger()
      ledger.recordRetrieved('https://good.example')
      ledger.recordFailed('https://nunu.gg/patch-notes#section2', 'rendered page empty')
      const blocked = { topic: 't', url: 'https://nunu.gg/patch-notes#section2', reason: 'rendered page empty' }
      const other = groundReport(
        submitted({
          report: 'See https://nunu.gg/patch-notes#section here.',
          citations: [{ claim: 'ok', url: 'https://good.example', confidence: 'high' }],
          unverified: [blocked],
        }),
        ledger,
      )
      expect(other.report).not.toContain('Unverified in prose')
      const same = groundReport(
        submitted({
          report: 'See https://nunu.gg/patch-notes#section2 here.',
          citations: [{ claim: 'ok', url: 'https://good.example', confidence: 'high' }],
          unverified: [blocked],
        }),
        ledger,
      )
      expect(same.report).toContain('Unverified in prose')
    })

    // A character whose case mapping is not one-to-one is left literal rather than mis-folded.
    // `ß` uppercases to `SS`, so a blocked `straße.example` matches the lowercase spelling but
    // NOT `STRASSE.example` — a documented tradeoff, pinned here so a future "fix" has to
    // confront it deliberately.
    it('leaves a multi-char case mapping literal (ß)', () => {
      const ledger = createLedger()
      ledger.recordRetrieved('https://good.example')
      ledger.recordFailed('https://straße.example/x', 'rendered page empty')
      const blocked = { topic: 't', url: 'https://straße.example/x', reason: 'rendered page empty' }
      const lower = groundReport(
        submitted({
          report: 'See https://straße.example/x here.',
          citations: [{ claim: 'ok', url: 'https://good.example', confidence: 'high' }],
          unverified: [blocked],
        }),
        ledger,
      )
      expect(lower.report).toContain('Unverified in prose')
      const upper = groundReport(
        submitted({
          report: 'See https://STRASSE.example/x here.',
          citations: [{ claim: 'ok', url: 'https://good.example', confidence: 'high' }],
          unverified: [blocked],
        }),
        ledger,
      )
      expect(upper.report).not.toContain('Unverified in prose')
    })

    // A non-null but unparseable URL must be skipped without throwing, and without taking a
    // real mention down with it.
    it('skips an unparseable url without throwing or mis-skipping a real mention', () => {
      const ledger = createLedger()
      ledger.recordRetrieved('https://good.example')
      ledger.recordFailed('https://nunu.gg/patch-notes', 'rendered page empty')
      const report = groundReport(
        submitted({
          report: 'See https://nunu.gg/patch-notes here.',
          citations: [{ claim: 'ok', url: 'https://good.example', confidence: 'high' }],
          unverified: [
            { topic: 'junk', url: 'not a url at all', reason: 'nonsense' },
            { topic: 't', url: 'https://nunu.gg/patch-notes', reason: 'rendered page empty' },
          ],
        }),
        ledger,
      )
      expect(report.report).toContain('Unverified in prose')
      expect(report.report.split('Unverified in prose')).toHaveLength(2)
    })

    // A body-scrub-only degradation (one clean citation, plus prose naming a source that was
    // never fetched, so it is in neither the ledger's `failed` list nor `citationsDropped`)
    // must still say WHY it degraded — an empty `parts` used to emit a banner with a bare
    // ". " where the cause belongs.
    it('names the body scrub as the cause when it is the sole reason for degrading', () => {
      const ledger = createLedger()
      ledger.recordRetrieved('https://good.example/x')
      const report = groundReport(
        submitted({
          report: 'Per https://nunu.gg/patch-notes the rate rose.',
          citations: [{ claim: 'ok', url: 'https://good.example/x', confidence: 'high' }],
          unverified: [{ topic: 't', url: 'https://nunu.gg/patch-notes', reason: 'never fetched' }],
        }),
        ledger,
      )
      expect(report.status).toBe('partial')
      expect(report.report).toContain('Partial result')
      expect(report.report).toContain('could not be verified and are flagged inline')
      expect(report.report).not.toContain('this run. . Anything')
    })

    // A path full of regex metacharacters is matched literally, not compiled: the blocked
    // URL is compared as a string through `normalizeUrl`, so `(` `)` `+` `.` are inert.
    it('matches a path containing regex metacharacters literally', () => {
      const ledger = createLedger()
      ledger.recordRetrieved('https://good.example')
      ledger.recordFailed('https://en.example/wiki/Foo_(bar)+x', 'rendered page empty')
      const blocked = { topic: 't', url: 'https://en.example/wiki/Foo_(bar)+x', reason: 'rendered page empty' }
      const hit = groundReport(
        submitted({
          report: 'See https://en.example/wiki/Foo_(bar)+x here.',
          citations: [{ claim: 'ok', url: 'https://good.example', confidence: 'high' }],
          unverified: [blocked],
        }),
        ledger,
      )
      expect(hit.report).toContain('Unverified in prose')
      // The parens are part of the path, so the same URL without them is a different page —
      // and `+` is a literal here, not a quantifier that would let `Foo_(bar)` match `Foobar`.
      const miss = groundReport(
        submitted({
          report: 'See https://en.example/wiki/Foo_barx here.',
          citations: [{ claim: 'ok', url: 'https://good.example', confidence: 'high' }],
          unverified: [blocked],
        }),
        ledger,
      )
      expect(miss.report).not.toContain('Unverified in prose')
    })

    it('annotates both of two distinct unverified URLs', () => {
      const ledger = createLedger()
      ledger.recordRetrieved('https://good.example')
      ledger.recordFailed('https://a.example/p', 'x')
      ledger.recordFailed('https://b.example/q', 'y')
      const report = groundReport(
        submitted({
          report: 'Per https://a.example/p and https://b.example/q.',
          citations: [{ claim: 'ok', url: 'https://good.example', confidence: 'high' }],
          unverified: [
            { topic: 'a', url: 'https://a.example/p', reason: 'x' },
            { topic: 'b', url: 'https://b.example/q', reason: 'y' },
          ],
        }),
        ledger,
      )
      expect(report.report.split('Unverified in prose')).toHaveLength(3)
      expect(report.status).toBe('partial')
    })

    it('emits ONE note for two string forms of the same page', () => {
      const ledger = createLedger()
      ledger.recordRetrieved('https://good.example')
      ledger.recordFailed('https://nunu.gg/patch-notes', 'rendered page empty')
      const report = groundReport(
        submitted({
          report: 'Per https://nunu.gg/patch-notes the win rate rose.',
          citations: [{ claim: 'ok', url: 'https://good.example', confidence: 'high' }],
          unverified: [
            { topic: 'a', url: 'https://nunu.gg/patch-notes', reason: 'rendered page empty' },
            { topic: 'b', url: 'https://www.nunu.gg/patch-notes/', reason: 'rendered page empty' },
          ],
        }),
        ledger,
      )
      // Dedup keys on the canonical url: `www.` and a trailing slash are the same page, and
      // keying on the raw string would emit a duplicate note for one real source.
      expect(report.report.split('Unverified in prose')).toHaveLength(2)
    })

    // ── A scrub note is evidence lost, so it must reach `degraded`/`status`/`warnings`.
    // Without this the body/`unverified` contradiction still ships under `status: "ok"`,
    // which is issue #7 only half closed.
    it('degrades the run when the body names an unverified source', () => {
      const report = groundReport(
        submitted({
          report: 'Per https://nunu.gg/patch-notes the win rate rose.',
          unverified: [{ topic: 'win rates', url: 'https://nunu.gg/patch-notes', reason: 'rendered page empty' }],
        }),
        ledgerWithBad(),
      )
      expect(report.status).toBe('partial')
      expect(report.report.startsWith('> **Partial result')).toBe(true)
      expect(report.warnings.some((w) => w.includes('named in the report body'))).toBe(true)
    })

    it('does not scrub an entry with no url — there is nothing to match on', () => {
      const ledger = createLedger()
      ledger.recordRetrieved('https://good.example')
      const report = groundReport(
        submitted({
          report: 'Something is unconfirmed.',
          citations: [{ claim: 'ok', url: 'https://good.example', confidence: 'high' }],
          unverified: [{ topic: 'vibes', url: null, reason: 'no source at all' }],
        }),
        ledger,
      )
      expect(report.status).toBe('ok')
      expect(report.report).toBe('Something is unconfirmed.')
    })
  })
})

// ── Regression for the live 2026-07-31 npm run ───────────────────────────────
// One worker obtained the npm package page through `packageInfo`; another's `fetchPage` on
// the SAME url was rate-limited and dutifully logged it as blocked. The model's bookkeeping
// then deleted three correct, fully-grounded citations. A failed ATTEMPT is not a failure to
// obtain the content.
describe('groundReport — ledger evidence outranks the model\'s own bookkeeping', () => {
  const ledgerWithRetrieved = () => {
    const ledger = createLedger()
    ledger.recordRetrieved('https://www.npmjs.com/package/@modelcontextprotocol/server')
    return ledger
  }

  const run = () =>
    groundReport(
      submitted({
        report: 'The current stable version is 2.0.0.',
        citations: [
          { claim: 'latest is 2.0.0', url: 'https://www.npmjs.com/package/@modelcontextprotocol/server', confidence: 'high' },
        ],
        unverified: [
          {
            topic: 'npm package page',
            url: 'https://www.npmjs.com/package/@modelcontextprotocol/server',
            reason: "Fetch failed with 'request exceeds the pay-as-you-go limit'",
          },
        ],
      }),
      ledgerWithRetrieved(),
    )

  it('keeps a citation to a page the ledger says was retrieved, despite the model listing it as blocked', () => {
    const report = run()
    expect(report.citations).toHaveLength(1)
    expect(report.grounding.citationsDropped).toBe(0)
    expect(report.status).toBe('ok')
  })

  it('still holds the invariant: the vindicated URL is detached from its unverified entry', () => {
    const report = run()
    const unverifiedUrls = new Set(report.unverified.map((u) => u.url))
    for (const citation of report.citations) expect(unverifiedUrls.has(citation.url)).toBe(false)
    // The note survives — only its url is cleared, so no transparency is lost.
    expect(report.unverified).toHaveLength(1)
    expect(report.unverified[0]?.url).toBeNull()
    expect(report.unverified[0]?.reason).toContain('WAS retrieved elsewhere')
  })

  it('does NOT let the model talk a never-retrieved page into being citable', () => {
    const ledger = createLedger()
    ledger.recordFailed('https://blocked.example', 'rate limited')
    const report = groundReport(
      submitted({
        citations: [{ claim: 'x', url: 'https://blocked.example', confidence: 'high' }],
        unverified: [{ topic: 't', url: 'https://blocked.example', reason: 'rate limited' }],
      }),
      ledger,
    )
    expect(report.citations).toEqual([])
  })
})
