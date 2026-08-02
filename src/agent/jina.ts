// Jina Reader (r.jina.ai) as the JavaScript-rendering step in the fetch chain.
//
// Chosen over the alternatives on operational footprint, against a measured constraint: this
// service's container runs under a 512 MiB limit and currently uses 151 MiB. Bundling
// Playwright (300-500 MB RAM per page) does not fit; a Browserless sidecar is a 1.25-2.8 GB
// image for a few percentage points of fetch failures. Cloudflare Browser Rendering has the
// same zero footprint but announces itself as a bot by cryptographic signature and is capped
// at 1 request / 10s on the free tier. Jina renders with headless Chrome server-side, costs
// nothing here, and is the only zero-footprint option that also carries a proxy pool.
//
// The trade being made deliberately: the URLs this service fetches are visible to a third
// party. That is why it is opt-in — the step is inert until JINA_API_KEY is set, following
// the same pattern as CONTEXT7_API_KEY.
//
// Dependency-free by design (no env/fetch import) so the parser is unit-testable — same
// convention as ledger.ts / extract.ts / cost.ts.

// Jina answers a blocked target with HTTP **200** and puts the failure in the body:
//
//   Title:
//   URL Source: https://www.reddit.com/...
//   Warning: Target URL returned error 403: Forbidden
//   Markdown Content:
//   You've been blocked by network security.
//
// Taking that at face value would record "You've been blocked by network security" as
// retrieved page content and let a citation rest on it — the same silently-empty-page class
// that made Reddit worth fixing. So the warning line is load-bearing and must be detected.
// `[ \t]*`, not `\s*`: `\s` matches newlines, so an empty `Title:` / `Warning:` line would
// let the capture group swallow the NEXT line instead of failing to match. Caught by a test
// that fed in the empty-title shape Jina actually emits.
const WARNING_RE = /^Warning:[ \t]*(.+)$/m

// Everything before this marker is Jina's own header block (Title / URL Source / Warning),
// not page content.
const CONTENT_MARKER = 'Markdown Content:'

// Below this, whatever came back is a stub rather than a page — same 200-char floor
// Readability is held to in tools.ts, for the same reason.
const MIN_CONTENT_CHARS = 200

export type JinaResult = { ok: true; text: string } | { ok: false; error: string }

export function parseJinaResponse(body: string): JinaResult {
  const warning = WARNING_RE.exec(body)
  if (warning) return { ok: false, error: `jina: ${warning[1]!.trim()}` }

  const markerAt = body.indexOf(CONTENT_MARKER)
  const content = (markerAt >= 0 ? body.slice(markerAt + CONTENT_MARKER.length) : body).trim()

  if (content.length < MIN_CONTENT_CHARS) {
    return { ok: false, error: `jina returned ${content.length} chars of content` }
  }

  // The title line is worth keeping — it is often the only place the page's subject appears
  // once the chrome is stripped, and workers cite by topic.
  const title = /^Title:[ \t]*(.+)$/m.exec(body)?.[1]?.trim()
  return { ok: true, text: title ? `${title}\n\n${content}` : content }
}

export function jinaUrl(target: string): string {
  return `https://r.jina.ai/${target}`
}
