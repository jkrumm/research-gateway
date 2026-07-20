import { describe, it, expect } from 'bun:test'
import { normalizeText, capText } from './extract.js'

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
