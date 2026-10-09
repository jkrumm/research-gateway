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

import type { StreamedLines } from '../lib/bounded-read.js'

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

// Object stores and CDNs often serve a data file with no Content-Type (owid-public.owid.io: a 33 MB
// CSV with none) or a generic one. The URL's own extension then says what the body is; a binary
// that lies about its name is still caught downstream (looksBinary, the %PDF- header check).
const GENERIC_TYPES = ['application/octet-stream', 'binary/octet-stream']
const LINE_ORIENTED_EXTENSION = /\.(?:csv|tsv|ndjson|jsonl|txt)$/i

/** Whether a response should be treated as a line-oriented file: by declared type, else by extension when the type says nothing. */
export function isLineOrientedResource(contentType: string | null | undefined, url: string): boolean {
  if (isLineOrientedContentType(contentType)) return true
  const type = (contentType ?? '').trim().toLowerCase()
  if (type !== '' && !GENERIC_TYPES.some((g) => type.includes(g))) return false
  try {
    return LINE_ORIENTED_EXTENSION.test(new URL(url).pathname)
  } catch {
    return false
  }
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

/** What a streaming scan of a body found (bounded-read.ts's `readBoundedLines`). `matches` may hold fewer than `matched`: a stream keeps only what fits. */
export type LineScan = StreamedLines

/** The case-insensitive substring test `terms` (from normalizeTerms) describe. */
export function lineMatcher(rawTerms: readonly string[]): (line: string) => boolean {
  const terms = rawTerms.map((t) => t.toLowerCase())
  return (line) => {
    const lower = line.toLowerCase()
    return terms.some((t) => lower.includes(t))
  }
}

/**
 * Header line + the scanned matching lines within `maxChars` in total, closed by a note that the
 * rest of the document was NOT returned.
 */
export function formatLineScan(scan: LineScan, rawTerms: readonly string[], maxChars: number): LineFilterResult {
  const { header, matches, matched, searched } = scan
  const quoted = rawTerms.map((t) => `"${t.toLowerCase()}"`).join(', ')
  const stopped =
    scan.stoppedAtBytes === undefined
      ? ''
      : ` The download was stopped after ${Math.round(scan.stoppedAtBytes / 1_048_576)} MB, so later lines were NOT searched at all.`

  const noteFor = (kept: number): string => {
    if (matched === 0) {
      return `[no lines matched ${quoted}: ${searched} lines below the header were searched and none contain any of these terms.${stopped} Only the header line is shown; the rest of the document was NOT returned.]`
    }
    const omitted = matched - kept
    const cut = omitted > 0 ? ` ${omitted} further matching lines did not fit and are NOT shown: use narrower terms.` : ''
    return `[line filter ${quoted}: ${matched} of ${searched} lines below the header match; showing ${kept}.${cut}${stopped} All other lines of the document were NOT returned, so a row missing here is not evidence it is absent.]`
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
    matched,
    searched,
    omitted: matched - kept.length,
  }
}

/**
 * An oversized line-oriented body read WITHOUT `lines`: its header plus as many whole leading
 * lines as fit `maxChars`, and a note that says it is cut and how to read the rest. `decoded` is
 * the text of the bytes that were read (the last line may be partial and is dropped).
 */
export function oversizedPrefix(decoded: string, readBytes: number, maxChars: number): string {
  const note = `[this file is larger than ${Math.round(readBytes / 1_048_576)} MB; only its first lines are shown. The rest was NOT returned. To read specific rows call fetchPage again on this URL with \`lines\` set to terms the rows contain (e.g. a country or a year).]`
  const room = Math.max(0, maxChars - note.length - 2)
  const lastNewline = decoded.lastIndexOf('\n')
  const whole = lastNewline >= 0 ? decoded.slice(0, lastNewline + 1) : decoded
  let end = Math.min(whole.length, room)
  if (end < whole.length) {
    const cutAt = whole.lastIndexOf('\n', end)
    if (cutAt > 0) end = cutAt
  }
  return `${whole.slice(0, end).trimEnd()}\n\n${note}`
}
