import { describe, it, expect } from 'bun:test'
// Imported directly from the pure modules (no `env.js` chain) — same convention as
// run.test.ts. See the note at the top of assemble.ts.
import { createLedger, mergeLedgers, normalizeUrl } from './ledger.js'
import {
  groundClaims,
  groundDigest,
  groundReport,
  isAbsenceClaim,
  degradeClaimsOnUnverifiedSources,
  partialCauseOf,
} from './ground.js'
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
    const claim = { claim: 'A', url: 'https://a.example', confidence: 'high' as const }
    const { kept, capped } = groundClaims([claim], ledger)
    expect(kept[0]?.confidence).toBe('medium')
    expect(capped).toEqual(new Set([0]))
  })

  it('does not UPGRADE a low-confidence claim about a fully retrieved page', () => {
    const ledger = createLedger()
    ledger.recordRetrieved('https://a.example')
    const { kept, capped } = groundClaims(
      [{ claim: 'A', url: 'https://a.example', confidence: 'low' }],
      ledger,
    )
    expect(kept[0]?.confidence).toBe('low')
    expect(capped.size).toBe(0)
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
    const { kept, capped } = groundClaims(
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
    expect(capped.size).toBe(1)
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
    const { kept, capped } = groundClaims(
      [{ claim: 'The endpoint does not exist', url: 'https://a.example/nope', confidence: 'high' }],
      ledger,
    )
    expect(kept[0]?.confidence).toBe('high')
    expect(capped.size).toBe(0)
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
    const { kept, capped } = groundClaims(
      [{ claim: 'The page lists version 2.0.0', url: 'https://a.example', confidence: 'high' }],
      ledger,
    )
    expect(kept[0]?.confidence).toBe('high')
    expect(capped.size).toBe(0)
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
      citationsDegraded: 0,
      citationsNumberUnmatched: 0,
      partialCause: null,
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

  // ── Regression for issue #4 (the 2026-08-06 stale-wiki-module run) ──────────
  // The report declared a wiki module stale while its own unverified block said the module
  // was "too large to fetch — 121 KB" — the claim cited a sibling host's revision timestamp,
  // so the URL rules saw nothing wrong. A claim whose text names the subject of an
  // unverified entry must degrade with it.
  describe('claims resting on an unverified document (issue #4)', () => {
    const incidentLedger = () => {
      const ledger = createLedger()
      ledger.recordFailed('https://wiki.example/Module:Items?action=raw', 'too large to fetch — 121 KB')
      ledger.recordRetrieved('https://mirror.example/Module:Items?action=raw')
      return ledger
    }

    const incidentRun = () =>
      groundReport(
        submitted({
          report: 'The item module is stale and unusable for the current patch.',
          citations: [
            {
              claim: 'the Module:Items page is stale, last edited 2025-09-17',
              url: 'https://mirror.example/Module:Items?action=raw',
              confidence: 'high',
            },
          ],
          unverified: [
            {
              topic: 'Module:Items wiki page',
              url: 'https://wiki.example/Module:Items?action=raw',
              reason: 'too large to fetch — 121 KB',
            },
          ],
        }),
        incidentLedger(),
      )

    it('caps a citation asserting facts about an unverified document at low', () => {
      const report = incidentRun()
      expect(report.citations).toHaveLength(1)
      expect(report.citations[0]?.confidence).toBe('low')
      // A cap alone is not lost evidence — same semantics as the snippet cap — but the
      // warning must still name it.
      expect(report.warnings.some((w) => w.includes('capped at low'))).toBe(true)
    })

    it('counts the cap in grounding so the transparency channel sees it', () => {
      const report = incidentRun()
      expect(report.grounding.citationsKept).toBe(1)
      expect(report.grounding.confidenceCapped).toBe(1)
    })

    it('leaves claims that do not name the unverified subject untouched', () => {
      const ledger = incidentLedger()
      ledger.recordRetrieved('https://docs.example/champions')
      const report = groundReport(
        submitted({
          citations: [
            { claim: 'champion win rates come from docs.example', url: 'https://docs.example/champions', confidence: 'high' },
          ],
          unverified: [
            { topic: 'Module:Items wiki page', url: 'https://wiki.example/Module:Items', reason: 'too large to fetch' },
          ],
        }),
        ledger,
      )
      expect(report.citations[0]?.confidence).toBe('high')
      expect(report.grounding.confidenceCapped).toBe(0)
      expect(report.status).toBe('ok')
    })

    it('needs two shared distinctive tokens — one is just context the report legitimately shares', () => {
      const ledger = createLedger()
      ledger.recordRetrieved('https://immich.app/docs/install')
      ledger.recordFailed('https://immich.app/docs/bulk-delete', 'rate limited')
      const unverified = [{ topic: 'bulk delete docs', url: 'https://immich.app/docs/bulk-delete', reason: 'rate limited' }]
      // "bulk" alone is shared; the claim is about the install flow, not the blocked page.
      const one = groundReport(
        submitted({
          citations: [
            { claim: 'Immich bulk operations run after the initial docker compose install', url: 'https://immich.app/docs/install', confidence: 'high' },
          ],
          unverified,
        }),
        ledger,
      )
      expect(one.citations[0]?.confidence).toBe('high')
      // Two shared tokens (bulk, delete) name the blocked document itself.
      const two = degradeClaimsOnUnverifiedSources(
        [{ claim: 'bulk delete removes assets', url: 'https://immich.app/docs/install', confidence: 'high' }],
        unverified,
      )
      expect(two.kept[0]?.confidence).toBe('low')
    })

    it('does not lower a claim the model already capped at low', () => {
      const { kept, degraded } = degradeClaimsOnUnverifiedSources(
        [{ claim: 'the Module:Items page is stale', url: 'https://mirror.example/Module:Items', confidence: 'low' }],
        [{ topic: 'Module:Items wiki page', url: 'https://wiki.example/Module:Items' }],
      )
      expect(kept[0]?.confidence).toBe('low')
      expect(degraded.size).toBe(0)
    })

    it('matches subject tokens from the URL path, not the host — when the claim names the site', () => {
      const { kept } = degradeClaimsOnUnverifiedSources(
        [{ claim: "the wiki's Module:Items is stale and unusable", url: 'https://other.example/x', confidence: 'high' }],
        [{ topic: 'bulk delete docs', url: 'https://wiki.example/Module:Items?action=raw' }],
      )
      expect(kept[0]?.confidence).toBe('low')
    })

    it('does not cap a claim citing an unrelated retrieved page that only shares the document name (2026-09-25)', () => {
      // Luden's Echo claims from Riot's patch notes were capped by an unread Liquipedia page
      // about Luden's Echo: the claim is about the item, not about the unread document.
      const { kept } = degradeClaimsOnUnverifiedSources(
        [{ claim: 'Module:Items is stale and unusable', url: 'https://other.example/x', confidence: 'high' }],
        [{ topic: 'bulk delete docs', url: 'https://wiki.example/Module:Items?action=raw' }],
      )
      expect(kept[0]?.confidence).toBe('high')
    })

    // Wave 3: a claim citing a page the run READ is backed by it. An unverified entry about a
    // sibling document must not cap it (2026-10-08 audit: 9 of 52 and 15 of 61 capped).
    it('does not cap a claim whose cited same-host page was retrieved', () => {
      const claims = [{ claim: 'Rakan Module:Items stats changed', url: 'https://wiki.example/Rakan', confidence: 'high' as const }]
      const unverified = [{ topic: 'Module:Items stats', url: 'https://wiki.example/Module:Items' }]
      expect(degradeClaimsOnUnverifiedSources(claims, unverified).kept[0]?.confidence).toBe('low')
      const backed = (url: string) => url === 'https://wiki.example/Rakan'
      expect(degradeClaimsOnUnverifiedSources(claims, unverified, backed).kept[0]?.confidence).toBe('high')
    })

    it('still caps a claim citing a mirror of the unread document, even when the mirror was read', () => {
      const { kept } = degradeClaimsOnUnverifiedSources(
        [{ claim: 'Module:Items is stale', url: 'https://mirror.example/Module:Items?action=raw', confidence: 'high' }],
        [{ topic: 'Module:Items', url: 'https://wiki.example/Module:Items' }],
        () => true,
      )
      expect(kept[0]?.confidence).toBe('low')
    })

    it('groundReport sets partialCause and drops guessed-404 / housekeeping noise from unverified', () => {
      const ledger = createLedger()
      ledger.recordRetrieved('https://good.example/x')
      ledger.recordMissing('https://shop.example/guess', 'HTTP 404 — the resource does not exist at this URL')
      const ok = groundReport(
        submitted({
          citations: [{ claim: 'ok', url: 'https://good.example/x', confidence: 'high' }],
          unverified: [
            { topic: 'guess', url: 'https://shop.example/guess', reason: 'HTTP 404' },
            { topic: 'rest', url: null, reason: "This worker's page-text budget is spent" },
            { topic: 'real', url: 'https://blocked.example/p', reason: 'blocked' },
          ],
        }),
        ledger,
      )
      expect(ok.unverified.map((u) => u.topic)).toEqual(['real'])
      expect(ok.grounding.partialCause).toBeNull()
      expect(ok.status).toBe('ok')

      const scrubbed = groundReport(
        submitted({
          report: 'Per https://blocked.example/p the price is 12 EUR.',
          citations: [{ claim: 'ok', url: 'https://good.example/x', confidence: 'high' }],
          unverified: [{ topic: 'real', url: 'https://blocked.example/p', reason: 'blocked' }],
        }),
        ledger,
      )
      expect(scrubbed.grounding.partialCause).toBe('scrubbed')
      expect(scrubbed.status).toBe('partial')
    })

    it('a sentence that says unreadable but states a figure is still flagged', () => {
      const ledger = createLedger()
      ledger.recordRetrieved('https://good.example/x')
      const r = groundReport(
        submitted({
          report: 'https://blocked.example/p could not be read but lists the frame at 1,299 EUR.',
          citations: [{ claim: 'ok', url: 'https://good.example/x', confidence: 'high' }],
          unverified: [{ topic: 'real', url: 'https://blocked.example/p', reason: 'blocked' }],
        }),
        ledger,
      )
      expect(r.grounding.partialCause).toBe('scrubbed')
    })

    it('records why a run is partial, first cause wins', () => {
      const base = { pagesRetrieved: 3, pagesMissing: 0, pagesFailed: 0, citationsDropped: 0 }
      expect(partialCauseOf(base, 0)).toBeNull()
      expect(partialCauseOf({ ...base, citationsDropped: 1 }, 2)).toBe('dropped')
      expect(partialCauseOf(base, 1)).toBe('scrubbed')
      expect(partialCauseOf({ ...base, pagesRetrieved: 0 }, 0)).toBe('no-pages')
      expect(partialCauseOf({ ...base, pagesFailed: 4 }, 0)).toBe('failures')
    })

    it('does NOT degrade a claim about a document the ledger says was retrieved anyway (issue #1 direction)', () => {
      const ledger = createLedger()
      ledger.recordRetrieved('https://www.npmjs.com/package/@modelcontextprotocol/server')
      const report = groundReport(
        submitted({
          citations: [
            {
              claim: 'the npm package page shows latest is 2.0.0',
              url: 'https://www.npmjs.com/package/@modelcontextprotocol/server',
              confidence: 'high',
            },
          ],
          unverified: [
            {
              topic: 'npm package page',
              url: 'https://www.npmjs.com/package/@modelcontextprotocol/server',
              reason: "Fetch failed with 'request exceeds the pay-as-you-go limit'",
            },
          ],
        }),
        ledger,
      )
      expect(report.citations[0]?.confidence).toBe('high')
      expect(report.grounding.confidenceCapped).toBe(0)
    })

    // The URL gate caps a snippet-backed claim to `medium` and the subject gate then
    // degrades the SAME claim to `low`. Two passes touched one citation, so the count must
    // be the union (1), not the sum (2) — `confidenceCapped` describes citations, not passes.
    it('counts a claim capped AND degraded once, not twice', () => {
      const ledger = createLedger()
      ledger.recordSnippet('https://mirror.example/Module:Items?action=raw')
      ledger.recordFailed('https://wiki.example/Module:Items?action=raw', 'too large to fetch — 121 KB')
      const report = groundReport(
        submitted({
          report: 'The item module is stale.',
          citations: [
            {
              claim: 'the Module:Items page is stale, last edited 2025-09-17',
              url: 'https://mirror.example/Module:Items?action=raw',
              confidence: 'high',
            },
          ],
          unverified: [
            {
              topic: 'Module:Items wiki page',
              url: 'https://wiki.example/Module:Items?action=raw',
              reason: 'too large to fetch — 121 KB',
            },
          ],
        }),
        ledger,
      )
      expect(report.citations).toHaveLength(1)
      expect(report.citations[0]?.confidence).toBe('low')
      expect(report.grounding.citationsKept).toBe(1)
      expect(report.grounding.confidenceCapped).toBe(1)
      expect(report.grounding.citationsDegraded).toBe(1)
    })

    // A confidence cap is not lost evidence. A subject-matched citation keeps its `low` cap
    // and its warning line, but the run's citations were all retrieved — `status` stays `ok`
    // and no "evidence was lost" banner is prepended (the 2026-09-23..25 over-firing, §2b).
    it('caps a subject match at low WITHOUT flipping status or bannering the run', () => {
      const ledger = createLedger()
      ledger.recordRetrieved('https://mirror.example/Module:Items?action=raw')
      ledger.recordFailed('https://wiki.example/Module:Items?action=raw', 'too large to fetch — 121 KB')
      const report = groundReport(
        submitted({
          report: 'The item module is stale and unusable for the current patch.',
          citations: [
            {
              claim: 'the Module:Items page is stale, last edited 2025-09-17',
              url: 'https://mirror.example/Module:Items?action=raw',
              confidence: 'high',
            },
          ],
          unverified: [
            {
              topic: 'Module:Items wiki page',
              url: 'https://wiki.example/Module:Items?action=raw',
              reason: 'too large to fetch — 121 KB',
            },
          ],
        }),
        ledger,
      )
      expect(report.status).toBe('ok')
      expect(report.report).toBe('The item module is stale and unusable for the current patch.')
      expect(report.citations[0]?.confidence).toBe('low')
      expect(report.grounding.citationsDegraded).toBe(1)
      expect(report.grounding.confidenceCapped).toBe(1)
      expect(report.warnings.some((w) => w.includes('capped at low'))).toBe(true)
    })
  })
})

// ── Regression for the 2026-09-23..25 subject-degrade over-firing (review §2b) ──
// The model now writes long, ENUMERATING `unverified` topics with `url: null`. Under the old
// flat ≥2-token rule any claim naming two of the enumerated projects was capped to `low` —
// 148/182, 30/37 and 16/38 citations in three live jobs, every one correctly retrieved. The
// threshold now scales with the subject (max(2, ceil(size / 3))), so an enumeration is not a
// subject. These are the review's actual entries and claims.
describe('groundReport — a long enumeration is not a subject (review §2b)', () => {
  const enumeratedTopics = [
    {
      topic:
        'Cross-project citation-grounding mechanics (source collection/storage, inline citation attachment, post-hoc verification, acknowledged failure modes, borrowed patterns and exact function/config names) for GPT Researcher, STORM, smolagents, Jina, dzhng, Together and Tongyi',
      url: null,
      reason: 'unverified topic',
    },
    {
      topic:
        'Live GitHub metadata (stars, archived flag, latest release) for huggingface/smolagents and togethercomputer/open_deep_research via the GitHub API',
      url: null,
      reason: 'unverified topic',
    },
    {
      topic:
        "LLM provider support: whether pi supports arbitrary OpenAI-compatible chat-completions endpoints (custom base URL + API key + model id); which named providers are first-class; exact config keys/env vars for provider/base URL/API key/model; the module implementing provider adapters and whether an 'openai-completions' adapter is explicitly listed",
      url: null,
      reason: 'unverified topic',
    },
  ]

  const realRetrievedClaims = [
    {
      claim: 'assafelovic/gpt-researcher (Apache-2.0) is actively maintained; latest release v3.6.1 (2026-08-24); ~29.6k stars; last push 2026-08-27.',
      url: 'https://github.com/assafelovic/gpt-researcher',
      confidence: 'high' as const,
    },
    {
      claim: 'stanford-oval/storm (MIT) latest release v1.1.0 (2025-01-23); ~31.5k stars; last push 2025-09-30; not archived.',
      url: 'https://github.com/stanford-oval/storm',
      confidence: 'high' as const,
    },
    {
      claim: 'jina-ai/node-DeepResearch (Apache-2.0) latest release v1.4.0 (2025-02-12); ~5.2k stars; last push 2026-05-01; not archived.',
      url: 'https://github.com/jina-ai/node-DeepResearch',
      confidence: 'high' as const,
    },
    {
      claim: '@earendil-works/pi-coding-agent latest is 0.87.1 (2026-09-22T19:42:48.664Z); dist-tags latest=0.87.1, legacy-node20=0.74.2.',
      url: 'https://www.npmjs.com/package/@earendil-works/pi-coding-agent',
      confidence: 'high' as const,
    },
    {
      claim: 'The agent-core package exposes the `Agent` class: `import { Agent } from "@earendil-works/pi-agent-core"; new Agent({ initialState: { systemPrompt, model }, streamFn })`.',
      url: 'https://github.com/earendil-works/pi/blob/HEAD/packages/agent/README.md',
      confidence: 'high' as const,
    },
  ]

  const ledgerWithRealClaims = () => {
    const ledger = createLedger()
    for (const claim of realRetrievedClaims) ledger.recordRetrieved(claim.url)
    return ledger
  }

  it('leaves real retrieved claims un-degraded against the enumerating topics', () => {
    const report = groundReport(
      submitted({ report: 'Body.', citations: realRetrievedClaims, unverified: enumeratedTopics }),
      ledgerWithRealClaims(),
    )
    expect(report.citations.map((c) => c.confidence)).toEqual(['high', 'high', 'high', 'high', 'high'])
    expect(report.grounding.citationsDegraded).toBe(0)
    expect(report.grounding.confidenceCapped).toBe(0)
    expect(report.status).toBe('ok')
    expect(report.report).toBe('Body.')
  })

  it('still degrades a claim that genuinely covers an enumerating topic', () => {
    const { kept, degraded } = degradeClaimsOnUnverifiedSources(
      [
        {
          claim:
            'huggingface/smolagents has ~25k stars and is not archived, per the live GitHub API metadata; its latest release is v1.20',
          url: 'https://github.com/huggingface/smolagents',
          confidence: 'high',
        },
      ],
      enumeratedTopics,
    )
    expect(kept[0]?.confidence).toBe('low')
    expect(degraded.size).toBe(1)
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

// ── Live 2026-09-25 Wild Rift jobs: 61/88, 19/72, 9/20, 8/15, 22/95 citations capped ────
// Short `unverified` subjects built from the report's own vocabulary ("build", "patch",
// "rune"), and URL subjects capping claims that cite a different, retrieved page.
describe('degradeClaimsOnUnverifiedSources — the cap has to find the document (2026-09-25)', () => {
  const claim = (text: string, url: string) => ({ claim: text, url, confidence: 'high' as const })
  // Enough claims sharing the domain vocabulary for it to count as vocabulary (≥20%, ≥3).
  const vocabulary = [
    claim('wrchina.gg shows the Rammus build for patch 7.3 with Sunfire first', 'https://wrchina.gg/c/rammus/'),
    claim('wrchina.gg shows the Nunu build for patch 7.3 with Frozen Heart', 'https://wrchina.gg/c/nunu-willump/'),
    claim('wrchina.gg shows the Galio build and rune page for patch 7.3', 'https://wrchina.gg/c/galio/'),
    claim('WildRiftFire patch notes list the 7.3 rune removals', 'https://wildriftfire.com/patch-notes'),
  ]

  it('domain vocabulary does not make a URL-less topic match', () => {
    const { degraded } = degradeClaimsOnUnverifiedSources(vocabulary, [
      { topic: 'Bilibili build/rune guide videos for Patch 7.3', url: null },
    ])
    expect(degraded.size).toBe(0)
  })

  it("a claim about the item, citing Riot, is not capped by an unread wiki page about the item", () => {
    const { kept } = degradeClaimsOnUnverifiedSources(
      [claim("In 7.3 Luden's Echo base damage went 140 -> 75", 'https://wildrift.leagueoflegends.com/en-us/news/game-updates/patch-7-3-notes/')],
      [{ topic: "Liquipedia Wild Rift Luden's Echo data", url: "https://liquipedia.net/wildrift/Luden's_Echo" }],
    )
    expect(kept[0]?.confidence).toBe('high')
  })

  it('a retrieved page on the same host about another subject keeps its confidence', () => {
    const { kept } = degradeClaimsOnUnverifiedSources(
      [claim("WildRiftFire's Hecarim guide recommends Trinity Force and Black Cleaver", 'https://www.wildriftfire.com/guide/hecarim')],
      [{ topic: 'Rakan 7.3 recommended rune page', url: 'https://www.wildriftfire.com/guide/rakan' }],
    )
    expect(kept[0]?.confidence).toBe('high')
  })

  it('still caps a claim citing a proxy copy of the unread document', () => {
    const { kept } = degradeClaimsOnUnverifiedSources(
      [claim('wrbase.com/build/vex renders server-side HTML chrome only', 'https://r.jina.ai/https://wrbase.com/build/vex/')],
      [{ topic: 'wrbase.com raw HTML and JS bundle', url: 'https://wrbase.com/build/vex/' }],
    )
    expect(kept[0]?.confidence).toBe('low')
  })

  it('still caps a same-site claim that names the unread page', () => {
    const { kept } = degradeClaimsOnUnverifiedSources(
      [claim("RiftGG's curated Nautilus build page is creator-authored and stale", 'https://www.riftgg.app/en/tier-list/champions')],
      [{ topic: 'RiftGG curated build page for Nautilus', url: 'https://www.riftgg.app/en/champions/nautilus/build' }],
    )
    expect(kept[0]?.confidence).toBe('low')
  })
})

describe('numeric claims must occur in the cited page (2026-09-26 Pyke report)', () => {
  const PYKE = 'https://wrchina.gg/c/pyke/'
  const PAGE = 'Core items 49.8% WR 41.78% use · Top-30: Youmuu\'s Ghostblade 96% · Armorcrusher Boots 83% · Unflinching 70%'

  function pykeLedger() {
    const ledger = createLedger()
    ledger.recordRetrieved(PYKE)
    ledger.recordText(PYKE, PAGE)
    return ledger
  }

  it('caps a citation whose number is not in the page text, and restates it in unverified', () => {
    const report = groundReport(
      submitted({
        citations: [
          { claim: 'Youmuu top-win at ~83% win over ~5,565 matches', url: PYKE, confidence: 'medium' },
          { claim: "Youmuu's Ghostblade appears in 96% of top builds", url: PYKE, confidence: 'high' },
        ],
      }),
      pykeLedger(),
    )
    expect(report.citations.map((c) => c.confidence)).toEqual(['low', 'high'])
    expect(report.grounding.citationsNumberUnmatched).toBe(1)
    expect(report.grounding.confidenceCapped).toBe(1)
    // A capped number is a caution, not lost evidence.
    expect(report.status).toBe('ok')
    const entry = report.unverified.find((u) => u.reason.startsWith('Number check'))
    expect(entry?.url).toBeNull()
    expect(entry?.reason).toContain('~5,565')
    expect(entry?.reason).toContain(PYKE)
    expect(report.warnings.some((w) => w.includes('quote a number'))).toBe(true)
  })

  it('skips the check when no text was recorded for the URL — unknown is not absent', () => {
    const ledger = createLedger()
    ledger.recordRetrieved(PYKE)
    const report = groundReport(
      submitted({ citations: [{ claim: 'over ~5,565 matches', url: PYKE, confidence: 'high' }] }),
      ledger,
    )
    expect(report.citations[0]?.confidence).toBe('high')
    expect(report.grounding.citationsNumberUnmatched).toBe(0)
  })

  it('survives mergeLedgers, and matches the page across URL spellings', () => {
    const merged = mergeLedgers([pykeLedger().snapshot()])
    const report = groundReport(
      submitted({ citations: [{ claim: 'over 5,565 matches', url: 'https://www.wrchina.gg/c/pyke', confidence: 'high' }] }),
      merged,
    )
    expect(report.citations[0]?.confidence).toBe('low')
  })

  it('marks the finding text at the worker boundary so synthesis sees it', () => {
    const out = groundDigest(
      digest({ findings: [{ claim: 'Duskblade CN win 70.4%', url: PYKE, confidence: 'high' }] }),
      pykeLedger(),
    )
    expect(out.findings[0]?.confidence).toBe('low')
    expect(out.findings[0]?.claim).toContain('[unverified number: 70.4% does not occur')
  })
})

describe('numeric check — review fixes', () => {
  it('an empty delivery records nothing, so the check is skipped rather than failing every number', () => {
    const ledger = createLedger()
    ledger.recordRetrieved('https://example.com/a')
    ledger.recordText('https://example.com/a', '   ')
    expect(ledger.numbersOf('https://example.com/a')).toBeNull()
  })

  it('an already-low unmatched claim is flagged but not counted as capped', () => {
    const ledger = createLedger()
    ledger.recordRetrieved('https://example.com/a')
    ledger.recordText('https://example.com/a', 'win rate 50.1%')
    const report = groundReport(
      submitted({ citations: [{ claim: 'over 5,565 matches', url: 'https://example.com/a', confidence: 'low' }] }),
      ledger,
    )
    expect(report.grounding.citationsNumberUnmatched).toBe(1)
    expect(report.grounding.confidenceCapped).toBe(0)
  })
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

    // A host-less authority (`file:///etc/passwd`, `mailto:…`) parses to an EMPTY host. With
    // the path and fragment optional, an empty host pattern collapses the whole regex to just
    // the boundaries — matching almost any prose. `UnverifiedEntry.url` is an unrestricted
    // string, so a synthesizer can put anything here.
    it('does not flag prose for a blocked URL with no host', () => {
      const ledger = createLedger()
      ledger.recordRetrieved('https://good.example')
      ledger.recordFailed('file:///etc/passwd', 'rendered page empty')
      const blocked = { topic: 't', url: 'file:///etc/passwd', reason: 'rendered page empty' }
      for (const body of ['The rate rose to 55%.', 'Revenue grew 12% year over year.', 'A short sentence.']) {
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

    // A ported IDN host must match its Unicode spelling: `domainToUnicode` returns an empty
    // string for `host:port`, so the port has to be split off before the domain is folded.
    it('flags a ported IDN host mentioned in Unicode', () => {
      const ledger = createLedger()
      ledger.recordRetrieved('https://good.example')
      ledger.recordFailed('https://müller.example:8443/x', 'rendered page empty')
      const report = groundReport(
        submitted({
          report: 'See https://müller.example:8443/x here.',
          citations: [{ claim: 'ok', url: 'https://good.example', confidence: 'high' }],
          unverified: [{ topic: 't', url: 'https://müller.example:8443/x', reason: 'rendered page empty' }],
        }),
        ledger,
      )
      expect(report.report).toContain('Unverified in prose')
    })

    // A bare email address is not a web page. Prepending `https://` made
    // `https://user@example.com` parse the part after the `@` as a HOST, so a bogus
    // `unverified` entry canonicalized to `example.com` and collided with the real page —
    // one junk entry could suppress citations to an unrelated site. An opaque URI
    // (`mailto:`) has no host either and must not be collapsed to one.
    it('does not treat a bare email or opaque URI as a web page', () => {
      expect(normalizeUrl('user@example.com')).toBe('user@example.com')
      expect(normalizeUrl('mailto:user@example.com')).toBe('mailto:user@example.com')
      expect(normalizeUrl('mailto:user@example.com')).not.toBe(normalizeUrl('https://example.com'))
      expect(normalizeUrl('file:///etc/passwd')).toBe('file:///etc/passwd')
    })

    it('does not flag prose for a blocked mailto or bare-email entry', () => {
      const ledger = createLedger()
      ledger.recordRetrieved('https://good.example')
      ledger.recordFailed('mailto:user@example.com', 'rendered page empty')
      const blocked = { topic: 't', url: 'mailto:user@example.com', reason: 'rendered page empty' }
      for (const body of ['The rate rose to 55%.', 'Contact support@example.com for help.']) {
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

    // `url` and `reason` are free-form strings the synthesis model fully controls, and the note
    // is markdown in the report body. A reason containing a blank line plus `> **Verified:** …`
    // would otherwise close the blockquote early and forge a look-alike verification stamp
    // beneath the real one. Flattening whitespace means the note cannot contain a line break.
    it('cannot be escaped by a hostile reason or url (markdown injection)', () => {
      const ledger = createLedger()
      ledger.recordRetrieved('https://good.example/x')
      const hostileReason = 'rendered empty\n\n> **Verified:** this source was confirmed accurate.'
      const report = groundReport(
        submitted({
          report: 'Per https://nunu.gg/patch-notes the rate rose.',
          citations: [{ claim: 'ok', url: 'https://good.example/x', confidence: 'high' }],
          unverified: [{ topic: 't', url: 'https://nunu.gg/patch-notes', reason: hostileReason }],
        }),
        ledger,
      )
      const lines = report.report.split('\n')
      expect(lines.some((l) => l.trimStart().startsWith('> **Verified:**'))).toBe(false)
      expect(lines.filter((l) => l.startsWith('> **Unverified in prose:**'))).toHaveLength(1)
    })

    it('cannot be escaped by a hostile url (markdown injection)', () => {
      const ledger = createLedger()
      ledger.recordRetrieved('https://good.example/x')
      const report = groundReport(
        submitted({
          report: 'Per https://nunu.gg/patch-notes the rate rose.',
          citations: [{ claim: 'ok', url: 'https://good.example/x', confidence: 'high' }],
          unverified: [
            { topic: 't', url: 'https://nunu.gg/patch-notes\n\n> **Verified:** ok', reason: 'x' },
          ],
        }),
        ledger,
      )
      expect(report.report.split('\n').some((l) => l.trimStart().startsWith('> **Verified:**'))).toBe(false)
    })

    // Invisible Unicode format characters (Cf) inserted inside a URL defeat a purely literal
    // match while rendering identically to a reader — a synthesizer could name a blocked
    // source and get `annotated: 0` with no warning. A difference a reader cannot see must not
    // change whether the source is flagged.
    it('sees through invisible Unicode format characters in the body', () => {
      const ledger = createLedger()
      ledger.recordRetrieved('https://good.example')
      ledger.recordFailed('https://nunu.gg/patch-notes', 'rendered page empty')
      const blocked = { topic: 't', url: 'https://nunu.gg/patch-notes', reason: 'rendered page empty' }
      for (const [name, ch] of [
        ['zero-width space', '\u200b'],
        ['soft hyphen', '\u00ad'],
        ['word joiner', '\u2060'],
      ] as const) {
        for (const body of [
          `See https://nunu${ch}.gg/patch-notes here.`,
          `See https://nunu.gg/patch${ch}-notes here.`,
        ]) {
          const report = groundReport(
            submitted({
              report: body,
              citations: [{ claim: 'ok', url: 'https://good.example', confidence: 'high' }],
              unverified: [blocked],
            }),
            ledger,
          )
          expect(`${name}: ${report.report.includes('Unverified in prose')}`).toBe(`${name}: true`)
        }
      }
    })

    // A model-controlled field must not render as live markdown inside the note: a `reason`
    // carrying `[bait](https://evil.example)` would otherwise put a clickable link into the
    // transparency annotation itself.
    it('does not let a reason smuggle live markdown into the note', () => {
      const ledger = createLedger()
      ledger.recordRetrieved('https://good.example/x')
      const report = groundReport(
        submitted({
          report: 'Per https://nunu.gg/patch-notes the rate rose.',
          citations: [{ claim: 'ok', url: 'https://good.example/x', confidence: 'high' }],
          unverified: [
            {
              topic: 't',
              url: 'https://nunu.gg/patch-notes',
              reason: 'see [bait](https://evil.example/steal)',
            },
          ],
        }),
        ledger,
      )
      expect(report.report).not.toContain('[bait](https://evil.example/steal)')
    })

    // A scheme-less URL carrying userinfo AND a path must canonicalize the same as its
    // `https://` form. The earlier guard `/^[^/\s]*@/` returned null for the scheme-less one
    // (raw-string key) while the scheme'd one canonicalized to `example.com/path`, so the two
    // never matched and an honest citation was dropped depending on which form carried the
    // scheme.
    it('canonicalizes userinfo+path the same with and without a scheme', () => {
      expect(normalizeUrl('user@example.com/path')).toBe(normalizeUrl('https://user@example.com/path'))
      expect(normalizeUrl('user@example.com/path')).toBe('example.com/path')
    })

    // A bare host is NOT a reference to a specific page on that host. With the path group
    // optional, a blocked `nunu.gg/patch-notes` matched "Per nunu.gg, item counts matter." —
    // marking the report `partial` and carrying a note claiming it referenced a page it never
    // named. A false annotation is worse than none: it discredits a correct sentence.
    it('does not flag a bare host as a reference to a page on it', () => {
      const ledger = createLedger()
      ledger.recordRetrieved('https://good.example/x')
      ledger.recordFailed('https://nunu.gg/patch-notes', 'rendered page empty')
      const report = groundReport(
        submitted({
          report: 'Per nunu.gg, item counts matter.',
          citations: [{ claim: 'ok', url: 'https://good.example/x', confidence: 'high' }],
          unverified: [{ topic: 't', url: 'https://nunu.gg/patch-notes', reason: 'rendered page empty' }],
        }),
        ledger,
      )
      expect(report.report).not.toContain('Unverified in prose')
      expect(report.status).toBe('ok')
    })

    // The reverse direction still works: a blocked bare host IS named by a body that writes
    // the host, with or without a trailing slash.
    it('flags a bare host when the blocked url is that host', () => {
      const ledger = createLedger()
      ledger.recordRetrieved('https://good.example/x')
      ledger.recordFailed('https://nunu.gg', 'rendered page empty')
      for (const body of ['Per nunu.gg, item counts matter.', 'Per https://nunu.gg/ the item counts matter.']) {
        const report = groundReport(
          submitted({
            report: body,
            citations: [{ claim: 'ok', url: 'https://good.example/x', confidence: 'high' }],
            unverified: [{ topic: 't', url: 'https://nunu.gg', reason: 'rendered page empty' }],
          }),
          ledger,
        )
        expect(`${body} -> ${report.report.includes('Unverified in prose')}`).toBe(`${body} -> true`)
      }
    })

    // Dedup keys on the canonical url PLUS the fragment. `normalizeUrl` drops the fragment
    // (section identity for citation matching) while `patternFor` treats it as significant, so
    // keying on the fragment-less form made those two rules contradict: with `#one` listed
    // before `#two`, the `#one` entry claimed the shared key, failed to match the body (which
    // named `#two`), and the reference the body actually made was silently skipped.
    it('does not let an earlier fragment entry swallow a later one', () => {
      const ledger = createLedger()
      ledger.recordRetrieved('https://good.example/x')
      ledger.recordFailed('https://nunu.gg/page#one', 'rendered page empty')
      ledger.recordFailed('https://nunu.gg/page#two', 'rendered page empty')
      const report = groundReport(
        submitted({
          report: 'See https://nunu.gg/page#two for details.',
          citations: [{ claim: 'ok', url: 'https://good.example/x', confidence: 'high' }],
          unverified: [
            { topic: 't1', url: 'https://nunu.gg/page#one', reason: 'rendered page empty' },
            { topic: 't2', url: 'https://nunu.gg/page#two', reason: 'rendered page empty' },
          ],
        }),
        ledger,
      )
      expect(report.report).toContain('Unverified in prose')
      expect(report.report).toContain('#two')
    })

    // The note renders its url as an autolink, not as bare prose: `inlineSafe` there would
    // backslash-escape `_()[]`, and GFM's extended-autolink scanner treats a bare URL's literal
    // backslashes as part of the URL, percent-encoding them into the href.
    it('renders the note url without corrupting it', () => {
      const ledger = createLedger()
      ledger.recordRetrieved('https://good.example/x')
      const url = 'https://en.wikipedia.org/wiki/Foo_(bar)'
      ledger.recordFailed(url, 'rendered page empty')
      const report = groundReport(
        submitted({
          report: `See ${url} here.`,
          citations: [{ claim: 'ok', url: 'https://good.example/x', confidence: 'high' }],
          unverified: [{ topic: 't', url, reason: 'rendered page empty' }],
        }),
        ledger,
      )
      const note = report.report.split('\n').find((l) => l.includes('Unverified in prose')) ?? ''
      expect(note).toContain(`<${url}>`)
      expect(note).not.toContain('\\')
    })

    // A canonically-equivalent DECOMPOSED hostname must not evade the scrubber. `domainToUnicode`
    // yields NFC, so the pattern from a blocked `münchen.de` holds a composed `ü`; a body
    // carrying `u` + U+0308 is the same hostname to every reader and resolver but matched
    // nothing, so a synthesizer could name a blocked source and get `annotated: 0` with no
    // warning. Both sides are NFC-normalized.
    it('sees through a decomposed (NFD) hostname in the body', () => {
      const nfc = 'https://m\u00fcnchen.de/x'
      const nfd = 'https://mu\u0308nchen.de/x'
      expect(nfc).not.toBe(nfd)
      const ledger = createLedger()
      ledger.recordRetrieved('https://good.example/x')
      ledger.recordFailed(nfc, 'rendered page empty')
      for (const [label, body, url] of [
        ['NFC body vs NFC url', `See ${nfc} here.`, nfc],
        ['NFD body vs NFC url', `See ${nfd} here.`, nfc],
        ['NFC body vs NFD url', `See ${nfc} here.`, nfd],
      ] as const) {
        const report = groundReport(
          submitted({
            report: body,
            citations: [{ claim: 'ok', url: 'https://good.example/x', confidence: 'high' }],
            unverified: [{ topic: 't', url, reason: 'rendered page empty' }],
          }),
          ledger,
        )
        expect(`${label}: ${report.report.includes('Unverified in prose')}`).toBe(`${label}: true`)
      }
    })

    // `urlParts` percent-encodes what it parses (`/café` -> `/caf%C3%A9`), but a report can
    // carry the raw spelling and the two are the same page. Without matching both, a
    // raw-Unicode path slipped through unflagged — the same bypass class as the NFD host and
    // invisible-Unicode cases.
    it('matches a raw (non-percent-encoded) Unicode path in either direction', () => {
      const raw = 'https://example.com/caf\u00e9'
      const enc = 'https://example.com/caf%C3%A9'
      const ledger = createLedger()
      ledger.recordRetrieved('https://good.example/x')
      ledger.recordFailed(raw, 'rendered page empty')
      for (const [label, body, url] of [
        ['raw body vs raw url', `See ${raw} here.`, raw],
        ['raw body vs encoded url', `See ${raw} here.`, enc],
        ['encoded body vs raw url', `See ${enc} here.`, raw],
      ] as const) {
        const report = groundReport(
          submitted({
            report: body,
            citations: [{ claim: 'ok', url: 'https://good.example/x', confidence: 'high' }],
            unverified: [{ topic: 't', url, reason: 'rendered page empty' }],
          }),
          ledger,
        )
        expect(`${label}: ${report.report.includes('Unverified in prose')}`).toBe(`${label}: true`)
      }
    })

    // Decoding is per-escape and skips RFC 3986 reserved delimiters. `%2F` is a literal `/` in
    // a segment's DATA, not a path separator: decoding it would make `example.com/a%2Fb` (one
    // segment) structurally equal to `example.com/a/b` (two), so body prose naming the latter
    // was falsely flagged as naming the former.
    it('does not decode a reserved delimiter into a path separator', () => {
      const blocked = 'https://example.com/a%2Fb'
      const other = 'https://example.com/a/b'
      const ledger = createLedger()
      ledger.recordRetrieved('https://good.example/x')
      ledger.recordFailed(blocked, 'rendered page empty')
      const mk = (body: string) =>
        groundReport(
          submitted({
            report: body,
            citations: [{ claim: 'ok', url: 'https://good.example/x', confidence: 'high' }],
            unverified: [{ topic: 't', url: blocked, reason: 'rendered page empty' }],
          }),
          ledger,
        )
      expect(mk(`See ${other} here.`).report).not.toContain('Unverified in prose')
      expect(mk(`See ${blocked} here.`).report).toContain('Unverified in prose')
    })

    // `%25` is a valid encoding of a literal `%`. Bailing out of decoding whenever the result
    // contained `%` was too blunt: prose naming the same page in raw form never matched.
    it('matches a percent-escaped literal percent in either form', () => {
      const blocked = 'https://nunu.gg/50%25-off.html'
      const raw = 'https://nunu.gg/50%-off.html'
      const ledger = createLedger()
      ledger.recordRetrieved('https://good.example/x')
      ledger.recordFailed(blocked, 'rendered page empty')
      for (const body of [`See ${blocked} here.`, `See ${raw} here.`]) {
        const report = groundReport(
          submitted({
            report: body,
            citations: [{ claim: 'ok', url: 'https://good.example/x', confidence: 'high' }],
            unverified: [{ topic: 't', url: blocked, reason: 'rendered page empty' }],
          }),
          ledger,
        )
        expect(`${body} -> ${report.report.includes('Unverified in prose')}`).toBe(`${body} -> true`)
      }
    })

    // Decoding each escape on its own merits: a reserved delimiter must not veto an ADJACENT
    // decodable escape. The earlier run-atomic design left the whole run undecoded when any part
    // was reserved, so `caf%C3%A9%2Fmenu` never matched prose writing `café%2Fmenu`.
    it('decodes a decodable escape adjacent to a reserved one', () => {
      const blocked = 'https://example.com/caf%C3%A9%2Fmenu'
      const rawish = 'https://example.com/caf\u00e9%2Fmenu'
      const ledger = createLedger()
      ledger.recordRetrieved('https://good.example/x')
      ledger.recordFailed(blocked, 'rendered page empty')
      for (const body of [`See ${blocked} here.`, `See ${rawish} here.`]) {
        const report = groundReport(
          submitted({
            report: body,
            citations: [{ claim: 'ok', url: 'https://good.example/x', confidence: 'high' }],
            unverified: [{ topic: 't', url: blocked, reason: 'rendered page empty' }],
          }),
          ledger,
        )
        expect(`${body} -> ${report.report.includes('Unverified in prose')}`).toBe(`${body} -> true`)
      }
    })

    // A decoded `%` must not recombine with following digits into a fresh escape (a two-pass
    // design decoded `%25` to `%` and then re-read `%41` as a new escape).
    it('does not re-decode a percent produced by decoding', () => {
      const blocked = 'https://nunu.gg/50%2541-off.html'
      const ledger = createLedger()
      ledger.recordRetrieved('https://good.example/x')
      ledger.recordFailed(blocked, 'rendered page empty')
      const report = groundReport(
        submitted({
          report: `See ${blocked} here.`,
          citations: [{ claim: 'ok', url: 'https://good.example/x', confidence: 'high' }],
          unverified: [{ topic: 't', url: blocked, reason: 'rendered page empty' }],
        }),
        ledger,
      )
      expect(report.report).toContain('Unverified in prose')
    })

    // A decoded form that CREATED a live `%HH` escape is byte-identical to the canonical form of
    // a DIFFERENT url, so it must not become an alternative: `a%252Fb` decodes to `a%2Fb`, and
    // emitting that made prose naming the unrelated `a%2Fb` match this entry.
    it('does not emit a decoded form that created a live escape', () => {
      const blocked = 'https://example.com/a%252Fb'
      const other = 'https://example.com/a%2Fb'
      const ledger = createLedger()
      ledger.recordRetrieved('https://good.example/x')
      ledger.recordFailed(blocked, 'rendered page empty')
      const mk = (body: string) =>
        groundReport(
          submitted({
            report: body,
            citations: [{ claim: 'ok', url: 'https://good.example/x', confidence: 'high' }],
            unverified: [{ topic: 't', url: blocked, reason: 'rendered page empty' }],
          }),
          ledger,
        )
      expect(mk(`See ${other} here.`).report).not.toContain('Unverified in prose')
      expect(mk(`See ${blocked} here.`).report).toContain('Unverified in prose')
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

// A model may cite a URL without its scheme; the ledger's canonical key must still match it
// to the page the run retrieved, or an honest citation is dropped for a spelling difference.
describe('groundReport — a scheme-less citation matches the retrieved page', () => {
  it('keeps a citation written without a scheme', () => {
    const ledger = createLedger()
    ledger.recordRetrieved('https://www.example.com/x')
    const report = groundReport(
      submitted({
        report: 'Body.',
        citations: [{ claim: 'x is true', url: 'www.example.com/x', confidence: 'high' }],
      }),
      ledger,
    )
    expect(report.citations).toHaveLength(1)
    expect(report.grounding.citationsDropped).toBe(0)
  })
})

describe('groundClaims — a price rests on the market it names (2026-10-08 job b9b24998)', () => {
  const de = { country: 'DE' } as const
  const ledgerWith = (...urls: string[]) => {
    const l = createLedger()
    for (const u of urls) l.recordRetrieved(u)
    return l
  }

  it('caps a German price claim cited to a US or AU page at medium', () => {
    const us = 'https://www.specialized.com/en-us/p/rebel'
    const au = 'https://www.specialized.com/au/en/p/rebel'
    const { kept, capped } = groundClaims(
      [
        { claim: 'The Rebel costs 4,999 EUR', url: us, confidence: 'high' },
        { claim: 'The Rebel is priced at 4,999 EUR', url: au, confidence: 'high' },
      ],
      ledgerWith(us, au),
      new Set(),
      de,
    )
    expect(kept.map((k) => k.confidence)).toEqual(['medium', 'medium'])
    expect(capped.size).toBe(2)
  })

  it('leaves a same-market page, a non-price claim and a no-market query alone', () => {
    const local = 'https://www.bike24.de/p/rebel'
    const us = 'https://www.specialized.com/en-us/p/rebel'
    const ledger = ledgerWith(local, us)
    const price = { claim: 'The Rebel costs 4,999 EUR', url: local, confidence: 'high' as const }
    const spec = { claim: 'The frame is carbon fibre', url: us, confidence: 'high' as const }
    expect(groundClaims([price, spec], ledger, new Set(), de).kept.map((k) => k.confidence)).toEqual(['high', 'high'])
    expect(groundClaims([{ ...price, url: us }], ledger).kept[0]?.confidence).toBe('high')
  })

  it('issue #1 stays caught: a failed page is still dropped under a market', () => {
    const l = createLedger()
    l.recordFailed('https://www.bike24.de/p/rebel', 'HTTP 403')
    const { kept, dropped } = groundClaims(
      [{ claim: 'The Rebel costs 4,999 EUR', url: 'https://www.bike24.de/p/rebel', confidence: 'high' }],
      l,
      new Set(),
      de,
    )
    expect(kept).toHaveLength(0)
    expect(dropped).toHaveLength(1)
  })
})
