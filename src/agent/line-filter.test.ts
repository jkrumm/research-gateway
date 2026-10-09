import { describe, expect, test } from 'bun:test'
import { TEXT_CAP } from './extract.js'
import { filterLines, filterVariant, isLineOrientedContentType, MAX_LINE_TERMS, normalizeTerms } from './line-filter.js'

// A population.csv shaped like the live case (the real one was 557 KB): countries alphabetically, Germany deep
// inside it, far past the 80k-char cut.
export function populationCsv(): string {
  const countries = ['Afghanistan', 'Brazil', 'Canada', 'Denmark', 'Germany', 'Hungary', 'India', 'Japan']
  const rows = ['country,year,population']
  for (const c of countries) {
    for (let year = 1800; year < 2025; year++) {
      for (let i = 0; i < 6; i++) rows.push(`${c},${year},${1_000_000 + year * 7 + i}`)
    }
  }
  return rows.join('\n')
}

describe('fixture', () => {
  test('is large enough that the unfiltered read would be cut', () => {
    expect(populationCsv().length).toBeGreaterThan(200_000)
  })
})

describe('filterLines', () => {
  const csv = populationCsv()

  test('returns the header plus only matching lines, in original order', () => {
    const r = filterLines(csv, ['germany'], TEXT_CAP)
    const lines = r.text.split('\n')
    expect(lines[0]).toBe('country,year,population')
    expect(lines[1]).toBe(`Germany,1800,${1_000_000 + 1800 * 7}`)
    expect(r.matched).toBe(225 * 6)
    expect(r.text).not.toContain('Brazil')
    expect(r.text).not.toContain('Japan')
    const years = lines.filter((l) => l.startsWith('Germany,')).map((l) => Number(l.split(',')[1]))
    expect(years).toEqual([...years].sort((a, b) => a - b))
  })

  test('matches case-insensitively and across any of several terms', () => {
    const r = filterLines(csv, ['GERMANY,2024', 'japan,1800'], TEXT_CAP)
    const lines = r.text.split('\n')
    expect(lines.filter((l) => /^(Germany,2024|Japan,1800),/.test(l)).length).toBe(12)
    expect(r.matched).toBe(12)
  })

  test('respects the cap and says how many matching lines did not fit', () => {
    const r = filterLines(csv, ['germany'], 5_000)
    expect(r.text.length).toBeLessThanOrEqual(5_000)
    expect(r.omitted).toBeGreaterThan(0)
    expect(r.text).toContain(`${r.omitted} further matching lines did not fit`)
    expect(r.text.startsWith('country,year,population\n')).toBe(true)
  })

  test('stays within the page-text cap on the full fixture', () => {
    expect(filterLines(csv, ['a'], TEXT_CAP).text.length).toBeLessThanOrEqual(TEXT_CAP)
  })

  test('no match returns the header and a clear note, not an empty page', () => {
    const r = filterLines(csv, ['atlantis'], TEXT_CAP)
    expect(r.matched).toBe(0)
    expect(r.text.startsWith('country,year,population\n')).toBe(true)
    expect(r.text).toContain('no lines matched "atlantis"')
    expect(r.text).toContain('NOT returned')
  })

  test('the header line is never duplicated when it matches too', () => {
    const r = filterLines('country,pop\nGermany,83\nFrance,68', ['country', 'germany'], TEXT_CAP)
    expect(r.text.split('\n').filter((l) => l === 'country,pop').length).toBe(1)
    expect(r.matched).toBe(1)
  })

  test('handles CRLF and JSON-lines', () => {
    const r = filterLines('{"id":0}\r\n{"id":1,"c":"de"}\r\n{"id":2,"c":"fr"}', ['"de"'], TEXT_CAP)
    expect(r.text.split('\n').slice(0, 2)).toEqual(['{"id":0}', '{"id":1,"c":"de"}'])
  })

  test('a header longer than the cap is cut rather than overflowing it', () => {
    const r = filterLines(`${'h'.repeat(10_000)}\nrow`, ['row'], 2_000)
    expect(r.text.length).toBeLessThanOrEqual(2_000)
  })
})

describe('normalizeTerms / filterVariant', () => {
  test('trims, lower-cases, de-duplicates and drops empties', () => {
    expect(normalizeTerms([' Germany ', 'germany', '', '   ', 'FR'])).toEqual(['germany', 'fr'])
  })

  test('caps the number of terms', () => {
    expect(normalizeTerms(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toHaveLength(MAX_LINE_TERMS)
  })

  test('absent or empty means no filter', () => {
    expect(normalizeTerms(undefined)).toEqual([])
    expect(filterVariant([])).toBe('')
  })

  test('the variant is order-independent', () => {
    expect(filterVariant(['b', 'a'])).toBe(filterVariant(['a', 'b']))
    expect(filterVariant(['a'])).not.toBe(filterVariant(['b']))
  })
})

describe('isLineOrientedContentType', () => {
  test('accepts record-per-line types', () => {
    for (const t of ['text/csv; charset=utf-8', 'TEXT/PLAIN', 'text/tab-separated-values', 'application/x-ndjson', 'application/jsonl'])
      expect(isLineOrientedContentType(t)).toBe(true)
  })

  test('rejects documents', () => {
    for (const t of ['text/html', 'application/json', 'application/xml', 'application/pdf', '', null, undefined])
      expect(isLineOrientedContentType(t)).toBe(false)
  })
})
