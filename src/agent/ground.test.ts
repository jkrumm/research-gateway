import { describe, it, expect } from 'bun:test'
// Imported directly from the pure modules (no `env.js` chain) — same convention as
// run.test.ts. See the note at the top of assemble.ts.
import { createLedger, mergeLedgers, normalizeUrl } from './ledger.js'
import { groundClaims, groundDigest, groundReport, degradeClaimsOnUnverifiedSources } from './ground.js'
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
      const { kept, degradedCount } = degradeClaimsOnUnverifiedSources(
        [{ claim: 'the Module:Items page is stale', url: 'https://mirror.example/Module:Items', confidence: 'low' }],
        [{ topic: 'Module:Items wiki page', url: 'https://wiki.example/Module:Items' }],
      )
      expect(kept[0]?.confidence).toBe('low')
      expect(degradedCount).toBe(0)
    })

    it('matches subject tokens from the URL path, not the host', () => {
      const { kept } = degradeClaimsOnUnverifiedSources(
        [{ claim: 'Module:Items is stale and unusable', url: 'https://other.example/x', confidence: 'high' }],
        [{ topic: 'bulk delete docs', url: 'https://wiki.example/Module:Items?action=raw' }],
      )
      expect(kept[0]?.confidence).toBe('low')
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
