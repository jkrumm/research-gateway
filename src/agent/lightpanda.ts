// Client side of the JavaScript-rendering sidecar (see ../../lightpanda/).
//
// The sidecar runs a real browser engine on our own infrastructure, which is what this step
// was missing while it went through Jina: no third party sees the URLs this service reads, and
// there is no per-minute quota to run into. What it costs is a container — the reasoning for
// that shape, and the measurements behind the memory numbers, live in lightpanda/server.ts
// rather than here, because that is where the budget is enforced.
//
// This module is only the envelope check, and it is deliberately paranoid about a shape that
// SAYS it succeeded. Two separate incidents in this chain's history were a 200 response
// carrying a non-page (Reddit's 8 KB JavaScript shell; Jina's `Warning: Target URL returned
// error 403` over an HTTP 200), and the sidecar already applies the same floor on its side.
// Applying it again here is not redundancy for its own sake: it is the boundary where a
// sidecar bug, a version skew, or something else answering on that port stops being able to
// put un-retrieved text into a report.
//
// Dependency-free by design (no env/fetch import) so the parser is unit-testable — same
// convention as ledger.ts / extract.ts / jina.ts.

// Same 200-char floor as Readability in tools.ts and parseJinaResponse, for the same reason.
const MIN_CONTENT_CHARS = 200

export type LightpandaResult = { ok: true; text: string } | { ok: false; error: string }

export function renderUrl(base: string): string {
  return `${base.replace(/\/+$/, '')}/render`
}

export function parseRenderResponse(httpStatus: number, body: unknown): LightpandaResult {
  // A non-2xx means the SIDECAR is broken or unreachable — distinct from a page that would not
  // render, which the sidecar reports as a 200 with `ok: false`. Worth keeping distinguishable
  // in the logs: one is a page, the other is an outage.
  if (httpStatus < 200 || httpStatus >= 300) {
    return { ok: false, error: `sidecar HTTP ${httpStatus}` }
  }

  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'sidecar returned a non-object body' }
  }

  const envelope = body as Record<string, unknown>
  if (envelope['ok'] !== true) {
    const error = envelope['error']
    return { ok: false, error: typeof error === 'string' ? error : 'sidecar reported failure' }
  }

  const text = typeof envelope['text'] === 'string' ? envelope['text'].trim() : ''
  if (text.length < MIN_CONTENT_CHARS) {
    return { ok: false, error: `sidecar reported success with ${text.length} chars of content` }
  }

  return { ok: true, text }
}
