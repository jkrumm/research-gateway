import { readBoundedText, MAX_BODY_BYTES, type OversizedInfo } from '../lib/bounded-read.js'

// Env- and log-free by design (same convention as bounded-read.ts / ledger.ts / extract.ts) so
// the gated arXiv fetch is unit-testable with a stubbed `fetch`, without booting env.ts's
// required-var validation.

const UA = 'research-gateway/0.1 (+research bot)'
const TIMEOUT_MS = 10_000

export type ArxivFeedResult = { ok: true; text: string } | { ok: false; error: string }

// The gated operation itself — fetch AND read the body, not just fetch. export.arxiv.org's
// policy is ONE connection at a time, so the gate (rate-gate.ts, direct-sources.ts's
// `arxivGate`) must hold the queue until the response body has actually been consumed, not
// merely until `fetch()`'s promise settles (which happens on receipt of headers, long before
// the body is drained). Releasing early there let a second worker's request open a concurrent
// connection while this one's body was still streaming — the same reasoning applies to a
// non-ok response: its body must be drained/cancelled before returning, or the gate advances
// while the socket may still be open.
export async function fetchArxivFeed(url: string, onOversized?: (info: OversizedInfo) => void): Promise<ArxivFeedResult> {
  const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) {
    await res.body?.cancel().catch(() => {})
    return { ok: false, error: `HTTP ${res.status} ${res.statusText}` }
  }
  // Bounded like every other network body in this file — an unbounded `res.text()` was the
  // only such read left here.
  const { text, truncated } = await readBoundedText(res, MAX_BODY_BYTES, onOversized)
  if (truncated) return { ok: false, error: `response exceeds ${MAX_BODY_BYTES} byte cap` }
  return { ok: true, text }
}
