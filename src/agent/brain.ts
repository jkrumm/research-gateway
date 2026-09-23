// Pure ranking/excerpting logic for the `brainNotes` tool — the owner's second brain (a git
// checkout of an Obsidian vault, mini-only). Dependency-free (only extract.ts, itself env-free)
// so this is unit-testable without booting env.ts, spawning ripgrep, or touching the
// filesystem — same convention as pdf-extract.ts vs pdf.ts / youtube-captions.ts vs ytdlp.ts.
// The spawn+fs wrapper (brain-search.ts) supplies the raw candidate file contents; this module
// turns them into ranked, cited results.

import { normalizeText } from './extract.js'

const MIN_TERM_LENGTH = 3

// Function words with no topical signal, dropped before both ripgrep candidate discovery and
// ranking. NOT a general-purpose English stopword list — deliberately small, just the words
// observed actually derailing this tool: a query like "gpt-6-luna reverted after one day"
// otherwise spends a ripgrep pattern (and ranking weight) on "after"/"one"/"day", which match
// almost every note in the vault for free. Domain-common-but-real words ("research",
// "gateway", "model") are NOT listed here — those are handled by IDF weighting below, because
// unlike "one"/"day" they ARE the right word in a different query.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'how', 'what', 'which', 'why', 'who', 'whom',
  'my', 'own', 'today', 'setup', 'one', 'day', 'this', 'that', 'these', 'those',
  'are', 'was', 'were', 'been', 'being', 'have', 'has', 'had', 'does', 'did',
  'you', 'your', 'our', 'its', 'his', 'her', 'their', 'not', 'but', 'from',
])

/** Lowercase, split on non-alphanumerics, drop terms under MIN_TERM_LENGTH, drop STOPWORDS,
 * dedupe. The one tokenizer shared by parseQueryTerms (a query) and buildCorpusStats (every
 * note in the vault) — a term that could never survive as a QUERY term must never occur in the
 * corpus's df table either (nothing would ever look it up), and vice versa. */
function tokenizeTerms(text: string): Set<string> {
  const seen = new Set<string>()
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= MIN_TERM_LENGTH && !STOPWORDS.has(raw)) seen.add(raw)
  }
  return seen
}

/** Split a free-text query into lowercase terms of at least 3 chars — shorter terms ("a", "in",
 * "of") are too common to be a useful ripgrep pattern or ranking signal — and drop STOPWORDS.
 * Deduplicated. */
export function parseQueryTerms(query: string): string[] {
  return [...tokenizeTerms(query)]
}

/** True when `a` and `b` are the same failed brainNotes lookup rephrased rather than a genuinely
 * new query — either one term set is a subset of the other (a rephrase that only added/dropped a
 * word), or the two sets overlap heavily (a rephrase that swapped a couple of synonyms). Pure set
 * comparison over already-stopword-filtered terms; used to short-circuit a worker re-querying the
 * brain vault after an earlier call already came back with no strong match for essentially the
 * same question. */
export function isNearDuplicateQuery(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return false
  const setA = new Set(a)
  const setB = new Set(b)
  const [smaller, larger] = setA.size <= setB.size ? [setA, setB] : [setB, setA]
  let overlap = 0
  for (const term of smaller) if (larger.has(term)) overlap++
  if (overlap === smaller.size) return true
  const union = setA.size + setB.size - overlap
  return union > 0 && overlap / union >= 0.6
}

// A worker that keeps missing on brainNotes gets cut off rather than burning its whole context
// budget on ripgrep + file reads that will fail the same way again — the incident this exists
// for: 16 calls, 0 strong matches, context blown before searchWeb/fetchPage ever ran.
const MAX_BRAIN_CALLS = 3

export type BrainCallGate =
  | { blocked: false }
  | { blocked: true; reason: 'budget' | 'duplicate' }

export interface BrainCallGuard {
  /** Records this call attempt and reports whether it should be blocked — either the worker's
   * call budget (MAX_BRAIN_CALLS) is spent, or `terms` is a near-duplicate rephrase of an
   * earlier call that already came back with no strong match (isNearDuplicateQuery). Budget is
   * checked first: once it's spent every further call is blocked for that reason regardless of
   * whether the terms happen to be new, since the point is stopping the burn, not just the
   * repetition. */
  check(terms: readonly string[]): BrainCallGate
  /** Records that `terms` came back with no strong match, so a later near-duplicate rephrase of
   * the same question is recognised and blocked instead of re-searched. Callers must only call
   * this after a call that was NOT blocked by check() — a blocked call never reached the vault. */
  recordMiss(terms: readonly string[]): void
}

/** Pure call-budget + near-duplicate policy for the brainNotes tool — factored out of
 * buildBrainNotesTool (tools.ts) so it's unit-testable without booting a tool, an env, or a
 * ledger. One guard per worker (tools.ts's buildTools is called once per worker, same scoping
 * as searchWeb's `searched` / fetchPage's `fetched`). */
export function createBrainCallGuard(maxCalls = MAX_BRAIN_CALLS): BrainCallGuard {
  let calls = 0
  const missedTermSets: string[][] = []

  return {
    check(terms) {
      calls++
      if (calls > maxCalls) return { blocked: true, reason: 'budget' }
      const termsArr = [...terms]
      if (missedTermSets.some((missed) => isNearDuplicateQuery(termsArr, missed))) {
        return { blocked: true, reason: 'duplicate' }
      }
      return { blocked: false }
    },
    recordMiss(terms) {
      missedTermSets.push([...terms])
    },
  }
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

export interface CorpusStats {
  /** Number of in-scope wiki .md notes the df table below was computed over — the WHOLE vault,
   * not the candidate set a single query happened to match. */
  size: number
  /** Lowercase term -> number of corpus notes whose own tokenizeTerms() set contains it. A term
   * absent from the map has df=0 — genuinely never seen in this corpus snapshot, not "unknown":
   * buildCorpusStats tokenizes every in-scope note, so the map is complete for its snapshot. */
  df: ReadonlyMap<string, number>
}

/** Builds the whole-corpus document-frequency table computeIdf needs: one entry per distinct
 * term across every note, counting how many DISTINCT notes contain it (a term repeated many
 * times within one note still counts once for that note, via tokenizeTerms's per-note Set).
 * Pure/fs-free — brain-search.ts reads the notes off disk, this only tokenizes and counts, so
 * it's unit-testable without touching a filesystem or spawning ripgrep. */
export function buildCorpusStats(notes: readonly { content: string }[]): CorpusStats {
  const df = new Map<string, number>()
  for (const note of notes) {
    for (const term of tokenizeTerms(note.content)) {
      df.set(term, (df.get(term) ?? 0) + 1)
    }
  }
  return { size: notes.length, df }
}

// The bug this fixes: computeIdf used to take its N and df from the CANDIDATE set a single
// ripgrep search happened to match, not the whole vault. Two ways that collapses every term's
// IDF to 0 (informativeTerms then returns [], and the best note is dropped as "no match"):
// (1) a single-candidate result — df=1, N=1, ratio 100% — regardless of how rare the term
// actually is vault-wide; (2) ANY single-term query — ripgrep only returns candidates that
// already contain the term, so df==N is guaranteed for a 1-term query no matter the candidate
// count. Fix: compute df against the WHOLE wiki corpus (CorpusStats, built once per 5-minute
// cache window by brain-search.ts — see its header comment for why exact-token df, not the
// substring match countTermMatches/tf use, is the right tradeoff here) so N and df no longer
// move with how many candidates one query happened to match.
// `df` is floored at 1 so a term absent from the corpus map (shouldn't happen for a term that
// came from an actual ripgrep hit, but a stale/failed corpus build could still miss it) never
// produces Infinity/NaN.
export function computeIdf(args: { corpus: CorpusStats; terms: string[] }): Map<string, number> {
  const { corpus, terms } = args
  const idf = new Map<string, number>()
  if (corpus.size === 0) {
    for (const term of terms) idf.set(term, 0)
    return idf
  }
  for (const term of terms) {
    const df = corpus.df.get(term) ?? 0
    idf.set(term, Math.log(corpus.size / Math.max(1, df)))
  }
  return idf
}

// A term present in more than 60% of the candidate set is corpus noise, not signal, expressed
// as an IDF floor (log(1 / 0.6) ≈ 0.51) so it composes directly with the weighted sum in
// scoreNote and the coverage check in isStrongMatch below.
const INFORMATIVE_DF_RATIO = 0.6
const INFORMATIVE_IDF_FLOOR = -Math.log(INFORMATIVE_DF_RATIO)

/** The subset of `terms` whose IDF clears INFORMATIVE_IDF_FLOOR — i.e. the terms that actually
 * discriminate this note from the rest of the candidate set, as opposed to ones that just
 * happen to be this corpus's own recurring vocabulary. */
export function selectInformativeTerms(terms: readonly string[], idf: ReadonlyMap<string, number>): string[] {
  return terms.filter((t) => (idf.get(t) ?? 0) >= INFORMATIVE_IDF_FLOOR)
}

// Sublinear term-frequency scaling (classic TF-IDF practice: Lucene's default scoring and
// Robertson/Sparck Jones both dampen raw term COUNT the same way) — a note that happens to
// repeat a term many times in passing (measured: a note surveying model IDs across every IU
// gateway leg mentions "deepseek" 17 times) must not outrank a note that is actually ABOUT the
// term but states it more sparingly (measured: the model-routing note itself, 9 mentions) just
// because it is longer or more repetitive. `countTermMatches` still returns the raw count; this
// only shapes how that count turns into score.
function tfWeight(count: number): number {
  return count > 0 ? Math.log(1 + count) : 0
}

export function scoreNote(args: {
  title: string
  frontmatterBlock: string
  body: string
  terms: string[]
  idf: ReadonlyMap<string, number>
}): number {
  const { title, frontmatterBlock, body, terms, idf } = args
  let score = 0
  for (const term of terms) {
    const weight = idf.get(term) ?? 0
    if (weight <= 0) continue
    score +=
      weight * tfWeight(countTermMatches(body, [term])) +
      weight * TITLE_BOOST * tfWeight(countTermMatches(title, [term])) +
      weight * FRONTMATTER_BOOST * tfWeight(countTermMatches(frontmatterBlock, [term]))
  }
  return score
}

// A note qualifies as a "strong match" — the only tier this tool now returns — when it covers
// a meaningful share of the query's informative terms, not just one lucky hit.
const STRONG_MATCH_COVERAGE_RATIO = 0.6

/** True when a note covers ≥60% of the query's informative terms (title, frontmatter, and body
 * all count toward coverage), AND either at least one informative term lands in the title or
 * frontmatter (a note ABOUT the topic) or at least 2 distinct informative terms land in the
 * body (a note that substantively discusses it, not a passing one-word mention). Returns false
 * with no informative terms at all — a query that is 100% corpus noise / stopwords cannot
 * produce a strong match by construction. */
export function isStrongMatch(args: {
  title: string
  frontmatterBlock: string
  body: string
  informativeTerms: readonly string[]
}): boolean {
  const { title, frontmatterBlock, body, informativeTerms } = args
  if (informativeTerms.length === 0) return false

  const titleOrFrontmatterHits = informativeTerms.filter(
    (t) => countTermMatches(title, [t]) > 0 || countTermMatches(frontmatterBlock, [t]) > 0,
  )
  const bodyHits = informativeTerms.filter((t) => countTermMatches(body, [t]) > 0)
  const coveredTerms = new Set([...titleOrFrontmatterHits, ...bodyHits])
  const coverage = coveredTerms.size / informativeTerms.length

  if (coverage < STRONG_MATCH_COVERAGE_RATIO) return false
  return titleOrFrontmatterHits.length >= 1 || bodyHits.length >= 2
}

const PER_NOTE_EXCERPT_CAP = 1_500
// Context window kept around each match — generous enough to carry the surrounding sentence
// without ballooning a dense cluster of hits into a whole-page excerpt.
const EXCERPT_CONTEXT_CHARS = 220

/** Builds excerpt windows around every match location in `body`, merges overlapping windows so a
 * dense cluster of hits doesn't repeat the same sentence three times, and bounds the total to
 * `PER_NOTE_EXCERPT_CAP` chars. Falls back to the note's opening chars if, somehow, no term is
 * found (shouldn't happen — the caller only excerpts notes that already qualified as a strong
 * match). Callers should pass the query's informative terms, not the raw term list, so the
 * excerpt windows form around the words that actually matter rather than this corpus's own
 * recurring vocabulary. */
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

/** Ranks candidates by IDF-weighted score (body matches + title/frontmatter boost), keeps ONLY
 * strong matches (see isStrongMatch — a meaningful share of the query's informative terms, not
 * just one lucky hit on this corpus's own recurring vocabulary), and builds the top results —
 * title, citation url, updated date, bounded excerpt. Returns an empty array when nothing clears
 * the strong-match bar; the caller (buildBrainNotesTool) is responsible for telling the model
 * that and steering it toward a different tool instead of rephrasing. */
export function rankAndBuildNotes(args: {
  candidates: BrainCandidate[]
  terms: string[]
  baseUrl: string | undefined
  corpus: CorpusStats
  maxResults?: number
}): BrainNoteResult[] {
  const { candidates, terms, baseUrl, corpus, maxResults = DEFAULT_MAX_RESULTS } = args

  const idf = computeIdf({ corpus, terms })
  const informativeTerms = selectInformativeTerms(terms, idf)
  const excerptTerms = informativeTerms.length > 0 ? informativeTerms : terms

  const scored = candidates
    .map((c) => {
      const { frontmatter, body: rawBody } = parseFrontmatter(c.content)
      const body = normalizeText(rawBody)
      const title = resolveTitle(c.relPath, frontmatter, body)
      const frontmatterBlock = c.content.match(FRONTMATTER_RE)?.[1] ?? ''
      return { relPath: c.relPath, title, body, frontmatter, frontmatterBlock }
    })
    .filter((c) => isStrongMatch({ title: c.title, frontmatterBlock: c.frontmatterBlock, body: c.body, informativeTerms }))
    .map((c) => ({ ...c, score: scoreNote({ title: c.title, frontmatterBlock: c.frontmatterBlock, body: c.body, terms, idf }) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)

  let excerptBudget = TOTAL_EXCERPT_CAP
  const results: BrainNoteResult[] = []
  for (const c of scored) {
    const url = buildNoteUrl(baseUrl, c.relPath)
    if (!url) continue
    const cap = Math.min(PER_NOTE_EXCERPT_CAP, excerptBudget)
    if (cap <= 0) break
    const excerpt = buildExcerpt(c.body, excerptTerms).slice(0, cap)
    excerptBudget -= excerpt.length
    results.push({ title: c.title, url, updated: resolveUpdatedDate(c.frontmatter), excerpt })
  }
  return results
}
