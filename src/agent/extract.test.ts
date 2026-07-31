import { describe, it, expect } from 'bun:test'
import {
  normalizeText,
  capText,
  isValidReport,
  unwrapDoubleEncodedReport,
  salvageDoubleEncodedReport,
  resolveSynthesisReport,
} from './extract.js'
import type { SubmittedReport, WorkerDigest } from './schema.js'

describe('normalizeText', () => {
  it('collapses runs of spaces and tabs into a single space', () => {
    expect(normalizeText('a    b\t\tc')).toBe('a b c')
  })

  it('strips leading indentation per line', () => {
    expect(normalizeText('a\n    b\n\tc')).toBe('a\nb\nc')
  })

  it('collapses 3+ newlines down to 2, preserving paragraph breaks', () => {
    expect(normalizeText('a\n\n\n\n\nb')).toBe('a\n\nb')
    expect(normalizeText('a\n\nb')).toBe('a\n\nb')
  })

  it('preserves single paragraph breaks between sections', () => {
    const input = 'Paragraph one.\n\nParagraph two.'
    expect(normalizeText(input)).toBe('Paragraph one.\n\nParagraph two.')
  })

  it('trims leading and trailing whitespace', () => {
    expect(normalizeText('  \n  hello  \n  ')).toBe('hello')
  })

  it('keeps a table-shaped fixture legible: version and date tokens survive and stay separated', () => {
    // Mimics the padding Readability/Tavily leave behind extracting an HTML table.
    const table =
      'Version                    Release date          End of support\n\n\n\n' +
      '11.4 LTS                   2024-05-29             2029-05-29\n\n\n\n' +
      '11.8 Rolling                2025-02-17             2026-02-17\n\n\n\n' +
      'Long Term Support           —                      —'
    const normalized = normalizeText(table)

    for (const token of ['11.4', '11.8', 'LTS', 'Rolling', '2029', 'Long Term Support']) {
      expect(normalized).toContain(token)
    }
    // No run of 3+ newlines survives, and no run of 2+ spaces/tabs survives.
    expect(normalized).not.toMatch(/\n{3,}/)
    expect(normalized).not.toMatch(/[ \t]{2,}/)
    // Header and row tokens stay on separate, distinguishable lines rather than merging.
    expect(normalized).toContain('Version Release date End of support')
    expect(normalized).toContain('11.4 LTS 2024-05-29 2029-05-29')
  })

  it('is idempotent: normalizing an already-normalized string is a no-op', () => {
    const input = 'a    b\n\n\n\nc\n    d  \t e'
    const once = normalizeText(input)
    expect(normalizeText(once)).toBe(once)
  })
})

describe('capText', () => {
  it('returns input unchanged when at or under the cap', () => {
    expect(capText('hello', 10)).toBe('hello')
    expect(capText('hello', 5)).toBe('hello')
  })

  it('truncates and appends an honest notice with the real total length when over cap', () => {
    const text = 'x'.repeat(100)
    const result = capText(text, 10)
    expect(result.startsWith('x'.repeat(10))).toBe(true)
    expect(result).toContain('showing the first 10 of 100 characters')
  })

  it('the truncation notice is distinguishable from a fetch error', () => {
    const text = 'y'.repeat(50)
    const result = capText(text, 10)
    expect(result).not.toContain('unreachable')
    expect(result).not.toMatch(/^error/i)
    expect(result).toContain('[truncated:')
    expect(result).toContain('remainder was not included')
  })
})

// ── Synthesis output guard ────────────────────────────────────────────────────

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

// Long enough on its own to clear the 200-char floor in isValidReport.
const LONG_MARKDOWN =
  '# Bun\'s built-in SQLite driver\n\n' +
  'Bun ships a first-party SQLite driver exposed as `bun:sqlite`, requiring no external '.repeat(3) +
  '\n\nIt is synchronous and built on top of the native SQLite C library.'

describe('unwrapDoubleEncodedReport', () => {
  it('unwraps a JSON-stringified submission into its inner report text', () => {
    const payload = JSON.stringify({
      report: LONG_MARKDOWN,
      citations: [{ claim: 'a', url: 'https://bun.sh/docs/api/sqlite', confidence: 'high' }],
      sources: ['https://bun.sh/docs/api/sqlite'],
      unverified: [],
    })
    expect(unwrapDoubleEncodedReport(payload)).toBe(LONG_MARKDOWN)
  })

  it('returns null for plain markdown, even markdown containing a JSON code fence', () => {
    const markdown = `${LONG_MARKDOWN}\n\nExample config:\n\n\`\`\`json\n{"foo": "bar"}\n\`\`\`\n\nMore prose after the fence.`
    expect(unwrapDoubleEncodedReport(markdown)).toBeNull()
  })

  it('returns null for markdown that merely contains a brace character', () => {
    const markdown = `${LONG_MARKDOWN}\n\nThe config object looks like { key: value } in this format.`
    expect(unwrapDoubleEncodedReport(markdown)).toBeNull()
  })

  it('returns null when the whole string is JSON but has no report field', () => {
    expect(unwrapDoubleEncodedReport(JSON.stringify({ citations: [], sources: [] }))).toBeNull()
  })

  it('returns null when the whole string is JSON but does not look like a submission (no citations/sources array)', () => {
    expect(unwrapDoubleEncodedReport(JSON.stringify({ report: LONG_MARKDOWN }))).toBeNull()
  })

  it('returns null on malformed JSON that merely starts and ends with braces', () => {
    expect(unwrapDoubleEncodedReport('{ not actually json, just prose in braces }')).toBeNull()
  })

  it('returns null on an empty or whitespace-only string', () => {
    expect(unwrapDoubleEncodedReport('')).toBeNull()
    expect(unwrapDoubleEncodedReport('   ')).toBeNull()
  })
})

describe('salvageDoubleEncodedReport', () => {
  it('keeps the outer citations/sources/unverified, replacing only the report text', () => {
    const citations = [{ claim: 'a', url: 'https://bun.sh/docs/api/sqlite', confidence: 'high' as const }]
    const sources = ['https://bun.sh/docs/api/sqlite']
    const report: SubmittedReport = {
      report: JSON.stringify({ report: LONG_MARKDOWN, citations, sources, unverified: [] }),
      citations,
      sources,
      unverified: [],
    }
    const salvaged = salvageDoubleEncodedReport(report)
    expect(salvaged?.report).toBe(LONG_MARKDOWN)
    expect(salvaged?.citations).toBe(citations)
    expect(salvaged?.sources).toBe(sources)
  })

  it('returns null for a report with no double-encoding', () => {
    const report: SubmittedReport = {
      report: LONG_MARKDOWN,
      citations: [{ claim: 'a', url: 'https://a.example', confidence: 'high' }],
      sources: ['https://a.example'],
      unverified: [],
    }
    expect(salvageDoubleEncodedReport(report)).toBeNull()
  })
})

describe('resolveSynthesisReport — the guard as a whole', () => {
  // The exact production defect: schema fields filled correctly AND the whole submission
  // re-serialized into report.report.
  it('salvages the observed double-encoded shape, surfacing the inner markdown', () => {
    const citations = [{ claim: 'a', url: 'https://bun.sh/docs/api/sqlite', confidence: 'high' as const }]
    const sources = ['https://bun.sh/docs/api/sqlite']
    const report: SubmittedReport = {
      report: JSON.stringify({ report: LONG_MARKDOWN, citations, sources, unverified: [] }),
      citations,
      sources,
      unverified: [],
    }
    const resolved = resolveSynthesisReport(report, [digest()])
    expect(resolved.salvaged).toBe(true)
    expect(resolved.report?.report).toBe(LONG_MARKDOWN)
    expect(resolved.report?.citations).toEqual(citations)
    expect(resolved.report?.sources).toEqual(sources)
  })

  // Regression guard against over-eager unwrapping: a normal clean report must pass
  // through completely untouched.
  it('leaves a normal clean report untouched', () => {
    const report: SubmittedReport = {
      report: LONG_MARKDOWN,
      citations: [{ claim: 'a', url: 'https://a.example', confidence: 'high' }],
      sources: ['https://a.example'],
      unverified: [],
    }
    const resolved = resolveSynthesisReport(report, [digest()])
    expect(resolved.salvaged).toBe(false)
    expect(resolved.report).toEqual(report)
  })

  it('still rejects a genuine schema-echo (no double-encoding to salvage)', () => {
    const report: SubmittedReport = {
      report: 'string',
      citations: [],
      sources: [],
      unverified: [],
    }
    const resolved = resolveSynthesisReport(report, [
      digest({ findings: [{ claim: 'x', url: 'https://a.example', confidence: 'high' }] }),
    ])
    expect(resolved.salvaged).toBe(false)
    expect(resolved.report).toBeNull()
  })

  // A naive `startsWith('{')`/"contains a brace" check would corrupt this — it is
  // legitimate markdown that happens to quote a JSON snippet, not a double-encoded report.
  it('does not mangle a legitimate markdown report that merely contains a JSON code fence', () => {
    const markdown = `${LONG_MARKDOWN}\n\nExample response body:\n\n\`\`\`json\n{"status": "ok"}\n\`\`\`\n\nAnalysis continues here.`
    const report: SubmittedReport = {
      report: markdown,
      citations: [{ claim: 'a', url: 'https://a.example', confidence: 'high' }],
      sources: ['https://a.example'],
      unverified: [],
    }
    const resolved = resolveSynthesisReport(report, [digest()])
    expect(resolved.salvaged).toBe(false)
    expect(resolved.report?.report).toBe(markdown)
  })
})

describe('isValidReport — schema-echo guard (unchanged behaviour)', () => {
  it('rejects the literal schema echo', () => {
    expect(isValidReport({ report: 'string', citations: [], sources: [], unverified: [] }, [])).toBe(false)
  })

  it('rejects a report under the length floor', () => {
    expect(isValidReport({ report: 'too short', citations: [], sources: [], unverified: [] }, [])).toBe(false)
  })

  it('rejects zero citations when digests carried findings', () => {
    const withFindings = digest({ findings: [{ claim: 'x', url: 'https://a.example', confidence: 'high' }] })
    expect(isValidReport({ report: LONG_MARKDOWN, citations: [], sources: [], unverified: [] }, [withFindings])).toBe(
      false,
    )
  })

  it('accepts a normal, sufficiently long, cited report', () => {
    expect(
      isValidReport(
        { report: LONG_MARKDOWN, citations: [{ claim: 'a', url: 'https://a.example', confidence: 'high' }], sources: [], unverified: [] },
        [],
      ),
    ).toBe(true)
  })
})
