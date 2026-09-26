// wrchina.gg champion pages — label every percentage with what it measures, then let
// Readability read the page as usual.
//
// Measured 2026-09-26 (consumer round 3, the Pyke report): a champion page carries two
// percentage tables that Readability flattens into indistinguishable bare numbers.
//
//   - "Most-used builds (Diamond+)": item and rune SETS, each a `.combo` with a `.cstat` of
//     "49.8% WR / 41.78% use" — printed BEFORE the set's items, so in flat text the stat line
//     reads as belonging to the previous set ("Duskblade of Draktharr / 55.1% WR").
//   - "Most-used items & runes · from our Top-30 screenshots": single items/runes with a
//     `.t30-pct` of "96%" — PRESENCE in 23 top players' builds, the count only in the icon's
//     `title` ("Youmuu's Ghostblade · 22/23"), which Readability drops.
//
// The report then called Armorcrusher Boots' 83% presence a win rate and gave Duskblade the
// Unflinching rune's 70%. Rewriting each entry as one self-describing line fixes the input the
// worker reads; the numeric check in ground.ts catches what is invented, not what is misread.
//
// Returns null on purpose: this only annotates the document in place, and Readability (which
// already keeps these sections) runs on the annotated copy — see parse-worker.ts.
//
// Dependency-free by design (no env/log/fetch import), same convention as extract-reddit.ts.

interface AnnotatableElement {
  textContent: string | null
  previousElementSibling: AnnotatableElement | null
  parentElement: AnnotatableElement | null
  getAttribute(name: string): string | null
  querySelector(selectors: string): AnnotatableElement | null
  querySelectorAll(selectors: string): ArrayLike<AnnotatableElement>
}
interface AnnotatableDocument {
  querySelectorAll(selectors: string): ArrayLike<AnnotatableElement>
}

function text(el: AnnotatableElement | null): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
}

// getAttribute, not className: an inline SVG's className is an SVGAnimatedString (review).
function hasClass(el: AnnotatableElement | null, name: string): boolean {
  return (el?.getAttribute('class') ?? '').split(/\s+/).includes(name)
}

// The `.bk` label ("Core items", "Runes", "Boots") that heads a run of combos.
function sectionOf(combo: AnnotatableElement): string {
  for (let el = combo.previousElementSibling; el; el = el.previousElementSibling) {
    if (hasClass(el, 'bk')) return text(el)
  }
  return 'Build'
}

function labelSets(document: AnnotatableDocument): void {
  const combos = Array.from(document.querySelectorAll('.combo'))
  for (const combo of combos) {
    const winRate = text(combo.querySelector('.cstat b'))
    const use = text(combo.querySelector('.cstat i'))
    const members = Array.from(combo.querySelectorAll('.bicon-lbl')).map(text).filter(Boolean)
    if (!winRate || members.length === 0) continue
    const usePart = use ? `, used in ${use} of those games` : ''
    combo.textContent = `${sectionOf(combo)} set ${members.join(' + ')}: ${winRate} win rate${usePart} (China server Diamond+ match statistics for this whole set).`
  }
}

function labelPresence(document: AnnotatableDocument): void {
  const cells = Array.from(document.querySelectorAll('.t30-pct'))
  for (const cell of cells) {
    const icon = hasClass(cell.parentElement, 'bicon') ? cell.parentElement : null
    const name = text(icon?.querySelector('.bicon-lbl') ?? null)
    const pct = text(cell)
    if (!icon || !name || !pct) continue
    const count = /(\d+)\s*\/\s*(\d+)\s*$/.exec(icon.getAttribute('title') ?? '')
    const share = count ? `in ${count[1]} of ${count[2]} top-player builds (${pct})` : `in ${pct} of top-player builds`
    // Icons are inline blocks in a row; the newlines keep each entry its own line of text.
    icon.textContent = `\n${name}: ${share} — how often top players pick it, not a win rate.\n`
  }
}

// "Stats by rank bracket & lane" is a real <table>, and Readability joins its cells with no
// separator: "SupportB50.39%3.88%2.66%#14 / 31". Each row becomes "Lane Support, Tier B,
// Win% 50.39%, …" under the bracket label ("Diamond+") that precedes the table.
function labelStatTables(document: AnnotatableDocument): void {
  const tables = Array.from(document.querySelectorAll('table.stat-table'))
  for (const table of tables) {
    const headers = Array.from(table.querySelectorAll('th')).map(text)
    const bracket = hasClass(table.previousElementSibling, 'dan-lbl') ? text(table.previousElementSibling) : ''
    for (const row of Array.from(table.querySelectorAll('tr'))) {
      const cells = Array.from(row.querySelectorAll('td')).map(text)
      if (cells.length === 0) continue
      const pairs = cells.map((cell, i) => (headers[i] ? `${headers[i]} ${cell}` : cell)).join(', ')
      row.textContent = `\n${bracket ? `${bracket}: ` : ''}${pairs}.\n`
    }
  }
}

// Fails open, per table: the labels are enrichment, and a markup change that breaks one must
// not cost the page — plain Readability already reads it.
export function annotateWrchina(document: AnnotatableDocument): null {
  for (const label of [labelSets, labelPresence, labelStatTables]) {
    try {
      label(document)
    } catch {
      // leave this table as Readability would read it unannotated
    }
  }
  return null
}
