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
