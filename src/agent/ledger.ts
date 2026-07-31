// Retrieval ledger — the run's record of what was ACTUALLY retrieved, kept in code and
// never asserted by a model. Every claim the pipeline emits is checked against this.
//
// Why it exists: under fetch-provider rate limiting the pipeline used to back-fill claims
// from model priors and ship them as `confidence: "high"` citations pointing at URLs the
// same response listed as unfetchable (issue #1). Prose said "could not fetch"; the
// structured citations said "verified". Citations are what a consuming agent trusts.
//
// Dependency-free by design (no project imports) so it is unit-testable without booting
// the env/LLM import chain — same convention as `assemble.ts` / `extract.ts`.

// Precedence when a URL lands in more than one bucket: retrieved > failed > snippet.
// A page that was successfully read outranks an earlier failed attempt (fetchPage falls
// back to Tavily Extract, so first-attempt failure then success is normal). A page whose
// fetch was ATTEMPTED and failed outranks a search snippet: the run tried to verify it and
// could not, which is exactly the case that must never be citable.
export type RetrievalTier = 'retrieved' | 'failed' | 'snippet' | 'unseen'

export interface LedgerSnapshot {
  retrieved: string[]
  snippet: string[]
  failed: Array<{ url: string; reason: string }>
}

export interface RetrievalLedger {
  /** Full text of the page was obtained (fetchPage/Tavily Extract/libraryDocs succeeded). */
  recordRetrieved(url: string): void
  /** URL appeared in a search result carrying a content snippet — seen, not read. */
  recordSnippet(url: string): void
  /** A fetch of this URL was attempted and failed (error, refusal, rate limit, empty). */
  recordFailed(url: string, reason: string): void
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
  const snippet = new Map<string, string>()
  const failed = new Map<string, { url: string; reason: string }>()

  return {
    recordRetrieved(url) {
      const key = normalizeUrl(url)
      if (!retrieved.has(key)) retrieved.set(key, url)
    },
    recordSnippet(url) {
      const key = normalizeUrl(url)
      if (!snippet.has(key)) snippet.set(key, url)
    },
    recordFailed(url, reason) {
      const key = normalizeUrl(url)
      if (!failed.has(key)) failed.set(key, { url, reason })
    },
    tierOf(url) {
      const key = normalizeUrl(url)
      if (retrieved.has(key)) return 'retrieved'
      if (failed.has(key)) return 'failed'
      if (snippet.has(key)) return 'snippet'
      return 'unseen'
    },
    failureReason(url) {
      return failed.get(normalizeUrl(url))?.reason ?? null
    },
    retrievedUrls() {
      return [...retrieved.values()]
    },
    snapshot() {
      return {
        retrieved: [...retrieved.values()],
        snippet: [...snippet.values()],
        failed: [...failed.values()],
      }
    },
  }
}

// Union of per-worker ledgers into the job-level ledger used to ground the final report.
// Precedence is preserved by construction: tierOf resolves retrieved > failed > snippet,
// so a page one worker read is citable even if another worker's attempt at it failed.
export function mergeLedgers(snapshots: LedgerSnapshot[]): RetrievalLedger {
  const merged = createLedger()
  for (const snap of snapshots) {
    for (const url of snap.retrieved) merged.recordRetrieved(url)
    for (const url of snap.snippet) merged.recordSnippet(url)
    for (const f of snap.failed) merged.recordFailed(f.url, f.reason)
  }
  return merged
}
