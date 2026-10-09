import { describe, it, expect } from 'bun:test'
import { claimNumbers, extractNumbers, unmatchedNumbers } from './numbers.js'

// wrchina.gg/c/pyke/ as Readability delivered it on 2026-09-26 (trimmed): the item-set table
// (WR + use) and the Top-30 presence table. "5,565" occurs nowhere on the page.
const PYKE_PAGE = `Most-used builds on the China server (Diamond+)
Support
Core items
49.8% WR
41.78% use
Black Mist Scythe
Youmuu's Ghostblade
Serpent's Fang
55.1% WR
8.41% use
Most-used items & runes · from our Top-30 screenshots
Counted on 23 real builds captured from the Chinese client, player by player.
Youmuu's Ghostblade
96%
Armorcrusher Boots
83%
Unflinching
70%`

describe('claimNumbers', () => {
  it('picks percentages, decimals and counts ≥ 100', () => {
    const got = claimNumbers('Top-win item at ~83% win over ~5,565 matches, 55.1% WR, 1,234.5 gold')
    expect(got.map((n) => n.raw)).toEqual(['~83%', '~5,565', '55.1%', '1,234.5'])
    expect(got[1]).toMatchObject({ value: 5565, decimals: 0, approximate: true })
  })

  it('skips versions, years, dates, small counts, glued units and URLs', () => {
    const claim =
      'Patch 7.3 (Season S23, v2.1.0) on 2026-09-24 in 2026: 6-slot builds from 23 players, 4K video, 5k games, 2x damage, see https://example.com/c/123456/'
    expect(claimNumbers(claim)).toEqual([])
    // Measured 2026-09-26: a version with no "patch" in front of it.
    expect(claimNumbers('Gargoyle Stoneplate is not in the supplied 7.3 item table; 1.25 seconds')).toEqual([])
  })

  it('keeps both sides of a WR/use pair', () => {
    expect(claimNumbers('54.3%/27.81% use').map((n) => n.raw)).toEqual(['54.3%', '27.81%'])
  })
})

describe('extractNumbers', () => {
  it('reads thousands separators and a German decimal comma every plausible way', () => {
    const got = extractNumbers('5,565 games · 5.565 Spiele · 55,1 %')
    expect(got).toContain(5565)
    expect(got).toContain(5.565)
    expect(got).toContain(55.1)
  })

  it('never reads a decimal comma or a decimal point as a thousands separator (review)', () => {
    expect(extractNumbers('55,1 %')).not.toContain(551)
    expect(extractNumbers('55.1%')).not.toContain(551)
    expect(extractNumbers('2,565.7')).toEqual([2565.7])
  })
})

describe('unmatchedNumbers — the 2026-09-26 Pyke report', () => {
  const page = extractNumbers(PYKE_PAGE)

  it('flags the invented match count', () => {
    expect(unmatchedNumbers('Top-win item in CN Diamond+ data at ~83% win over ~5,565 matches', page)).toEqual([
      '~5,565',
    ])
  })

  it('passes numbers that are on the page, including a rounded restatement', () => {
    expect(unmatchedNumbers('Youmuu 96%, core set 49.8% WR / 41.78% use, top set ~55% WR', page)).toEqual([])
    expect(unmatchedNumbers('the 55.1% set', page)).toEqual([])
  })

  it('does not accept a more precise figure than the page gives', () => {
    expect(unmatchedNumbers('Youmuu 96.4%', page)).toEqual(['96.4%'])
  })

  it('tolerates ±2% only for an explicitly approximate figure', () => {
    expect(unmatchedNumbers('about 50% WR', page)).toEqual([]) // 49.8
    expect(unmatchedNumbers('48% WR', page)).toEqual(['48%'])
  })
})

describe('unmatchedNumbers — 2026-10-09 false positives', () => {
  it('treats digits in the cited URL as found (Canyon-ID)', () => {
    const claim = 'Canyon-ID 4392 is the Endurace CF 7'
    expect(unmatchedNumbers(claim, [1], 'https://www.canyon.com/de-de/endurace/canyon_4392.html')).toEqual([])
    expect(unmatchedNumbers(claim, [1])).toEqual(['4392'])
  })

  it('exempts an HTTP status quoted as the response itself', () => {
    expect(unmatchedNumbers('The URL returns 404 and no CSV exists', [1])).toEqual([])
    expect(unmatchedNumbers('HTTP 410 for the old endpoint', [1])).toEqual([])
    expect(unmatchedNumbers('The server answered with 404 (not found)', [1])).toEqual([])
  })

  it('still checks a 4xx-looking figure that is a measurement', () => {
    expect(unmatchedNumbers('The bike weighs 404 grams', [1])).toEqual(['404'])
  })
})

describe('percentage-conversion constant', () => {
  it('does not report the 100 of "*100" as an unmatched figure', () => {
    expect(unmatchedNumbers('-45.7%: (572.319-1054.796)/1054.796*100', [572.319, 1054.796])).toEqual(['45.7%'])
  })

  it('exempts the multiplication spellings', () => {
    for (const claim of ['change = (a/b) * 100', 'change = (a/b) × 100', 'change = (a/b)×100', 'change = (a/b) x 100', 'change = (a/b) x100'])
      expect(unmatchedNumbers(claim, [1])).toEqual([])
  })

  it('still checks a standalone 100', () => {
    expect(unmatchedNumbers('The index reached 100 points', [1])).toEqual(['100'])
    expect(unmatchedNumbers('Revenue was 100 in 2020 and 200 in 2021', [1])).toEqual(['100', '200'])
  })

  it('exempts the factor of a spaced division formula', () => {
    expect(unmatchedNumbers('change = a / b * 100', [1])).toEqual([])
    expect(unmatchedNumbers('(572.319-1054.796)/1054.796 × 100', [572.319, 1054.796])).toEqual([])
  })

  it('checks a 100 that is a quantity, not a formula factor', () => {
    expect(unmatchedNumbers('3 * 100 items in stock', [1])).toEqual(['100'])
    expect(unmatchedNumbers('**100** riders', [1])).toEqual(['100'])
    expect(unmatchedNumbers('2 x 100 meters', [1])).toEqual(['100'])
    expect(unmatchedNumbers('(a/b) * 100% of riders', [1])).toEqual(['100%'])
  })

  it('still checks other factors after a multiplication sign', () => {
    expect(unmatchedNumbers('value = a*1000', [1])).toEqual(['1000'])
  })
})

describe('status exemption boundaries', () => {
  it('still checks counts of responses/errors', () => {
    expect(unmatchedNumbers('The survey got 500 responses', [1])).toEqual(['500'])
    expect(unmatchedNumbers('We logged 404 errors this week', [1])).toEqual(['404'])
    expect(unmatchedNumbers('The search returned 500 results', [1])).toEqual(['500'])
    expect(unmatchedNumbers('The API returns 429 items per page', [1])).toEqual(['429'])
  })

  it('exempts a verb-quoted status that ends the phrase', () => {
    expect(unmatchedNumbers('The old URL returned 410.', [1])).toEqual([])
    expect(unmatchedNumbers('It responded with a 503 when overloaded', [1])).toEqual([])
  })
})
