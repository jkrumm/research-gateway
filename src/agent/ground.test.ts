import { describe, it, expect } from 'bun:test'
// Imported directly from the pure modules (no `env.js` chain) — same convention as
// run.test.ts. See the note at the top of assemble.ts.
import { createLedger, mergeLedgers, normalizeUrl } from './ledger.js'
import { groundClaims, groundDigest, groundReport, isAbsenceClaim } from './ground.js'
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

  it('missing outranks failed but not retrieved (a 404 origin later read through a mirror)', () => {
    const ledger = createLedger()
    ledger.recordMissing('https://a.example', 'HTTP 404 — the resource does not exist at this URL')
    ledger.recordFailed('https://a.example', 'timeout')
    expect(ledger.tierOf('https://a.example')).toBe('missing')
    ledger.recordRetrieved('https://a.example')
    expect(ledger.tierOf('https://a.example')).toBe('retrieved')
  })

  it('carries a missing URL and its reason through snapshot and merge', () => {
    const a = createLedger()
    a.recordMissing('https://a.example/nope', 'HTTP 410 — gone')
    const merged = mergeLedgers([a.snapshot()])
    expect(merged.tierOf('https://a.example/nope')).toBe('missing')
    expect(merged.failureReason('https://a.example/nope')).toBe('HTTP 410 — gone')
  })

  // failureReason must resolve with tierOf's precedence, not against it: mergeLedgers can
  // legitimately record a URL in both maps (one worker times out, another gets a clean 404),
  // and the reason shown must be the one the resolved tier rests on.
  it('failureReason resolves missing before failed, matching tierOf', () => {
    const a = createLedger()
    a.recordFailed('https://a.example', 'timeout')
    a.recordMissing('https://a.example', 'HTTP 404 — the resource does not exist at this URL')
    expect(a.tierOf('https://a.example')).toBe('missing')
    expect(a.failureReason('https://a.example')).toBe('HTTP 404 — the resource does not exist at this URL')
    const b = createLedger()
    b.recordMissing('https://b.example', 'HTTP 410 — gone')
    b.recordFailed('https://b.example', 'timeout')
    expect(b.failureReason('https://b.example')).toBe('HTTP 410 — gone')
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

// ── Issue #3: the sparse-CDX / geo-restriction failure class ─────────────────
// Both false `high` negatives from the 2026-08-06 deep run cited pages that WERE retrieved
// (a thin Wayback CDX listing, a wiki revision timestamp) — the original failed/unseen gate
// never saw them, because the tier said `retrieved`.
describe('groundClaims — absence claims (issue #3)', () => {
  // The exact lrlib CDN case from docs/field-notes.md: a sparse archive listing was
  // retrieved, and the run concluded from its emptiness that the CDN hosts no Wild Rift data.
  it('caps an absence claim citing a RETRIEVED page at medium, however high the model asserted', () => {
    const ledger = createLedger()
    ledger.recordRetrieved('https://web.archive.org/cdx?url=cdn.lrlib.net&limit=5')
    const { kept, cappedCount } = groundClaims(
      [
        {
          claim: "The lrlib CDN hosts only static image assets and does not serve Wild Rift champion data",
          url: 'https://web.archive.org/cdx?url=cdn.lrlib.net&limit=5',
          confidence: 'high',
        },
      ],
      ledger,
    )
    expect(kept[0]?.confidence).toBe('medium')
    expect(cappedCount).toBe(1)
  })

  // The exact mlol.qt.qq.com case: one connection-refused fetch became a geographic claim.
  it('drops an absence claim whose supporting fetch failed, with the absence-specific reason', () => {
    const ledger = createLedger()
    ledger.recordFailed('https://mlol.qt.qq.com', 'connection refused')
    const { kept, dropped } = groundClaims(
      [
        {
          claim: 'mlol.qt.qq.com is geo-restricted to mainland China and is not accessible from outside',
          url: 'https://mlol.qt.qq.com',
          confidence: 'high',
        },
      ],
      ledger,
    )
    expect(kept).toEqual([])
    expect(dropped[0]?.reason).toContain('never proves absence')
  })

  it('keeps an absence claim at high when the origin itself answered 404/410 (missing tier)', () => {
    const ledger = createLedger()
    ledger.recordMissing('https://a.example/nope', 'HTTP 404 — the resource does not exist at this URL')
    const { kept, cappedCount } = groundClaims(
      [{ claim: 'The endpoint does not exist', url: 'https://a.example/nope', confidence: 'high' }],
      ledger,
    )
    expect(kept[0]?.confidence).toBe('high')
    expect(cappedCount).toBe(0)
  })

  it('drops a POSITIVE claim citing a 404 — a resource that does not exist has no content to quote', () => {
    const ledger = createLedger()
    ledger.recordMissing('https://a.example/nope', 'HTTP 404 — the resource does not exist at this URL')
    const { kept, dropped } = groundClaims(
      [{ claim: 'The endpoint returns version 2.0.0', url: 'https://a.example/nope', confidence: 'high' }],
      ledger,
    )
    expect(kept).toEqual([])
    expect(dropped[0]?.reason).toContain('does not exist')
  })

  it('leaves positive claims about a retrieved page untouched by the absence gate', () => {
    const ledger = createLedger()
    ledger.recordRetrieved('https://a.example')
    const { kept, cappedCount } = groundClaims(
      [{ claim: 'The page lists version 2.0.0', url: 'https://a.example', confidence: 'high' }],
      ledger,
    )
    expect(kept[0]?.confidence).toBe('high')
    expect(cappedCount).toBe(0)
  })

  it('does not upgrade a low absence claim just because the tier is missing', () => {
    const ledger = createLedger()
    ledger.recordMissing('https://a.example/nope', 'HTTP 410 — gone')
    const { kept } = groundClaims(
      [{ claim: 'The page does not exist', url: 'https://a.example/nope', confidence: 'low' }],
      ledger,
    )
    expect(kept[0]?.confidence).toBe('low')
  })

  it('classifies absence claim texts, and does not fire on ordinary positives', () => {
    for (const claim of [
      'mlol.qt.qq.com is geo-restricted to mainland China',
      'The CDN serves no such resource',
      'No releases were ever published for this repo',
      'The package is not available on npm',
      'The registry says the module does not exist',
      'The host is offline',
    ]) {
      expect(isAbsenceClaim(claim)).toBe(true)
    }
    for (const claim of [
      'The CDN serves the live 141-champion roster as JSON',
      'The registry answered with version 2.0.0',
      'The page lists 3 releases, the latest on 2026-08-01',
      'The module exports two functions',
    ]) {
      expect(isAbsenceClaim(claim)).toBe(false)
    }
  })

  // Feature negation is NOT absence: a fact like "does not support X" says what a thing
  // DOESN'T do while presupposing it exists. The original gate's negation+verb branch read
  // all of these as absence claims and demoted correct `high` facts to `medium`.
  it('does not fire on feature-negation sentences that presuppose an existing thing', () => {
    for (const claim of [
      'The library does not support async iteration',
      'The plan does not include SSO',
      'The database does not support multi-key transactions',
      'The proxy does not work with HTTP/2',
      'The repo does not contain examples',
      'The API does not have a Python client',
      'The service does not offer a free tier',
      'The tool does not publish Windows builds',
      'The framework does not load plugins from node_modules',
    ]) {
      expect(isAbsenceClaim(claim)).toBe(false)
    }
  })

  // Past-tense removal phrasings are genuine absence claims but carry no negation word the
  // original gate's branches matched — each was a false negative that let the claim ride.
  it('fires on past-tense removal and state phrasings', () => {
    for (const claim of [
      'The package was removed from npm',
      'The service was shut down in 2023',
      'The library was retired last year',
      'The API was deprecated in v2',
      'The endpoint no longer exists',
      'The records no longer exist',
      'The package is unavailable on npm',
    ]) {
      expect(isAbsenceClaim(claim)).toBe(true)
    }
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
      pagesMissing: 0,
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

  // A 404-only run is not "evidence was lost": the origin's answer IS the evidence, and an
  // absence claim citing it is grounded at `high`. Bannering it "Partial result" contradicts
  // the citation sitting right below the banner.
  it('does not banner-contradict a legitimate absence citation in a 404-only run', () => {
    const ledger = createLedger()
    ledger.recordMissing('https://a.example/nope', 'HTTP 404 — the resource does not exist at this URL')
    const report = groundReport(
      submitted({
        report: 'The endpoint does not exist.',
        citations: [
          { claim: 'The endpoint does not exist', url: 'https://a.example/nope', confidence: 'high' },
        ],
      }),
      ledger,
    )
    expect(report.status).toBe('ok')
    expect(report.report).toBe('The endpoint does not exist.')
    expect(report.citations).toHaveLength(1)
    expect(report.grounding.pagesMissing).toBe(1)
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

  // The dedup key joins url and topic, so the separator must be a character that cannot occur
  // in either — otherwise two distinct entries collide into one and a disavowal is silently
  // dropped. A space does not qualify: url `https://a.example/x y` + topic `t` and url
  // `https://a.example/x` + topic `y t` both join to `https://a.example/x y t`. The key's
  // separator is `\u0000` written as an escape (the raw byte made git treat the file as binary).
  it('keeps two distinct entries that would collide on a space-joined key', () => {
    const ledger = createLedger()
    ledger.recordRetrieved('https://good.example')
    ledger.recordFailed('https://a.example/x y', 'x')
    ledger.recordFailed('https://a.example/x', 'y')
    const report = groundReport(
      submitted({
        report: 'Nothing relevant here.',
        citations: [{ claim: 'ok', url: 'https://good.example', confidence: 'high' }],
        unverified: [
          { topic: 't', url: 'https://a.example/x y', reason: 'x' },
          { topic: 'y t', url: 'https://a.example/x', reason: 'y' },
        ],
      }),
      ledger,
    )
    expect(report.unverified).toHaveLength(2)
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
