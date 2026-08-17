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
// YouTube is the third entry, and the evidence is a different SHAPE of failure than Reddit's.
// Reddit's generic path returns almost nothing (an 8 KB JS shell); YouTube's returns a
// SUCCESS-SHAPED FAILURE — measured 2026-08-06, `fetchPage` on a `watch?v=` URL terminates at
// the lightpanda step with ~1,731 chars of player chrome ("Tap to unmute", "If playback
// doesn't begin shortly"). That clears `MIN_USABLE_CHARS` (200) and every other success check
// in fetch-chain.ts, so `ledger.recordRetrieved(url)` fires and a worker can cite a video at
// `high` confidence having read the player's loading text, not the talk. This is a grounding
// hazard independent of transcripts — it would matter even if step 3 never ran.
//
// Step 3 (Tavily Extract, already wired) is what actually reads YouTube: MEASURED against
// `youtube.com/watch?v=...` — 23,265 chars for a 26-min talk, 218,361 for a 3h podcast, 22,035
// for a 20-min video. It just never gets the chance, because steps 1-2 "succeed" first. Hence
// `plan()` below: skip straight to Extract for any URL this module can turn into a watch URL,
// rather than let a real transcript lose to 1.7 KB of chrome.
//
// URL shape matters and was measured, not assumed: `youtube.com/watch?v=<id>` works against
// Extract; `youtu.be/<id>` and `youtube.com/shorts/<id>` both fail ("Error fetching content");
// `youtube.com/@channel` 404s. So this adapter canonicalises to the one shape that works
// (`youtube.ts`'s `canonicalYoutubeWatchUrl`) and only routes true watch URLs to Extract — a
// shorts/channel/playlist/results URL declines (`plan` returns null) and falls through to the
// generic path unchanged, exactly as if YouTube had no adapter at all.
//
// Dependency-free by design (no env/log/fetch import) so it stays unit-testable — same
// convention as ledger.ts / extract.ts / cost.ts.

import { extractRedditThread, type MinimalDocument } from './extract-reddit.js'
import { canonicalYoutubeWatchUrl } from './youtube.js'

export interface SiteAdapter {
  /** Rewrite the address actually dialled. The caller keeps the original for the ledger. */
  rewriteHost?: string
  /** Read the fetched document. Returns null to fall through to Readability. */
  extract?: (document: MinimalDocument) => string | null
  /**
   * Per-URL routing for hosts where the right handling depends on the path, not just the
   * host — a watch URL needs Extract, a channel page must not be sent there. Returns null to
   * decline — the URL then falls through to the generic path unchanged, exactly as if this
   * host had no adapter.
   */
  plan?: (parsed: URL) => { fetchUrl: string; skipToExtract: boolean } | null
}

// dpreview forum threads are cited by their slug URL, and the slug URL is unreadable: MEASURED
// 2026-08-17 on the astrophotography XF 16mm thread, `www.dpreview.com/forums/threads/<slug>.
// 4455495` answers 403 to plain fetch, 403 to lightpanda, AND fails Tavily Extract ("Failed to
// fetch url") — every generic-path step fails. The NUMERIC form of the same thread,
// `dpreview.com/forums/thread/<id>` (singular "thread", no slug), succeeds via Tavily Extract
// at 80,181 chars; a nonexistent id (`/forums/thread/4300000`) returns nothing, so this is a
// real per-thread route, not a generic shell that would "succeed" on any id. The trailing
// dot-number in the slug URL IS that id, so this adapter rewrites rather than looks anything
// up. The live rewrite is preferred over the Wayback rescue below for this host because it
// returns CURRENT content — the archived snapshot of this exact thread is from 2023.
const dpreviewAdapter: SiteAdapter = {
  plan: (parsed) => {
    // A trailing slash is tolerated because models cite both forms of the same thread.
    const match = /^\/forums\/threads\/.+\.(\d+)\/?$/.exec(parsed.pathname)
    if (!match?.[1]) return null // non-forum URL, or a slug with no trailing numeric id
    return { fetchUrl: `https://www.dpreview.com/forums/thread/${match[1]}`, skipToExtract: false }
  },
}

// One video URL can skip straight to Tavily Extract, bypassing the plain-fetch and
// lightpanda steps entirely — see the header comment for why (a success-shaped failure at
// ~1,731 chars of player chrome, not a thin-content miss those steps would otherwise catch).
const youtubeAdapter: SiteAdapter = {
  plan: (parsed) => {
    const canonical = canonicalYoutubeWatchUrl(parsed.toString())
    return canonical ? { fetchUrl: canonical, skipToExtract: true } : null
  },
}

// Keyed by lowercase host of the ORIGINAL url.
const ADAPTERS: Record<string, SiteAdapter> = {
  'www.reddit.com': { rewriteHost: 'old.reddit.com', extract: extractRedditThread },
  'reddit.com': { rewriteHost: 'old.reddit.com', extract: extractRedditThread },
  // old.reddit.com may also be cited directly by a model, in which case there is nothing to
  // rewrite but the comment-tree extractor still applies.
  'old.reddit.com': { extract: extractRedditThread },
  'youtube.com': youtubeAdapter,
  'www.youtube.com': youtubeAdapter,
  'm.youtube.com': youtubeAdapter,
  'music.youtube.com': youtubeAdapter,
  'youtu.be': youtubeAdapter,
  'dpreview.com': dpreviewAdapter,
  'www.dpreview.com': dpreviewAdapter,
}

export interface ResolvedSite {
  /** The URL to fetch — identical to the input unless an adapter rewrites the host. */
  fetchUrl: string
  /** Site-specific reader, or null to use Readability. */
  extract: ((document: MinimalDocument) => string | null) | null
  /** True when the fetch chain should skip straight to Tavily Extract (see youtubeAdapter). */
  skipToExtract: boolean
}

export function resolveSite(raw: string): ResolvedSite {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return { fetchUrl: raw, extract: null, skipToExtract: false } // the SSRF guard rejects it downstream
  }

  const adapter = ADAPTERS[parsed.host.toLowerCase()]
  if (!adapter) return { fetchUrl: raw, extract: null, skipToExtract: false }

  if (adapter.plan) {
    try {
      const planned = adapter.plan(parsed)
      if (planned) {
        return { fetchUrl: planned.fetchUrl, extract: adapter.extract ?? null, skipToExtract: planned.skipToExtract }
      }
      // null = decline (e.g. a shorts/channel/playlist/results URL) — fall through to
      // rewriteHost/extract below exactly as if there were no `plan` at all.
    } catch {
      // A planning error must degrade to the generic path, not take the fetch down with it.
    }
  }

  if (adapter.rewriteHost) parsed.host = adapter.rewriteHost
  return { fetchUrl: parsed.toString(), extract: adapter.extract ?? null, skipToExtract: false }
}
