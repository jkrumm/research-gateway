// Retrieval ledger — the run's record of what was ACTUALLY retrieved, kept in code and
// never asserted by a model. Every claim the pipeline emits is checked against this.
//
// Why it exists: under fetch-provider rate limiting the pipeline used to back-fill claims
// from model priors and ship them as `confidence: "high"` citations pointing at URLs the
// same response listed as unfetchable (issue #1). Prose said "could not fetch"; the
// structured citations said "verified". Citations are what a consuming agent trusts.
//
// Dependency-free by design (only the pure numbers.ts) so it is unit-testable without booting
// the env/LLM import chain — same convention as `assemble.ts` / `extract.ts`.

import { extractNumbers } from './numbers.js'

// Precedence when a URL lands in more than one bucket: retrieved > missing > failed > snippet.
// A page that was successfully read outranks an earlier failed attempt (fetchPage falls
// back to Tavily Extract, so first-attempt failure then success is normal). A page whose
// fetch was ATTEMPTED and failed outranks a search snippet: the run tried to verify it and
// could not, which is exactly the case that must never be citable. `missing` outranks
// `failed` because the origin itself answered — 404/410 is a definitive statement that the
// resource does not exist, not a lost attempt to ask.
export type RetrievalTier = 'retrieved' | 'missing' | 'failed' | 'snippet' | 'unseen'

export interface LedgerSnapshot {
  retrieved: string[]
  missing: Array<{ url: string; reason: string }>
  snippet: string[]
  failed: Array<{ url: string; reason: string }>
  /** Numeric values in the text a model was actually given for a URL (numbers.ts). Optional:
   *  a snapshot from a path that records no text simply has nothing to check against. */
  numbers?: Array<{ url: string; values: number[] }>
}

export interface RetrievalLedger {
  /** Full text of the page was obtained (fetchPage/Tavily Extract/libraryDocs succeeded). */
  recordRetrieved(url: string): void
  /** The origin itself answered 404/410 — the resource definitively does not exist at this URL. */
  recordMissing(url: string, reason: string): void
  /** URL appeared in a search result carrying a content snippet — seen, not read. */
  recordSnippet(url: string): void
  /** A fetch of this URL was attempted and failed (error, refusal, rate limit, empty). */
  recordFailed(url: string, reason: string): void
  /** The text of this URL that a model actually received (fetchPage). Only its numbers are
   *  kept — enough for the numeric-claim check in ground.ts, without holding page text. */
  recordText(url: string, text: string): void
  /** Already-extracted numbers — how mergeLedgers carries a worker's record into the job's. */
  recordNumbers(url: string, values: readonly number[]): void
  /** Numbers the model was shown for this URL, or null when no text was recorded for it — an
   *  unknown page must never read as a page that lacks the number. */
  numbersOf(url: string): readonly number[] | null
  tierOf(url: string): RetrievalTier
  failureReason(url: string): string | null
  /** URLs whose full text was retrieved, in first-seen order, in their original form. */
  retrievedUrls(): string[]
  snapshot(): LedgerSnapshot
}

// Canonical key for comparing a cited URL against a retrieved one. The model routinely
// cites the same page with a fragment, a trailing slash, or a `www.` prefix that the fetch
// did not use — those are the SAME page and must match, or honest citations get dropped.
// Scheme is deliberately excluded (http/https of one host is one page); query IS kept
// (`?v=2` is usually a different document).
export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim()
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return trimmed.toLowerCase()
  }
  const host = parsed.host.toLowerCase().replace(/^www\./, '')
  const path = parsed.pathname.replace(/\/+$/, '')
  return `${host}${path}${parsed.search}`
}

export function createLedger(): RetrievalLedger {
  // normalized key -> original URL as first seen, so the report shows the caller a URL
  // they can click rather than the internal comparison key.
  const retrieved = new Map<string, string>()
  const missing = new Map<string, { url: string; reason: string }>()
  const snippet = new Map<string, string>()
  const failed = new Map<string, { url: string; reason: string }>()
  const numbers = new Map<string, { url: string; values: Set<number> }>()

  const addNumbers = (url: string, values: Iterable<number>): void => {
    const key = normalizeUrl(url)
    const entry = numbers.get(key) ?? { url, values: new Set<number>() }
    for (const v of values) entry.values.add(v)
    numbers.set(key, entry)
  }

  return {
    recordRetrieved(url) {
      const key = normalizeUrl(url)
      if (!retrieved.has(key)) retrieved.set(key, url)
    },
    recordMissing(url, reason) {
      const key = normalizeUrl(url)
      if (!missing.has(key)) missing.set(key, { url, reason })
    },
    recordSnippet(url) {
      const key = normalizeUrl(url)
      if (!snippet.has(key)) snippet.set(key, url)
    },
    recordFailed(url, reason) {
      const key = normalizeUrl(url)
      if (!failed.has(key)) failed.set(key, { url, reason })
    },
    recordText(url, text) {
      // Empty text is not a page that lacks every number — recording it would cap every
      // numeric claim on this URL (review: Tavily Extract can deliver '').
      if (text.trim() === '') return
      addNumbers(url, extractNumbers(text))
    },
    recordNumbers(url, values) {
      addNumbers(url, values)
    },
    numbersOf(url) {
      const entry = numbers.get(normalizeUrl(url))
      return entry ? [...entry.values] : null
    },
    tierOf(url) {
      const key = normalizeUrl(url)
      if (retrieved.has(key)) return 'retrieved'
      if (missing.has(key)) return 'missing'
      if (failed.has(key)) return 'failed'
      if (snippet.has(key)) return 'snippet'
      return 'unseen'
    },
    failureReason(url) {
      // Same precedence as tierOf (missing before failed): mergeLedgers can legitimately
      // record a URL in both maps — one worker times out, another gets a clean 404 — and
      // the reason reported must be the one the resolved tier actually rests on.
      return missing.get(normalizeUrl(url))?.reason ?? failed.get(normalizeUrl(url))?.reason ?? null
    },
    retrievedUrls() {
      return [...retrieved.values()]
    },
    snapshot() {
      return {
        retrieved: [...retrieved.values()],
        missing: [...missing.values()],
        snippet: [...snippet.values()],
        failed: [...failed.values()],
        numbers: [...numbers.values()].map((e) => ({ url: e.url, values: [...e.values] })),
      }
    },
  }
}

// Union of per-worker ledgers into the job-level ledger used to ground the final report.
// Precedence is preserved by construction: tierOf resolves retrieved > missing > failed >
// snippet, so a page one worker read is citable even if another worker's attempt at it
// failed.
export function mergeLedgers(snapshots: LedgerSnapshot[]): RetrievalLedger {
  const merged = createLedger()
  for (const snap of snapshots) {
    for (const url of snap.retrieved) merged.recordRetrieved(url)
    for (const m of snap.missing) merged.recordMissing(m.url, m.reason)
    for (const url of snap.snippet) merged.recordSnippet(url)
    for (const f of snap.failed) merged.recordFailed(f.url, f.reason)
    for (const n of snap.numbers ?? []) merged.recordNumbers(n.url, n.values)
  }
  return merged
}
