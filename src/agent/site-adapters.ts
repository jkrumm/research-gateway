// Per-site handling for pages the generic path cannot read.
//
// The generic path is: fetch the URL, run Mozilla Readability. It works for the large
// majority of the web and nothing here should erode that. But two failure shapes are not
// fixable by a better parser, and both were measured rather than assumed:
//
//   1. The origin refuses bots. Reddit answers this crawler with HTTP 200 and an ~8 KB
//      JavaScript shell (www.reddit.com 8,497 bytes vs old.reddit.com 266,954 for the same
//      thread). No extractor can recover text that was never sent. Jina Reader and Reddit's
//      own `/.json` endpoint both return 403 to an anonymous client, so this is not a case
//      of reaching for a shortcut instead of a general tool — the alternate origin is the
//      only unauthenticated path that works.
//   2. The page is not an article. Readability keeps a Reddit submission and discards the
//      comment tree, which is the entire reason the thread is worth reading: 2,729 chars
//      kept vs 37,963 discarded on a 1814-comment thread.
//
// So an adapter can change WHERE we fetch, HOW we read it, or both. It is keyed on the host
// of the URL the model was given, NOT on whether a rewrite happened — an earlier version
// used "was this URL rewritten?" as the signal to run the Reddit extractor, which would have
// pointed the Reddit extractor at the next site's markup the moment a second entry existed.
//
// Adding an entry should require the same evidence Reddit needed: a measurement showing the
// generic path fails, and a measurement showing the replacement works. The signal that a new
// site needs one is already in the logs — `tool.fetchPage` records `rdReason: 'thin'` with
// `rdChars` whenever Readability returned almost nothing and the Tavily-Extract fallback had
// to run. Recurring hosts there are the candidates.
//
// Dependency-free by design (no env/log/fetch import) so it stays unit-testable — same
// convention as ledger.ts / extract.ts / cost.ts.

import { extractRedditThread, type MinimalDocument } from './extract-reddit.js'

export interface SiteAdapter {
  /** Rewrite the address actually dialled. The caller keeps the original for the ledger. */
  rewriteHost?: string
  /** Read the fetched document. Returns null to fall through to Readability. */
  extract?: (document: MinimalDocument) => string | null
}

// Keyed by lowercase host of the ORIGINAL url.
const ADAPTERS: Record<string, SiteAdapter> = {
  'www.reddit.com': { rewriteHost: 'old.reddit.com', extract: extractRedditThread },
  'reddit.com': { rewriteHost: 'old.reddit.com', extract: extractRedditThread },
  // old.reddit.com may also be cited directly by a model, in which case there is nothing to
  // rewrite but the comment-tree extractor still applies.
  'old.reddit.com': { extract: extractRedditThread },
}

export interface ResolvedSite {
  /** The URL to fetch — identical to the input unless an adapter rewrites the host. */
  fetchUrl: string
  /** Site-specific reader, or null to use Readability. */
  extract: ((document: MinimalDocument) => string | null) | null
}

export function resolveSite(raw: string): ResolvedSite {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return { fetchUrl: raw, extract: null } // the SSRF guard rejects it downstream
  }

  const adapter = ADAPTERS[parsed.host.toLowerCase()]
  if (!adapter) return { fetchUrl: raw, extract: null }

  if (adapter.rewriteHost) parsed.host = adapter.rewriteHost
  return { fetchUrl: parsed.toString(), extract: adapter.extract ?? null }
}
