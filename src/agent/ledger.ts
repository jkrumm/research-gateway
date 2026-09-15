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

// Split a URL into its normalized host plus the case-preserved remainder. ONE parse rule for
// every consumer in this module and the body scanner — `normalizeUrl` builds on it, and so
// does the body matcher, so they cannot diverge on scheme-less input, `www.`, or a port.
//
// `rest` (path + query) and `hash` are returned separately because the two consumers need
// different fragment semantics: for CITATION matching a fragment identifies a section of the
// same page and is dropped, while the body matcher keeps it (see body-mentions.ts).
//
// Returns null for anything that is not a comparable http(s) web page, which is the honest
// answer for an opaque URI or a bare email address: neither has a host, and inventing one
// collides with real pages (see the two guards below).
export function urlParts(raw: string): { host: string; rest: string; hash: string } | null {
  const t = raw.trim()
  // A bare email address is not a web page. Prepending `https://` would make
  // `https://user@example.com` parse the part after the `@` as a HOST, canonicalizing
  // `user@example.com` to `example.com` — colliding with the real page `https://example.com`,
  // so one bogus `unverified` entry could suppress citations to an unrelated site. Only
  // applies with no scheme: `https://user@example.com` is a legitimate (if rare) URL form.
  if (!hasScheme(t) && /^[^/\s]*@/.test(t)) return null
  let parsed: URL
  try {
    parsed = new URL(withScheme(t))
  } catch {
    return null
  }
  // Only http(s) is a comparable web page. An opaque scheme (`mailto:`, `xmpp:`) parses with
  // an empty host, and returning null lets `normalizeUrl` fall back to the raw string rather
  // than collapsing every `mailto:` to the same key.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  const host = parsed.host.toLowerCase().replace(/^www\./, '')
  const path = parsed.pathname.replace(/\/+$/, '')
  return { host, rest: `${path}${parsed.search}`, hash: parsed.hash }
}

// Whether the string already carries a URI scheme. Any scheme counts, not just `scheme://`:
// an opaque URI (`mailto:user@example.com`) treated as scheme-less got `https://` prepended
// on top, and the part before the `@` then parsed as a host — the collision described above.
//
// The `(?!\d)` is what keeps a `host:port` from being read as a scheme: `nunu.gg:8443` looks
// like `scheme:` to a naive pattern, and misreading it would stop the scheme being prepended
// and break every ported URL.
function hasScheme(s: string): boolean {
  return /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s)
}

// Canonical key for comparing a cited URL against a retrieved one. The model routinely
// cites the same page with a fragment, a trailing slash, or a `www.` prefix that the fetch
// did not use — those are the SAME page and must match, or honest citations get dropped.
// Scheme is deliberately excluded (http/https of one host is one page); query IS kept
// (`?v=2` is usually a different document).
//
// The scheme-prepend fallback lives in `urlParts`. Without it a scheme-less
// input like `www.nunu.gg/patch-notes` fails `new URL()` and lands in the catch, which
// lowercases the whole raw string — keeping `www.` and lowercasing the PATH, contradicting
// this module's own rule that host case is insignificant and path case is not.
export function normalizeUrl(raw: string): string {
  const parts = urlParts(raw)
  if (!parts) return raw.trim().toLowerCase()
  return `${parts.host}${parts.rest}`
}

// Prepend `https://` unless the string already carries a scheme. One copy of this rule:
// `normalizeUrl`'s callers and the body scanner all need it, and a second hand-tuned copy is
// exactly the drift this module's own comments warn about.
function withScheme(raw: string): string {
  return hasScheme(raw) ? raw : `https://${raw}`
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
