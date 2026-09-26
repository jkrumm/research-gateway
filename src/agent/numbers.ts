// Numeric-claim check — does a number a claim quotes actually occur in the page it cites?
//
// The 2026-09-26 Pyke report cited wrchina.gg for "Top-win item … at ~83% win over ~5,565
// matches". The page has two tables: item-SET win rate + use rate, and item PRESENCE in 23
// top players' builds ("Youmuu's Ghostblade 96%", "Armorcrusher Boots 83%"). The 83% was a
// presence figure read as a win rate, and "5,565" occurs nowhere on the page — nor on any page
// the run read. Every gate passed: the URL was retrieved, so the citation rode at `medium`.
// A well-cited, confidently wrong number is the most dangerous thing this service can emit.
//
// A number the model invented can be caught mechanically: it is not in the text the model was
// given. A number that IS on the page but means something else there (the 83% presence) cannot
// — this check does not pretend to; site-adapters' wrchina reader labels those at the source.
//
// Which claim numbers are checked: percentages, and any other number ≥ 100 — the quantities a
// consumer acts on. Bare numbers under 100 ("6-slot", "top 30", "the 7.3 table", "1.25 s"),
// years, dates, versions ("Patch 7.3", "v2.1.0", "S23") and anything glued to letters ("4K",
// "5k", "2x") are skipped:
// either they are not measurements or they are routinely restated in a form the page does not
// use. A match tolerates rounding at the claim's own precision ("55%" matches 55.1) and, for an
// explicitly approximate claim ("~", "about", "roughly"…), ±2%.
//
// The page side reads each token every plausible way ("5.565" as 5.565 AND 5565, "55,1" as
// 55.1, "1,2" as 1 and 2), because a false mismatch caps a correct claim — but never a reading
// the page does not support: every extra reading is a number an invented claim could hide behind.
//
// Dependency-free by design (no project imports), same convention as ledger.ts / ground.ts.

const TOKEN_RE = /\d+(?:[.,]\d+)*/g

/** Every numeric value a text could be read as stating. */
export function extractNumbers(text: string): number[] {
  const out = new Set<number>()
  for (const match of text.matchAll(TOKEN_RE)) {
    for (const value of readings(match[0])) out.add(value)
  }
  return [...out]
}

function readings(token: string): number[] {
  const values: number[] = []
  const add = (s: string): void => {
    const n = Number(s)
    if (Number.isFinite(n)) values.push(n)
  }
  // Commas are dropped only where they are thousands groups (5,565 · 1,234.5) — stripping any
  // comma would read a German "55,1" as 551 and let a claim of 551 pass.
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(token)) {
    add(token.replace(/,/g, ''))
    return values
  }
  if (!token.includes(',')) add(token) // 55.1, 5565, and 5.565 as a decimal
  if (/^\d{1,3}(?:\.\d{3})+$/.test(token)) add(token.replace(/\./g, '')) // 5.565 (de) → 5565
  if (/^\d+,\d{1,2}$/.test(token)) add(token.replace(',', '.')) // 55,1 (de) → 55.1
  // Any other comma is a list separator ("1,2,3"): each item is its own number.
  if (token.includes(',')) for (const part of token.split(',')) add(part)
  return values
}

export interface ClaimNumber {
  /** As written in the claim, e.g. "~5,565" or "55.1%". */
  raw: string
  value: number
  decimals: number
  approximate: boolean
}

const APPROX_BEFORE = /(?:~|≈|\babout|\baround|\bapprox(?:imately|\.)?|\broughly|\bnearly|\balmost|\bsome|\bca\.?)\s*$/i
const VERSION_BEFORE = /(?:\bpatch|\bversion|\bv|\bseason|\bs|\bgen|\bsection|§)\s*$/i

/** The numbers in a claim that are worth checking against its cited page. */
export function claimNumbers(claim: string): ClaimNumber[] {
  // A URL inside the claim carries its own digits (ids, dates) that are not claims.
  const text = claim.replace(/https?:\/\/\S+/g, ' ')
  const out: ClaimNumber[] = []
  for (const match of text.matchAll(/\d+(?:,\d{3})*(?:\.\d+)?/g)) {
    const token = match[0]
    const start = match.index
    const end = start + token.length
    const before = text.slice(Math.max(0, start - 12), start)
    const prev = text[start - 1] ?? ''
    const next = text[end] ?? ''
    const next2 = text.slice(end, end + 2)
    // Glued to letters or part of a date/time/range/version chain: not a measurement.
    if (/[A-Za-z]/.test(prev) || /[A-Za-z]/.test(next)) continue
    if (/[-/:.]/.test(prev) && /\d/.test(text[start - 2] ?? '')) continue
    if (/^[-/:.]\d/.test(next2)) continue
    if (VERSION_BEFORE.test(before)) continue

    const percent = /^\s?%/.test(text.slice(end, end + 2))
    const decimals = token.includes('.') ? (token.split('.')[1]?.length ?? 0) : 0
    const value = Number(token.replace(/,/g, ''))
    if (!Number.isFinite(value)) continue
    const isYear = !percent && decimals === 0 && value >= 1900 && value <= 2100 && !token.includes(',')
    if (isYear) continue
    // A bare number under 100 is a count, a version ("the 7.3 item table" — measured 2026-09-26,
    // no "patch" before it), a duration or a rating far more often than a measurement.
    if (!percent && value < 100) continue

    const approximate = APPROX_BEFORE.test(before)
    out.push({ raw: `${approximate ? '~' : ''}${token}${percent ? '%' : ''}`, value, decimals, approximate })
  }
  return out
}

function matches(n: ClaimNumber, page: readonly number[]): boolean {
  const rounding = 0.5 * 10 ** -n.decimals
  const tolerance = n.approximate ? Math.max(rounding, Math.abs(n.value) * 0.02) : rounding
  // Floating-point slack so 55.05 → "55.1" style boundaries don't flap.
  return page.some((p) => Math.abs(p - n.value) <= tolerance + 1e-9)
}

/** Claim numbers that occur nowhere in the cited page's text, as written in the claim. */
export function unmatchedNumbers(claim: string, pageNumbers: readonly number[]): string[] {
  return claimNumbers(claim)
    .filter((n) => !matches(n, pageNumbers))
    .map((n) => n.raw)
}
