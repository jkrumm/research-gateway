// Pure YouTube helpers — URL canonicalisation and duration parsing.
//
// Dependency-free by design (no env/fetch/log import) so this stays unit-testable without
// booting the env-parsing chain — same convention as ledger.ts / extract.ts / academic.ts.
//
// Why canonicalisation matters (MEASURED against Tavily Extract from the VPS, 2026-08-06):
// `youtube.com/watch?v=<id>` returns the full transcript (23,265 / 218,361 / 22,035 chars on
// three test videos); `youtu.be/<id>` and `youtube.com/shorts/<id>` both fail outright
// ("Error fetching content"), and `youtube.com/@channel` 404s. A model routinely cites the
// short form or a channel/shorts link it found in search results — this module is what turns
// any of those into the one shape that actually works, or tells the caller it can't. That
// canonical shape is also the ledger key both the yt-dlp transcript step and yt-dlp video
// search (agent/ytdlp.ts) are checked against.
//
// Search parsing used to live here too — a keyless scrape of youtube.com's search-results
// HTML, walking the embedded `ytInitialData` blob for `videoRenderer` nodes. It is gone:
// `findVideos` (direct-sources.ts) now calls `searchYoutube` (ytdlp.ts), which asks
// `yt-dlp --flat-playlist -J` for the same fields directly — 9,795 bytes in 2,712 ms
// (MEASURED 2026-08-06) versus ~1.3 MB of undocumented, regularly-reshuffled HTML.

// Hosts that carry a video id in the `v` query param on a `/watch` path. Anything else on
// these hosts — `/shorts/<id>`, `/@channel`, `/results`, `/playlist`, a bare host — is
// deliberately NOT handled here: it either isn't a single video, or (shorts) is a shape
// measured to fail Extract regardless of canonicalisation.
const WATCH_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'])

// YouTube video ids are 11 chars in every id seen in the wild, but the exact grammar isn't
// documented anywhere authoritative — this range is a deliberately generous sanity check
// against `youtu.be/<garbage>` and similar, not a strict validator.
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{6,20}$/

export function canonicalYoutubeWatchUrl(raw: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  // Only http(s) input canonicalises. Nothing dangerous reaches the network either way — the
  // fetch chain's SSRF guard runs on the canonical HTTPS address it actually dials, not on
  // this input — and ledger.normalizeUrl excludes the scheme, so an `http://` form already
  // shares a key with the `https://` one that gets fetched. This is a tidiness guard: a
  // non-web scheme is not a video URL, so it should decline rather than be rewritten into one.
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  const host = parsed.host.toLowerCase()

  if (WATCH_HOSTS.has(host)) {
    // Deliberately exact-match `/watch`, not "starts with" — this is what excludes
    // `/shorts/<id>`, `/@channel`, `/results`, `/playlist` and a bare host without a
    // separate branch per rejected path.
    if (parsed.pathname !== '/watch') return null
    const id = parsed.searchParams.get('v')
    if (!id || !VIDEO_ID_RE.test(id)) return null
    return `https://www.youtube.com/watch?v=${id}`
  }

  if (host === 'youtu.be') {
    const id = parsed.pathname.replace(/^\/+/, '').split('/')[0]
    if (!id || !VIDEO_ID_RE.test(id)) return null
    return `https://www.youtube.com/watch?v=${id}`
  }

  return null
}

// `1:48:20` (H:MM:SS) -> 6500, `2:46` (M:SS) -> 166. Anything else (null, empty, "LIVE", a
// stray word) returns null rather than a wrong number — a missing duration is honest, a
// silently-wrong one is not.
export function parseDurationSeconds(text: string | null): number | null {
  if (!text) return null
  const trimmed = text.trim()
  if (!/^\d{1,2}(:\d{2}){1,2}$/.test(trimmed)) return null

  const parts = trimmed.split(':').map(Number)
  if (parts.some((p) => !Number.isFinite(p))) return null

  return parts.reduce((seconds, part) => seconds * 60 + part, 0)
}
