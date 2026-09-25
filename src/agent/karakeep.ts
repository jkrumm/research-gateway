// Pure URL building, lenient parsing, HTML→text stripping, excerpting and ranking for the
// Karakeep half of `brainNotes`. Dependency-free (extract.ts + brain.ts, both env-free) so it is
// unit-testable without booting env.ts or making a live call — same convention as brain.ts vs
// brain-search.ts. The fetch boundary lives in karakeep-search.ts.
//
// API facts verified against Karakeep v1 on 2026-09-25 (`Authorization: Bearer <key>`):
//   GET {KARAKEEP_URL}/api/v1/bookmarks/search?q=<q>&limit=<n>&includeContent=true
//     -> { bookmarks: Bookmark[], nextCursor: string|null }
//   GET {KARAKEEP_URL}/api/v1/bookmarks/{id}/highlights -> { highlights: [{ text, ... }] }
// Bookmark content is a tagged union: a `link` bookmark carries `{ url, title, description,
// htmlContent, ... }`, a `text` bookmark carries `text`, an `asset` bookmark carries neither, so
// every field is read leniently and a bookmark with nothing to excerpt is dropped.

import { normalizeText } from './extract.js'
import { buildExcerpt, countTermMatches } from './brain.js'

const DEFAULT_MAX_RESULTS = 3

// ── Lenient value readers ────────────────────────────────────────────────────
// Karakeep's response is external and unversioned from our side; every field is optional and
// may be null, so each access goes through one of these instead of a cast.

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string' && v.length > 0)
}

/** The subset of a bookmark this module reads, already narrowed to the shapes above. */
export interface KarakeepBookmarkInput {
  id: string
  createdAt: unknown
  modifiedAt: unknown
  title: unknown
  note: unknown
  summary: unknown
  tags: unknown
  content: unknown
}

export interface KarakeepBookmarkResult {
  kind: 'bookmark'
  id: string
  title: string
  /** The Karakeep preview URL — the citable URL this is recorded on the retrieval ledger under. */
  url: string
  /** The archived page's original URL, surfaced in `excerpt` only: an archived copy must not
   * vouch for the live original. Null when the bookmark carries none. */
  originalUrl: string | null
  updated: string | null
  excerpt: string
  highlights: string[]
}

// ── URL building ─────────────────────────────────────────────────────────────

function stripTrailingSlash(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

/** `{base}/api/v1/bookmarks/search?...` — `baseUrl` is expected WITHOUT an `/api` suffix (the
 * env var's contract); only a trailing slash is normalised away. */
export function buildKarakeepSearchUrl(baseUrl: string, query: string, limit: number): string {
  const params = new URLSearchParams({ q: query, limit: String(limit), includeContent: 'true' })
  return `${stripTrailingSlash(baseUrl)}/api/v1/bookmarks/search?${params.toString()}`
}

/** The searches to issue for one brainNotes query. Karakeep's full-text search requires EVERY
 * word to match, so a multi-word worker query ("Bun runtime Mac mini hosting") almost never hits
 * an 18-bookmark library, while the single terms do. Search the full query plus up to three of
 * its distinctive terms (longest first — the most specific), union the hits by id, and let
 * `rankAndBuildBookmarks` decide relevance locally. Deduped, order preserved. */
export function karakeepSearchQueries(query: string, terms: string[], maxTerms = 3): string[] {
  const byLength = [...terms].sort((a, b) => b.length - a.length).slice(0, maxTerms)
  const seen = new Set<string>()
  const out: string[] = []
  for (const q of [query.trim(), ...byLength]) {
    const key = q.toLowerCase()
    if (!q || seen.has(key)) continue
    seen.add(key)
    out.push(q)
  }
  return out
}

/** `{base}/dashboard/preview/{id}` — the human-openable Karakeep URL, and the only URL recorded
 * on the ledger. */
export function buildKarakeepPreviewUrl(baseUrl: string, id: string): string {
  return `${stripTrailingSlash(baseUrl)}/dashboard/preview/${encodeURIComponent(id)}`
}

// ── Parsing ──────────────────────────────────────────────────────────────────

/** `{ bookmarks: [...] }` -> the entries carrying a usable string id. Anything else (missing
 * array, a malformed entry) is skipped rather than throwing. */
export function parseBookmarkSearchResponse(data: unknown): KarakeepBookmarkInput[] {
  const record = asRecord(data)
  const list = record?.['bookmarks']
  if (!Array.isArray(list)) return []

  const out: KarakeepBookmarkInput[] = []
  for (const entry of list) {
    const b = asRecord(entry)
    const id = b ? asString(b['id']) : null
    if (!b || !id) continue
    out.push({
      id,
      createdAt: b['createdAt'],
      modifiedAt: b['modifiedAt'],
      title: b['title'],
      note: b['note'],
      summary: b['summary'],
      tags: b['tags'],
      content: b['content'],
    })
  }
  return out
}

/** `{ highlights: [{ text }] }` -> the non-empty highlight texts. Empty on any other shape, so
 * an instance with 0 highlights (the current case) is not an error. */
export function parseHighlightsResponse(data: unknown): string[] {
  const record = asRecord(data)
  const list = record?.['highlights']
  if (!Array.isArray(list)) return []

  const out: string[] = []
  for (const entry of list) {
    const h = asRecord(entry)
    const text = h ? asString(h['text']) : null
    if (text) out.push(text)
  }
  return out
}

// ── HTML → text ──────────────────────────────────────────────────────────────

const NAMED_ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
}

/** Strips scripts/styles/comments/tags and decodes the common entities, then normalises
 * whitespace. Deliberately a regex pass, not a DOM parser: it is pure and cheap, and the excerpt
 * only needs readable prose around query terms, not structural fidelity. */
export function htmlToText(html: string): string {
  const stripped = html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote|pre)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&[a-z]+;/gi, (entity) => NAMED_ENTITIES[entity.toLowerCase()] ?? entity)
  return normalizeText(stripped)
}

// ── Bookmark content ─────────────────────────────────────────────────────────

interface BookmarkContent {
  title: string | null
  originalUrl: string | null
  text: string
}

/** Flattens whichever content shape a bookmark carries into one text body. A `link` bookmark
 * contributes its stripped `htmlContent` (or `description` when the crawl produced no HTML); a
 * `text` bookmark contributes `content.text`; either may also contribute the owner's own `note`
 * and Karakeep's `summary`. */
function extractBookmarkContent(bookmark: KarakeepBookmarkInput): BookmarkContent {
  const content = asRecord(bookmark.content)
  const parts: string[] = []
  let originalUrl: string | null = null
  let contentTitle: string | null = null

  if (content) {
    originalUrl = asString(content['url'])
    contentTitle = asString(content['title'])
    const html = asString(content['htmlContent'])
    const text = asString(content['text'])
    const description = asString(content['description'])
    if (html) parts.push(htmlToText(html))
    else if (text) parts.push(normalizeText(text))
    if (description) parts.push(normalizeText(description))
  }

  parts.push(...asStringArray([bookmark.note, bookmark.summary]))

  return {
    title: asString(bookmark.title) ?? contentTitle,
    originalUrl,
    text: normalizeText(parts.join('\n\n')),
  }
}

function bookmarkTagNames(bookmark: KarakeepBookmarkInput): string[] {
  if (!Array.isArray(bookmark.tags)) return []
  const names: string[] = []
  for (const entry of bookmark.tags) {
    const tag = asRecord(entry)
    const name = tag ? asString(tag['name']) : null
    if (name) names.push(name)
  }
  return names
}

function resolveBookmarkTitle(title: string | null, text: string, originalUrl: string | null): string {
  if (title) return title
  const firstLine = (text.split('\n')[0] ?? '').trim()
  if (firstLine) return firstLine.slice(0, 120)
  return originalUrl ?? 'Bookmark'
}

// ── Ranking ──────────────────────────────────────────────────────────────────

/** Scores each bookmark by term matches in its title (boosted), tags and body, keeps the ones
 * with at least one match AND something to excerpt, and builds the top results. The Karakeep
 * search already filtered server-side; this only orders the candidates it returned and drops the
 * ones whose archived content did not survive into the response. Each result cites its Karakeep
 * preview URL and states the original page URL in the excerpt text, never as the citation. */
export function rankAndBuildBookmarks(args: {
  bookmarks: KarakeepBookmarkInput[]
  terms: string[]
  baseUrl: string
  highlightsById?: ReadonlyMap<string, string[]>
  maxResults?: number
}): KarakeepBookmarkResult[] {
  const { bookmarks, terms, baseUrl, highlightsById, maxResults = DEFAULT_MAX_RESULTS } = args

  const scored = bookmarks
    .map((bookmark) => {
      const { title, originalUrl, text } = extractBookmarkContent(bookmark)
      const tagText = bookmarkTagNames(bookmark).join(' ')
      // Title/tag matches say "this bookmark is ABOUT the topic"; a body mention is weaker. Same
      // ordering idea as brain.ts's scoreNote, without the IDF machinery (the search already did
      // the retrieval filtering, so there is no candidate corpus to weight against). Scores
      // against the EXPLICIT title only — resolveBookmarkTitle's first-line fallback is for
      // display, and counting it here would also score the body a second time.
      const score =
        countTermMatches(title ?? '', terms) * 3 +
        countTermMatches(text, terms) +
        countTermMatches(tagText, terms) * 2
      return { bookmark, resolvedTitle: resolveBookmarkTitle(title, text, originalUrl), originalUrl, text, score }
    })
    // Per-term searches (karakeepSearchQueries) widen recall, so relevance is decided here: with
    // two or more query terms, a bookmark must match at least two DISTINCT terms — one incidental
    // mention of "bun" in an unrelated page is not a hit.
    .filter((entry) => {
      if (entry.text.length === 0 || entry.score === 0) return false
      if (terms.length < 2) return true
      const haystack = `${entry.resolvedTitle} ${entry.text} ${bookmarkTagNames(entry.bookmark).join(' ')}`
      return terms.filter((term) => countTermMatches(haystack, [term]) > 0).length >= 2
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)

  const results: KarakeepBookmarkResult[] = []
  for (const entry of scored) {
    const lines: string[] = []
    if (entry.originalUrl) lines.push(`Original page: ${entry.originalUrl}`)
    const excerpt = buildExcerpt(entry.text, terms)
    if (excerpt) lines.push(excerpt)
    results.push({
      kind: 'bookmark',
      id: entry.bookmark.id,
      title: entry.resolvedTitle,
      url: buildKarakeepPreviewUrl(baseUrl, entry.bookmark.id),
      originalUrl: entry.originalUrl,
      updated: asString(entry.bookmark.modifiedAt) ?? asString(entry.bookmark.createdAt),
      excerpt: lines.join('\n'),
      highlights: highlightsById?.get(entry.bookmark.id) ?? [],
    })
  }
  return results
}
