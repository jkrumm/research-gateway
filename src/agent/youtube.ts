// Pure YouTube helpers — URL canonicalisation, keyless search-page parsing, duration parsing.
//
// Dependency-free by design (no env/fetch/log import) so this stays unit-testable without
// booting the env-parsing chain — same convention as ledger.ts / extract.ts / academic.ts.
//
// Why canonicalisation matters (MEASURED against Tavily Extract from the VPS, 2026-08-06):
// `youtube.com/watch?v=<id>` returns the full transcript (23,265 / 218,361 / 22,035 chars on
// three test videos); `youtu.be/<id>` and `youtube.com/shorts/<id>` both fail outright
// ("Error fetching content"), and `youtube.com/@channel` 404s. A model routinely cites the
// short form or a channel/shorts link it found in search results — this module is what turns
// any of those into the one shape that actually works, or tells the caller it can't.
//
// Why search parsing exists at all: `GET youtube.com/results?search_query=...&hl=en` with a
// browser UA returns ~1.6 MB of HTML containing `var ytInitialData = {...};</script>` —
// keyless, no API key, no quota. Walking it for `videoRenderer` nodes is the only way to get
// candidate videos (with duration — the decisive signal, see direct-sources.ts) without one.

export interface YoutubeVideo {
  videoId: string
  title: string
  channel: string | null
  durationText: string | null
  durationSeconds: number | null
  publishedText: string | null
  viewsText: string | null
  /** Always the canonical `https://www.youtube.com/watch?v=<id>` — the one URL shape that
   *  Tavily Extract can actually read (see the header comment above). */
  url: string
}

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

// `ytInitialData` renders every text field as either `{ simpleText }` or `{ runs: [{ text }] }`
// — never both — so this is the one place that needs to know which.
function runText(run: unknown): string {
  if (!run || typeof run !== 'object') return ''
  const text = (run as Record<string, unknown>)['text']
  return typeof text === 'string' ? text : ''
}

function textOf(node: unknown): string | null {
  if (!node || typeof node !== 'object') return null
  const obj = node as Record<string, unknown>
  if (typeof obj['simpleText'] === 'string') return obj['simpleText']
  if (Array.isArray(obj['runs'])) {
    const joined = obj['runs'].map(runText).join('')
    return joined.length > 0 ? joined : null
  }
  return null
}

// `ytInitialData` is a deeply nested, undocumented render tree — a `videoRenderer` can sit at
// any depth under any key. Walking every value rather than pattern-matching a known path is
// what survives YouTube reshuffling the tree around it, which it does routinely.
function collectVideoRenderers(node: unknown, out: unknown[]): void {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) collectVideoRenderers(item, out)
    return
  }
  const obj = node as Record<string, unknown>
  if ('videoRenderer' in obj) out.push(obj['videoRenderer'])
  for (const value of Object.values(obj)) collectVideoRenderers(value, out)
}

export function parseYoutubeSearch(html: string, limit: number): YoutubeVideo[] {
  // The tool's zod schema enforces min(1), but this is exported as general-purpose pure logic
  // like everything else in this file — and the loop below pushes before it checks, so a
  // limit of 0 would otherwise return one result.
  if (limit <= 0) return []

  const match = /var ytInitialData = (\{.*?\});<\/script>/s.exec(html)
  if (!match) return []

  let data: unknown
  try {
    data = JSON.parse(match[1] as string)
  } catch {
    return []
  }

  const renderers: unknown[] = []
  collectVideoRenderers(data, renderers)

  const seen = new Set<string>()
  const results: YoutubeVideo[] = []
  for (const renderer of renderers) {
    if (!renderer || typeof renderer !== 'object') continue
    const v = renderer as Record<string, unknown>
    const videoId = typeof v['videoId'] === 'string' ? v['videoId'] : null
    if (!videoId || seen.has(videoId)) continue
    seen.add(videoId)

    const durationText = textOf(v['lengthText'])
    results.push({
      videoId,
      title: textOf(v['title']) ?? '',
      channel: textOf(v['ownerText']),
      durationText,
      durationSeconds: parseDurationSeconds(durationText),
      publishedText: textOf(v['publishedTimeText']),
      viewsText: textOf(v['viewCountText']),
      url: `https://www.youtube.com/watch?v=${videoId}`,
    })

    if (results.length >= limit) break
  }

  return results
}
