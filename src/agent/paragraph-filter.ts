// Paragraph filter for fetchPage's `lines` parameter on a LONG DOCUMENT (extracted HTML/PDF text),
// the sibling of line-filter.ts's row filter. Pure and env-free, so it is unit-tested.
//
// A 366k-char paper does not fit the 80k-char page cut: the Llama 3 arXiv HTML was read up to
// section 4 and the safety section and appendices were never seen. With `lines` the worker names
// what it is after and gets the document's opening line plus each matching paragraph with one
// paragraph of context either side, chosen BEFORE the cut.
//
// What this returns is what the tool hands back, so it is also the text the ledger and the number
// check hold (worker.ts); nothing shown to the model is missing from it. It always says the rest
// of the document was NOT returned, so a missing passage is never read as an absent one.

import { FILTER_MAX_CHARS, lineMatcher } from './line-filter.js'

// One paragraph is clipped here so a document without paragraph breaks cannot swallow the budget.
const PARAGRAPH_CLIP_CHARS = 3_000
// Fewer blank-line-separated paragraphs than this in a document over the cap means the text is
// newline-delimited rather than blank-line-delimited (Readability's usual shape): split on newlines.
const MIN_BLANK_LINE_PARAGRAPHS = 10
const GAP = '[…]'

export interface ParagraphFilterResult {
  /** Opening line, matching paragraphs with context and the closing note — what the model receives. */
  text: string
  matched: number
  total: number
  /** Matching paragraphs left out because `maxChars` ran out. */
  omitted: number
}

// A clipped hit keeps a window AROUND its first matching term, so the shown text always holds the
// evidence that made it a hit; a clipped context paragraph keeps its start.
function clip(paragraph: string, lowerTerms: readonly string[] = []): string {
  if (paragraph.length <= PARAGRAPH_CLIP_CHARS) return paragraph
  const lower = paragraph.toLowerCase()
  const at = Math.min(...lowerTerms.map((t) => lower.indexOf(t)).filter((i) => i >= 0), Number.POSITIVE_INFINITY)
  if (at === Number.POSITIVE_INFINITY || at < PARAGRAPH_CLIP_CHARS / 2) return `${paragraph.slice(0, PARAGRAPH_CLIP_CHARS)} […]`
  const from = Math.min(at - PARAGRAPH_CLIP_CHARS / 2, paragraph.length - PARAGRAPH_CLIP_CHARS)
  const tail = from + PARAGRAPH_CLIP_CHARS < paragraph.length ? ' […]' : ''
  return `[…] ${paragraph.slice(from, from + PARAGRAPH_CLIP_CHARS)}${tail}`
}

/** Null when nothing matches. `terms` should come from normalizeTerms and be non-empty. */
export function filterParagraphs(text: string, terms: readonly string[], maxChars: number): ParagraphFilterResult | null {
  const blank = text.split(/\n\s*\n/).filter((p) => p.trim() !== '')
  const separator = blank.length >= MIN_BLANK_LINE_PARAGRAPHS ? '\n\n' : '\n'
  const paragraphs = separator === '\n\n' ? blank : text.split('\n').filter((p) => p.trim() !== '')

  const isMatch = lineMatcher(terms)
  const lowerTerms = terms.map((t) => t.toLowerCase())
  const hits: number[] = []
  paragraphs.forEach((p, i) => {
    if (isMatch(p)) hits.push(i)
  })
  if (hits.length === 0) return null

  const quoted = terms.map((t) => `"${t.toLowerCase()}"`).join(', ')
  const noteFor = (shown: number): string => {
    const omitted = hits.length - shown
    const cut = omitted > 0 ? ` ${omitted} further matching paragraphs did not fit and are NOT shown: use narrower terms.` : ''
    return `[paragraph filter ${quoted}: ${hits.length} of ${paragraphs.length} paragraphs match; showing ${shown}, each with one paragraph of context. The rest of the document was NOT returned, so a passage missing here is not evidence it is absent.]${cut ? `\n${cut.trim()}` : ''}`
  }

  const room = Math.max(0, maxChars - noteFor(0).length - 2 - 200)
  const parts: string[] = []
  let used = 0
  let shown = 0
  const push = (chunk: string): boolean => {
    const cost = chunk.length + separator.length
    if (used + cost > room) return false
    parts.push(chunk)
    used += cost
    return true
  }

  // The document's opening line (its title) always leads, so the passages have a name.
  const title = clip(paragraphs[0] ?? '').slice(0, 200)
  if (title !== '') push(title)
  let last = 0

  for (const hit of hits) {
    const from = Math.max(hit - 1, last + 1)
    const to = Math.min(hit + 1, paragraphs.length - 1)
    if (to <= last) {
      shown++ // already inside the previous hit's context
      continue
    }
    if (from > last + 1 && !push(GAP)) break
    let fits = true
    for (let i = from; i <= to; i++) {
      if (!push(clip(paragraphs[i] ?? '', i === hit ? lowerTerms : []))) {
        fits = false
        break
      }
    }
    if (!fits) break
    last = to
    shown++
  }

  return {
    text: `${parts.join(separator)}\n\n${noteFor(shown)}`,
    matched: hits.length,
    total: paragraphs.length,
    omitted: hits.length - shown,
  }
}

/**
 * The one decision for a page's text before the page-text cut: with no terms, or text that fits
 * the cap, nothing changes; otherwise the paragraph filter replaces the head-of-document cut. When
 * nothing matches, a one-line note leads the full text, which the caller's ordinary cut then
 * trims to its head, so the call is not wasted.
 */
export function fitDocumentText(
  text: string,
  terms: readonly string[] | undefined,
  cap: number,
): { text: string; filter: Pick<ParagraphFilterResult, 'matched' | 'total'> | null } {
  if (!terms?.length || text.length <= cap) return { text, filter: null }
  // The selection is capped well under the page cut, same as the row filter: a broad term must not
  // spend a worker's page-text budget in one call.
  const filtered = filterParagraphs(text, terms, Math.min(cap, FILTER_MAX_CHARS))
  if (filtered) return { text: filtered.text, filter: { matched: filtered.matched, total: filtered.total } }
  const quoted = terms.map((t) => `"${t.toLowerCase()}"`).join(', ')
  return {
    text: `[no paragraph of this document matched ${quoted}; its head is returned instead.]\n\n${text}`,
    filter: { matched: 0, total: 0 },
  }
}
