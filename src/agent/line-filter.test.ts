import { describe, expect, test } from 'bun:test'
import { readBoundedLines } from '../lib/bounded-read.js'
import { TEXT_CAP } from './extract.js'
import {
  filterVariant,
  isLineOrientedResource,
  formatLineScan,
  FILTER_MAX_CHARS,
  lineMatcher,
  lineScanBudget,
  isLineOrientedContentType,
  MAX_LINE_TERMS,
  normalizeTerms,
  oversizedPrefix,
} from './line-filter.js'

// The production path in miniature: the stream budgeted by lineScanBudget, then the formatter.
async function filterLines(text: string, terms: readonly string[], maxChars: number) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
  const scan = await readBoundedLines(body, { isMatch: lineMatcher(terms), keepChars: (header) => lineScanBudget(header, terms, maxChars) })
  return formatLineScan(scan, terms, maxChars)
}

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

  test('returns the header plus only matching lines, in original order', async () => {
    const r = await filterLines(csv, ['germany'], TEXT_CAP)
    const lines = r.text.split('\n')
    expect(lines[0]).toBe('country,year,population')
    expect(lines[1]).toBe(`Germany,1800,${1_000_000 + 1800 * 7}`)
    expect(r.matched).toBe(225 * 6)
    expect(r.text).not.toContain('Brazil')
    expect(r.text).not.toContain('Japan')
    const years = lines.filter((l) => l.startsWith('Germany,')).map((l) => Number(l.split(',')[1]))
    expect(years).toEqual([...years].sort((a, b) => a - b))
  })

  test('matches case-insensitively and across any of several terms', async () => {
    const r = await filterLines(csv, ['GERMANY,2024', 'japan,1800'], TEXT_CAP)
    const lines = r.text.split('\n')
    expect(lines.filter((l) => /^(Germany,2024|Japan,1800),/.test(l)).length).toBe(12)
    expect(r.matched).toBe(12)
  })

  test('respects the cap and says how many matching lines did not fit', async () => {
    const r = await filterLines(csv, ['germany'], 5_000)
    expect(r.text.length).toBeLessThanOrEqual(5_000)
    expect(r.omitted).toBeGreaterThan(0)
    expect(r.text).toContain(`${r.omitted} further matching lines did not fit`)
    expect(r.text.startsWith('country,year,population\n')).toBe(true)
  })

  test('stays within the page-text cap on the full fixture', async () => {
    expect((await filterLines(csv, ['a'], TEXT_CAP)).text.length).toBeLessThanOrEqual(TEXT_CAP)
  })

  test('no match returns the header and a clear note, not an empty page', async () => {
    const r = await filterLines(csv, ['atlantis'], TEXT_CAP)
    expect(r.matched).toBe(0)
    expect(r.text.startsWith('country,year,population\n')).toBe(true)
    expect(r.text).toContain('no lines matched "atlantis"')
    expect(r.text).toContain('NOT returned')
  })

  test('the header line is never duplicated when it matches too', async () => {
    const r = await filterLines('country,pop\nGermany,83\nFrance,68', ['country', 'germany'], TEXT_CAP)
    expect(r.text.split('\n').filter((l) => l === 'country,pop').length).toBe(1)
    expect(r.matched).toBe(1)
  })

  test('handles CRLF and JSON-lines', async () => {
    const r = await filterLines('{"id":0}\r\n{"id":1,"c":"de"}\r\n{"id":2,"c":"fr"}', ['"de"'], TEXT_CAP)
    expect(r.text.split('\n').slice(0, 2)).toEqual(['{"id":0}', '{"id":1,"c":"de"}'])
  })

  test('a header longer than the cap is cut rather than overflowing it', async () => {
    const r = await filterLines(`${'h'.repeat(10_000)}\nrow`, ['row'], 2_000)
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

describe('formatLineScan', () => {
  test('says when a download ceiling stopped the scan', () => {
    const r = formatLineScan(
      { header: 'a,b', matches: ['Germany,1'], tail: [], matched: 1, searched: 10, stoppedAtBytes: 128 * 1_048_576 },
      ['germany'],
      TEXT_CAP,
    )
    expect(r.text).toContain('stopped after 128 MB')
    expect(r.text).toContain('later lines were NOT searched')
  })

  test('counts matches beyond what the stream kept as omitted', () => {
    const r = formatLineScan({ header: 'h', matches: ['Germany,1'], tail: [], matched: 5, searched: 9 }, ['germany'], TEXT_CAP)
    expect(r.omitted).toBe(4)
  })
})

describe('formatLineScan head and tail', () => {
  const wide = (i: number): string => `China,${1800 + i},${'x'.repeat(1_000)}`
  const manyRows = Array.from({ length: 600 }, (_, i) => wide(i))

  test('many matches: header + head + omitted line + tail, within the cap', async () => {
    const r = await filterLines(['country,year,pad', ...manyRows].join('\n'), ['china'], FILTER_MAX_CHARS)
    expect(r.text.length).toBeLessThanOrEqual(FILTER_MAX_CHARS)
    const lines = r.text.split('\n')
    expect(lines[0]).toBe('country,year,pad')
    expect(lines[1]).toStartWith('China,1800,')
    const gap = lines.findIndex((l) => l.startsWith('[… '))
    expect(gap).toBeGreaterThan(1)
    expect(lines[gap]).toBe(`[… ${r.omitted} matching lines omitted — add a narrower term (e.g. a name plus a year: "name,2024") …]`)
    expect(lines[gap + 1]).toStartWith('China,')
    expect(r.text).toContain(`China,${1800 + 599},`) // the latest row survives
    const shown = lines.filter((l) => l.startsWith('China,'))
    expect(r.omitted).toBe(600 - shown.length)
    // head and tail are both non-empty and in original order
    const years = shown.map((l) => Number(l.split(',')[1]))
    expect(years).toEqual([...years].sort((a, b) => a - b))
    expect(gap - 1).toBeGreaterThan(0)
    expect(lines.length - gap - 1).toBeGreaterThan(3)
  })

  test('few matches: unchanged, no omitted line', async () => {
    const r = await filterLines(['h', 'China,1', 'India,2', 'China,3'].join('\n'), ['china'], FILTER_MAX_CHARS)
    expect(r.text.startsWith('h\nChina,1\nChina,3\n\n[line filter')).toBe(true)
    expect(r.text).not.toContain('[… ')
    expect(r.omitted).toBe(0)
  })

  test('a stream that kept head + ring is formatted the same way, and counts what it lost', () => {
    const r = formatLineScan(
      { header: 'h', matches: ['A,1', 'A,2'], tail: ['A,9', 'A,10'], matched: 10, searched: 20 },
      ['a'],
      FILTER_MAX_CHARS,
    )
    expect(r.text.split('\n').slice(0, 6)).toEqual(['h', 'A,1', 'A,2', '[… 6 matching lines omitted — add a narrower term (e.g. a name plus a year: "name,2024") …]', 'A,9', 'A,10'])
    expect(r.omitted).toBe(6)
  })

  test('everything the stream stored fitting still reports the loss between head and ring', () => {
    const r = formatLineScan({ header: 'h', matches: ['A,1'], tail: ['A,9'], matched: 5, searched: 5 }, ['a'], FILTER_MAX_CHARS)
    expect(r.text.split('\n').slice(0, 4)).toEqual(['h', 'A,1', '[… 3 matching lines omitted — add a narrower term (e.g. a name plus a year: "name,2024") …]', 'A,9'])
  })

  test('matches exceed the head room and the ring is populated: no stored line duplicated or dropped', async () => {
    const r = await filterLines(['h', ...manyRows].join('\n'), ['china'], FILTER_MAX_CHARS)
    const shown = r.text.split('\n').filter((l) => l.startsWith('China,'))
    expect(new Set(shown).size).toBe(shown.length)
    expect(shown.length + r.omitted).toBe(600)
    expect(r.omitted).toBeGreaterThan(0)
    // Every shown row is a whole stored row, never re-truncated.
    expect(shown.every((l) => l.length === wide(0).length)).toBe(true)
    // Head rows are the first N, tail rows the last M, nothing between them shown.
    const years = shown.map((l) => Number(l.split(',')[1]) - 1800)
    const gapAt = years.findIndex((y, i) => i > 0 && y !== years[i - 1]! + 1)
    expect(years.slice(0, gapAt)).toEqual(Array.from({ length: gapAt }, (_, i) => i))
    expect(years.slice(gapAt)).toEqual(Array.from({ length: years.length - gapAt }, (_, i) => 600 - (years.length - gapAt) + i))
    expect(r.omitted).toBe(600 - years.length)
  })

  test('the delivered text is exactly what the note counts (ledger invariant)', async () => {
    const r = await filterLines(['h', ...manyRows].join('\n'), ['china'], FILTER_MAX_CHARS)
    const shown = r.text.split('\n').filter((l) => l.startsWith('China,')).length
    expect(r.text).toContain(`showing ${shown}.`)
  })
})

describe('formatLineScan size', () => {
  const MAX = 24_000
  // Digit-count edges of the note: `kept` as long as `matched`, one digit short of it, and far short.
  for (const [matched, kept] of [
    [5000, 500],
    [9, 9],
    [10, 9],
    [99_999, 999],
  ] as const) {
    test(`matched ${matched} / kept ${kept} fits maxChars`, () => {
      const header = 'country,year,pad'
      const budget = lineScanBudget(header, ['china'], MAX)
      const rowLen = Math.floor(budget / kept) - 1
      const matches = Array.from({ length: kept }, (_, i) => `${i}`.padEnd(rowLen, 'x'))
      const half = Math.floor(kept / 2)
      const r = formatLineScan(
        { header, matches: matches.slice(0, half), tail: matches.slice(half), matched, searched: matched * 10, stoppedAtBytes: 128 * 1_048_576 },
        ['china'],
        MAX,
      )
      expect(r.text.length).toBeLessThanOrEqual(MAX)
    })
  }

  test('an over-long header is cut to leave the note its room', () => {
    const r = formatLineScan({ header: 'h'.repeat(30_000), matches: [], tail: [], matched: 0, searched: 3 }, ['china'], MAX)
    expect(r.text.length).toBeLessThanOrEqual(MAX)
    expect(lineScanBudget('h'.repeat(30_000), ['china'], MAX)).toBe(0)
  })

  test('a single matching line wider than half the budget still comes through whole', async () => {
    const wideLine = `China,1,${'x'.repeat(MAX * 0.6)}`
    const r = await filterLines(['h', wideLine, 'India,2'].join('\n'), ['china'], MAX)
    expect(r.text).toContain(wideLine)
    expect(r.omitted).toBe(0)
    expect(r.text.length).toBeLessThanOrEqual(MAX)
  })
})

describe('oversizedPrefix', () => {
  const body = populationCsv()

  test('returns the header and whole leading lines within the cap, plus a note naming `lines`', () => {
    const text = oversizedPrefix(body.slice(0, 500_000), 8 * 1_048_576, TEXT_CAP)
    expect(text.length).toBeLessThanOrEqual(TEXT_CAP)
    expect(text.startsWith('country,year,population\nAfghanistan,1800,')).toBe(true)
    expect(text).toContain('larger than 8 MB')
    expect(text).toContain('`lines`')
    const rows = text.split('\n\n[this file')[0]!.split('\n')
    expect(rows.every((l) => l.split(',').length === 3)).toBe(true) // no half line
  })

  test('drops a trailing partial line from a byte-cut read', () => {
    const text = oversizedPrefix('h\nr1\nr2\nr3-par', 100, TEXT_CAP)
    expect(text.split('\n\n[')[0]).toBe('h\nr1\nr2\nr3-par'.slice(0, 'h\nr1\nr2'.length))
  })
})

describe('isLineOrientedResource', () => {
  test('a declared line-oriented type wins', () => {
    expect(isLineOrientedResource('text/csv', 'https://a.test/x')).toBe(true)
  })
  test('a missing or generic type falls back to the URL extension', () => {
    expect(isLineOrientedResource(null, 'https://a.test/data/owid-co2-data.csv')).toBe(true)
    expect(isLineOrientedResource('application/octet-stream', 'https://a.test/x.tsv?dl=1')).toBe(true)
    expect(isLineOrientedResource(null, 'https://a.test/page')).toBe(false)
  })
  test('a declared non-line type is never overridden by the extension', () => {
    expect(isLineOrientedResource('text/html', 'https://a.test/x.csv')).toBe(false)
    expect(isLineOrientedResource('application/pdf', 'https://a.test/x.csv')).toBe(false)
  })
})
