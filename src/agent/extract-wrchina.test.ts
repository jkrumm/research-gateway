import { describe, it, expect } from 'bun:test'
import { extractText } from './html-parse.js'

// The two tables of wrchina.gg/c/pyke/ as served 2026-09-26, trimmed to two entries each —
// same classes, same nesting, same order (stat line before the set's items).
const icon = (name: string, title = name, pct = '') =>
  `<div class='bicon' title='${title.replace(/'/g, '&#x27;')}'><img alt='${name}'><div class='bicon-lbl'>${name}</div>${pct ? `<div class='t30-pct'>${pct}</div>` : ''}</div>`
const PYKE = `<html><body><main id='ssr'>
<h1>Pyke Wild Rift Build — Patch 7.3</h1>
<p>How the strongest players on the Wild Rift China server build Pyke: live win/pick statistics by rank bracket, the most-used item and rune sets, and the real loadouts of the top ranked Pyke players, captured in-game.</p>
<h2>Most-used builds on the China server (Diamond+)</h2>
<div class='bgrid'><div class='bvariant'><h3>Support</h3>
<div class='bk'>Core items</div>
<div class='combo'><div class='cstat'><b>49.8%</b> WR<br><i>41.78%</i> use</div><div class='bicons'>${icon('Black Mist Scythe')}${icon("Youmuu's Ghostblade")}${icon("Serpent's Fang")}</div></div>
<div class='combo'><div class='cstat'><b>55.1%</b> WR<br><i>8.41%</i> use</div><div class='bicons'>${icon('Black Mist Scythe')}${icon("Serpent's Fang")}${icon("Youmuu's Ghostblade")}</div></div>
<div class='bk'>Runes</div>
<div class='combo'><div class='cstat'><b>50.9%</b> WR<br><i>51.22%</i> use</div><div class='bicons'>${icon('Ice Overlord')}${icon('Unflinching')}</div></div>
</div></div>
<h2>Most-used items &amp; runes · from our Top-30 screenshots</h2>
<p class='sub'>Counted on 23 real builds captured from the Chinese client, player by player. Independent from the official API above.</p>
<div class='bvariant'><div class='bk'>Items</div><div class='bicons'>${icon("Youmuu's Ghostblade", "Youmuu's Ghostblade · 22/23", '96%')}${icon('Armorcrusher Boots', 'Armorcrusher Boots · 19/23', '83%')}</div>
<div class='bk'>Runes</div><div class='bicons'>${icon('Unflinching', 'Unflinching · 16/23', '70%')}</div></div>
<div class='dan-lbl'>Diamond+</div>
<table class='stat-table'><tr><th>Lane</th><th>Tier</th><th>Win%</th><th>Pick%</th><th>Ban%</th><th>Pos.</th></tr>
<tr><td>Support</td><td><span class='tb tier-B'>B</span></td><td>50.39%</td><td>3.88%</td><td>2.66%</td><td>#14 / 31</td></tr>
</table>
</main></body></html>`

describe('wrchina.gg reader — every percentage says what it measures', () => {
  it('labels set win/use rates and top-player presence, then reads through Readability', async () => {
    const { via, text } = await extractText('https://wrchina.gg/c/pyke/', PYKE)
    expect(via).toBe('readability') // annotate-only: the adapter returns null by design
    expect(text).toContain(
      "Core items set Black Mist Scythe + Serpent's Fang + Youmuu's Ghostblade: 55.1% win rate, used in 8.41% of those games",
    )
    expect(text).toContain('Runes set Ice Overlord + Unflinching: 50.9% win rate')
    expect(text).toContain("Youmuu's Ghostblade: in 22 of 23 top-player builds (96%) — how often top players pick it, not a win rate.")
    expect(text).toContain('Armorcrusher Boots: in 19 of 23 top-player builds (83%)')
    expect(text).toContain('Unflinching: in 16 of 23 top-player builds (70%)')
    expect(text).toContain('Diamond+: Lane Support, Tier B, Win% 50.39%, Pick% 3.88%, Ban% 2.66%, Pos. #14 / 31.')
  })

  it('leaves other hosts alone', async () => {
    const { text } = await extractText('https://example.com/c/pyke/', PYKE)
    expect(text).not.toContain('top-player builds (96%)')
  })
})
