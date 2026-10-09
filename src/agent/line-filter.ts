// Line filter for fetchPage's optional `lines` parameter. Pure and env-free, so it is unit-tested.
//
// A 557 KB population.csv does not fit a worker's page-text budget: the chain cut it at ~80k
// characters and Germany's rows were never read. For a line-oriented body (CSV, TSV, plain text,
// JSON-lines) the model can instead name what it is after and get the header line plus only the
// lines that mention one of its terms, in original order.
//
// The returned text is the page as the model sees it: it is what the tool hands back, so it is
// also what worker.ts records for the numeric-claim check (numbers.ts). Nothing here is shown to
// the model that is not in `text`, and nothing in `text` is hidden from that check.
//
// The text always ends with an explicit note that the rest of the document was NOT returned, so
// the absence of a row from a filtered read is never mistaken for evidence the row does not exist
// (the same rule as the page-budget cut notice in fetch-guard.ts).

export const MAX_LINE_TERMS = 5
export const MAX_TERM_CHARS = 100

// Content types whose bodies are one record per line. Deliberately narrower than
// response-kind.ts's isRawContentType: a pretty-printed JSON or XML document has no "header
// line" and no row to filter on, so a filter request against one is ignored.
const LINE_ORIENTED_TYPES = [
  'text/csv',
  'text/tab-separated-values',
  'text/plain',
  'application/csv',
  'application/x-ndjson',
  'application/jsonl',
  'application/x-jsonlines',
  'application/jsonlines',
]

export function isLineOrientedContentType(contentType: string | null | undefined): boolean {
  if (!contentType) return false
  const value = contentType.toLowerCase()
  return LINE_ORIENTED_TYPES.some((t) => value.includes(t))
}

/** Trimmed, lower-cased, de-duplicated, non-empty terms — at most MAX_LINE_TERMS of them. */
export function normalizeTerms(terms: readonly string[] | undefined): string[] {
  if (!terms) return []
  const out = new Set<string>()
  for (const raw of terms) {
    const term = raw.trim().toLowerCase().slice(0, MAX_TERM_CHARS)
    if (term !== '') out.add(term)
    if (out.size === MAX_LINE_TERMS) break
  }
  return [...out]
}

/** Stable identity of a normalized term set — the single-flight and per-worker dedup variant. */
export function filterVariant(terms: readonly string[]): string {
  return terms.length === 0 ? '' : `lines:${[...terms].sort().join('\u0001')}`
}

export interface LineFilterResult {
  /** The header line, the matching lines and the closing note — exactly what the model receives. */
  text: string
  /** Lines (after the header) that matched at least one term. */
  matched: number
  /** Lines (after the header) that were searched. */
  searched: number
  /** Matching lines left out because `maxChars` ran out. */
  omitted: number
}

/**
 * Header line + every later line containing any of `terms` (case-insensitive substring), in
 * original order, within `maxChars` in total. `terms` should come from normalizeTerms and be
 * non-empty.
 */
export function filterLines(text: string, rawTerms: readonly string[], maxChars: number): LineFilterResult {
  const terms = rawTerms.map((t) => t.toLowerCase())
  const lines = text.split(/\r?\n/)
  const header = lines[0] ?? ''
  const body = lines.slice(1)
  const quoted = terms.map((t) => `"${t}"`).join(', ')

  const matches: string[] = []
  for (const line of body) {
    const lower = line.toLowerCase()
    if (terms.some((t) => lower.includes(t))) matches.push(line)
  }

  const noteFor = (kept: number): string => {
    if (matches.length === 0) {
      return `[no lines matched ${quoted}: ${body.length} lines below the header were searched and none contain any of these terms. Only the header line is shown; the rest of the document was NOT returned.]`
    }
    const omitted = matches.length - kept
    const cut = omitted > 0 ? ` ${omitted} further matching lines did not fit and are NOT shown: use narrower terms.` : ''
    return `[line filter ${quoted}: ${matches.length} of ${body.length} lines below the header match; showing ${kept}.${cut} All other lines of the document were NOT returned, so a row missing here is not evidence it is absent.]`
  }

  // The note's size depends on how many lines fit, so reserve for the longest form up front.
  const reserve = noteFor(0).length + 2
  const room = Math.max(0, maxChars - reserve)
  let used = header.length > room ? room : header.length
  const kept: string[] = []
  for (const line of matches) {
    if (used + 1 + line.length > room) break
    kept.push(line)
    used += 1 + line.length
  }

  const head = header.length > room ? header.slice(0, room) : header
  const out = [head, ...kept].join('\n')
  return {
    text: `${out}\n\n${noteFor(kept.length)}`,
    matched: matches.length,
    searched: body.length,
    omitted: matches.length - kept.length,
  }
}
