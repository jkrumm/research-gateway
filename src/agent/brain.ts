// Pure ranking/excerpting logic for the `brainNotes` tool — the owner's second brain (a git
// checkout of an Obsidian vault, mini-only). Dependency-free (only extract.ts, itself env-free)
// so this is unit-testable without booting env.ts, spawning ripgrep, or touching the
// filesystem — same convention as pdf-extract.ts vs pdf.ts / youtube-captions.ts vs ytdlp.ts.
// The spawn+fs wrapper (brain-search.ts) supplies the raw candidate file contents; this module
// turns them into ranked, cited results.

import { normalizeText } from './extract.js'

const MIN_TERM_LENGTH = 3

/** Split a free-text query into lowercase terms of at least 3 chars — shorter terms ("a", "in",
 * "of") are too common to be a useful ripgrep pattern or ranking signal. Deduplicated. */
export function parseQueryTerms(query: string): string[] {
  const seen = new Set<string>()
  for (const raw of query.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= MIN_TERM_LENGTH) seen.add(raw)
  }
  return [...seen]
}

export interface BrainCandidate {
  /** Path relative to BRAIN_DIR, e.g. "wiki/engineering/model-routing.md" — this doubles as the
   * vault reader's slug (minus the extension), see buildNoteUrl. */
  relPath: string
  content: string
}

export interface BrainNoteResult {
  title: string
  url: string
  updated: string | null
  excerpt: string
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

/** The vault's frontmatter is a flat `key: value` YAML block — good enough for the two scalar
 * fields this tool reads (title, a date). Array/nested values (tags, scores) are read as their
 * raw, unparsed line text, which is fine: nothing here needs them structured, only searchable. */
export function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const match = content.match(FRONTMATTER_RE)
  if (!match) return { frontmatter: {}, body: content }
  const frontmatter: Record<string, string> = {}
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/)
    if (!kv) continue
    const key = kv[1]
    const rawValue = kv[2]
    if (key === undefined || rawValue === undefined) continue
    const value = rawValue.trim().replace(/^['"]|['"]$/g, '')
    if (value !== '') frontmatter[key] = value
  }
  return { frontmatter, body: content.slice(match[0].length) }
}

/** Title precedence: frontmatter `title` > first markdown H1 > filename — mirrors
 * basalt-ui-obsidian's own `toPendingNote` (obsidian-vault-core/src/vault-reader.ts), so the
 * title shown here matches what the reader app shows for the same note. */
export function resolveTitle(relPath: string, frontmatter: Record<string, string>, body: string): string {
  if (frontmatter['title']) return frontmatter['title']
  const h1Text = body.match(/^#\s+(.+)$/m)?.[1]
  if (h1Text !== undefined) return h1Text.trim()
  const basename = relPath.slice(relPath.lastIndexOf('/') + 1)
  return basename.replace(/\.md$/, '')
}

/** `updated`/`modified` first — the field names most vaults use for a last-touched date — then
 * `timestamp`, which is this vault's actual convention (every wiki note carries `timestamp`;
 * none observed carry `updated`/`modified`, checked 2026-09-23). Returns null when none present,
 * never a made-up date. */
export function resolveUpdatedDate(frontmatter: Record<string, string>): string | null {
  return frontmatter['updated'] ?? frontmatter['modified'] ?? frontmatter['timestamp'] ?? null
}

/** Case-insensitive fixed-string occurrence count of every term in `text`. */
export function countTermMatches(text: string, terms: string[]): number {
  const lower = text.toLowerCase()
  let count = 0
  for (const term of terms) {
    let idx = lower.indexOf(term)
    while (idx !== -1) {
      count++
      idx = lower.indexOf(term, idx + term.length)
    }
  }
  return count
}

// A term appearing in the title or frontmatter says "this note is ABOUT that", not just
// "mentions it in passing" — weighted well above a single body occurrence so a note titled
// "Model routing" outranks one that name-drops it once in an unrelated aside.
const TITLE_BOOST = 5
const FRONTMATTER_BOOST = 2

export function scoreNote(args: { title: string; frontmatterBlock: string; body: string; terms: string[] }): number {
  const { title, frontmatterBlock, body, terms } = args
  return (
    countTermMatches(body, terms) +
    countTermMatches(title, terms) * TITLE_BOOST +
    countTermMatches(frontmatterBlock, terms) * FRONTMATTER_BOOST
  )
}

const PER_NOTE_EXCERPT_CAP = 1_500
// Context window kept around each match — generous enough to carry the surrounding sentence
// without ballooning a dense cluster of hits into a whole-page excerpt.
const EXCERPT_CONTEXT_CHARS = 220

/** Builds excerpt windows around every match location in `body`, merges overlapping windows so a
 * dense cluster of hits doesn't repeat the same sentence three times, and bounds the total to
 * `PER_NOTE_EXCERPT_CAP` chars. Falls back to the note's opening chars if, somehow, no term is
 * found (shouldn't happen — the caller only excerpts notes that already scored > 0). */
export function buildExcerpt(body: string, terms: string[]): string {
  const lower = body.toLowerCase()
  const ranges: Array<[number, number]> = []
  for (const term of terms) {
    let idx = lower.indexOf(term)
    while (idx !== -1) {
      ranges.push([Math.max(0, idx - EXCERPT_CONTEXT_CHARS), Math.min(body.length, idx + term.length + EXCERPT_CONTEXT_CHARS)])
      idx = lower.indexOf(term, idx + term.length)
    }
  }
  if (ranges.length === 0) return body.slice(0, PER_NOTE_EXCERPT_CAP).trim()

  ranges.sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = []
  for (const range of ranges) {
    const last = merged[merged.length - 1]
    if (last && range[0] <= last[1]) {
      last[1] = Math.max(last[1], range[1])
    } else {
      merged.push(range)
    }
  }

  let out = ''
  for (const [start, end] of merged) {
    const chunk = body.slice(start, end).trim()
    const separator = out.length > 0 ? '\n…\n' : ''
    const remaining = PER_NOTE_EXCERPT_CAP - out.length - separator.length
    if (remaining <= 0) break
    out += separator + chunk.slice(0, remaining)
  }
  return out
}

/** `relPath` is already vault-root-relative (e.g. "wiki/engineering/model-routing.md"), which
 * IS the reader app's slug once the extension is dropped — verified against the deployed
 * reader's own vault.json (basalt-ui-obsidian, obsidian-vault-core's `toPendingNote`: `slug:
 * relPath.slice(0, -'.md'.length)`) and its `encodeSlugPath` (per-segment `encodeURIComponent`,
 * basalt-ui-obsidian/packages/basalt-ui-obsidian/src/context.tsx). Returns null when no base URL
 * is configured — a note with no citable URL must not be returned as a result. */
export function buildNoteUrl(baseUrl: string | undefined, relPath: string): string | null {
  if (!baseUrl) return null
  const slug = relPath.replace(/\.md$/, '')
  const encoded = slug
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  return `${baseUrl.replace(/\/+$/, '')}/${encoded}`
}

// Total excerpt budget across every note returned, so a broad query that matches several long
// notes doesn't hand a worker 5 x 1,500 chars unconditionally — bounded well under a single
// worker step's context budget (depth.ts's per-call token budgets).
const TOTAL_EXCERPT_CAP = 6_000
const DEFAULT_MAX_RESULTS = 5

/** Ranks candidates by score (body matches + title/frontmatter boost), drops non-matches, and
 * builds the top results — title, citation url, updated date, bounded excerpt. */
export function rankAndBuildNotes(args: {
  candidates: BrainCandidate[]
  terms: string[]
  baseUrl: string | undefined
  maxResults?: number
}): BrainNoteResult[] {
  const { candidates, terms, baseUrl, maxResults = DEFAULT_MAX_RESULTS } = args

  const scored = candidates
    .map((c) => {
      const { frontmatter, body: rawBody } = parseFrontmatter(c.content)
      const body = normalizeText(rawBody)
      const title = resolveTitle(c.relPath, frontmatter, body)
      const frontmatterBlock = c.content.match(FRONTMATTER_RE)?.[1] ?? ''
      const score = scoreNote({ title, frontmatterBlock, body, terms })
      return { relPath: c.relPath, title, body, frontmatter, score }
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)

  let excerptBudget = TOTAL_EXCERPT_CAP
  const results: BrainNoteResult[] = []
  for (const c of scored) {
    const url = buildNoteUrl(baseUrl, c.relPath)
    if (!url) continue
    const cap = Math.min(PER_NOTE_EXCERPT_CAP, excerptBudget)
    if (cap <= 0) break
    const excerpt = buildExcerpt(c.body, terms).slice(0, cap)
    excerptBudget -= excerpt.length
    results.push({ title: c.title, url, updated: resolveUpdatedDate(c.frontmatter), excerpt })
  }
  return results
}
