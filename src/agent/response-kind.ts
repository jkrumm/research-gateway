// How to treat an HTTP response before any extractor sees it.
//
// Two decisions the fetch chain makes at its first step, both measured into existence on
// 2026-08-03 by scripts/fetch-bench.ts and both cheap to get wrong silently.
//
// Dependency-free by design (no env/log/fetch import) so it stays unit-testable — same
// convention as ledger.ts / extract.ts / lightpanda.ts / site-adapters.ts.

// Content types that ARE the answer, rather than a document containing one.
//
// Measured on services.surfline.com: the VPS fetched the API successfully, then threw the
// response away because linkedom+Readability cannot build a document from JSON ("First
// argument to Readability constructor should be a document object"). The chain then spent a
// render and a third-party round trip — 12.9s — recovering text it had already held at
// 228ms. Any JSON/CSV/plain-text URL a model cites hits this, so it is not a Surfline quirk;
// it is a hole under the whole chain.
//
// These bodies also get a different length floor at the call site: the 200-char floor exists
// because HTML can carry a page whose text is not in it, which a renderer can fix. A server
// that answered with JSON has already given us everything it has — `{"version":"1.2.3"}` is
// a complete answer at 19 characters, and no renderer improves on it.
const RAW_CONTENT_TYPES = [
  'application/json',
  '+json', // application/vnd.api+json, application/ld+json, ...
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/tab-separated-values',
  'application/xml',
  'text/xml',
  '+xml', // application/rss+xml, application/atom+xml
  'application/yaml',
  'text/yaml',
]

/**
 * True when the body should be handed back verbatim instead of parsed as a document.
 * Tolerant of parameters and casing (`Application/JSON; charset=utf-8`).
 */
export function isRawContentType(contentType: string | null | undefined): boolean {
  if (!contentType) return false
  const value = contentType.toLowerCase()
  // `text/html` must never match — it is the one type the whole extraction chain is for.
  if (value.includes('text/html') || value.includes('application/xhtml')) return false
  return RAW_CONTENT_TYPES.some((t) => value.includes(t))
}

// HTTP statuses where no other client, renderer or third party can help: the resource is
// definitively absent. Short-circuiting them is worth real time and money — measured, a
// hallucinated GitHub path burned 10.1s dragging a known 404 through the renderer, Jina (now
// retired) and a BILLED Tavily Extract call, all four of which saw the same 404.
//
// Deliberately NOT 401/403: those mean "not to you, like this", and a different client often
// does get through — Medium 403s the renderer on pages a plain fetch reads at step one. Only
// 404 and 410 assert that the thing does not exist.
//
// The trade, stated: a site that 404s this crawler but serves a browser now fails fast
// instead of being rescued by a later step. That is rare, and it is the same bet the 404
// hint in githubFile already makes.
const DEFINITIVE_MISSING = new Set([404, 410])

// The largest body the chain will hand to the synchronous parsers (linkedom's parseHTML +
// Readability, and the site adapters that read the same document) — in CHARACTERS of the
// response text, a proxy for the DOM size the parser will build.
//
// Measured into existence on 2026-09-20: the fetch chain runs those parsers INLINE on the
// event loop every job shares (one Bun process — src/index.ts has a single listener), so one
// oversized page stalls heartbeats (job-store.ts reaps on a 90s-stale heartbeat, even on a
// live process), the idle watchdog, and the HTTP listener together; the fully-developed
// shape is the 2026-08-06 wedge in docs/measurements.md (listener dead while jobs kept
// running). 2M chars is far above any real article page (typical: <200k) so the cap never
// bites honest traffic, but bounds the worst-case synchronous parse to a fraction of a
// second instead of seconds-plus GC.
//
// Over-cap is a MISS like any other, not an error: the chain falls through to lightpanda
// (a real browser in its own process and memory budget — exactly the right reader for a
// page too heavy for this one) and then Tavily Extract. `wayback` applies the same cap —
// an archived copy of a huge page is just as capable of stalling the loop.
//
// This cap bounds only what the PARSER is handed. It is applied to an already-materialized
// string, so on its own it leaves the download, the UTF-8 decode and the allocation in front
// of it unbounded — which is what MAX_BODY_BYTES below is for. The two are a pair.
export const PARSE_INPUT_CAP = 2_000_000

// The largest response body `safeFetch` will download and decode, in BYTES.
//
// `await res.text()` was the hole PARSE_INPUT_CAP could not close: it materializes the WHOLE
// body before anything can inspect it, on the one event loop this process shares with every
// job's heartbeat, the idle watchdog and the HTTP listener. A host answering with gigabytes
// — adversarial, or just an accidentally huge artifact — was therefore downloaded, decoded
// and allocated in full before the cap ever saw a character. That is the stall shape behind
// the 2026-09-20 reaped-on-read on a LIVE process (lib/loop-watch.ts). fetch-chain.ts's
// `readBoundedBody` counts against this while it reads, and cuts rather than continues.
//
// 4x PARSE_INPUT_CAP because the two count different things: this one counts BYTES off the
// wire, the parse cap counts CHARACTERS of decoded text, and a UTF-8 character is at most 4
// bytes. Sizing it at exactly 4x is what guarantees the byte bound can never cut a body the
// character cap would have accepted — so a page that is honest but enormous still reaches
// the parse decision, and PARSE_INPUT_CAP stays the single number that decides parsing.
export const MAX_BODY_BYTES = PARSE_INPUT_CAP * 4

// A response body as the fetch chain holds it: raw bytes, plus whether the byte bound cut it
// short. `readBoundedBody` (fetch-chain.ts) produces these; it is the only thing that ever
// touches a socket. Bytes rather than decoded text so a caller that must hand a body
// elsewhere unmodified (a binary format) is never forced through a UTF-8 decode that would
// corrupt it — decoding is each call site's own choice, for the bodies that need it as text.
export interface BoundedBody {
  /** The raw body: the whole of it, unless `truncated`. */
  bytes: Uint8Array
  /** True when the body was CUT at MAX_BODY_BYTES rather than read to the end. */
  truncated: boolean
}

/**
 * Why this decoded body may not be handed to the synchronous parser, or null when it may.
 *
 * Two bounds, and they are not the same bound twice. `truncated` is the byte bound: the body
 * never arrived in full, so there is no document to build and no way to know what was in the
 * part that did not arrive. The length check is PARSE_INPUT_CAP, the character cap on what
 * `parseHTML`/Readability — and the site adapters that read the same document — may be handed
 * on the one event loop every job shares.
 *
 * Takes already-decoded text (not a `BoundedBody`) because the two callers — step 1's HTML
 * branch and the Wayback rescue — each decode their bytes once and share that string with the
 * parser; this function does not need the bytes at all, only their length and whether they
 * were cut.
 *
 * Shared by step 1 and the Wayback rescue so both apply the same two bounds and report the
 * same reason; over either is a MISS like any other, and the caller falls through to its next
 * step rather than failing.
 */
export function parseInputOverflow(text: string, truncated: boolean): string | null {
  if (truncated) return `oversized (body over ${MAX_BODY_BYTES} bytes)`
  if (text.length > PARSE_INPUT_CAP) return `oversized (${text.length} chars over ${PARSE_INPUT_CAP})`
  return null
}

/** True when no later step in the fetch chain could possibly do better. */
export function isDefinitivelyMissing(status: number): boolean {
  return DEFINITIVE_MISSING.has(status)
}

// A PDF must never reach Readability/normalizeText as text — MEASURED against the deployed
// chain on arxiv.org/pdf/1706.03762: it fetched fine, Readability had no document to parse
// (there is no HTML), the raw bytes fell through as "text", and the ledger recorded 1,984,323
// chars of `retrieved` success that was in fact PDF binary decoded as UTF-8 garbage. Detected
// two ways because neither signal alone is trustworthy: a server can mislabel (or omit) the
// Content-Type, and arXiv's own header is correct but that is not something to depend on.
const PDF_MAGIC = new TextEncoder().encode('%PDF-')

// Exported separately from isPdf() below: the fetch chain's truncated-body branch has a
// Content-Type but no complete bytes to run the magic-byte check against.
export function isPdfContentType(contentType: string | null | undefined): boolean {
  if (!contentType) return false
  return contentType.toLowerCase().includes('application/pdf')
}

function startsWithPdfMagic(bytes: Uint8Array | null | undefined): boolean {
  if (!bytes || bytes.length < PDF_MAGIC.length) return false
  for (let i = 0; i < PDF_MAGIC.length; i++) {
    if (bytes[i] !== PDF_MAGIC[i]) return false
  }
  return true
}

/**
 * True when a response body is a PDF — by declared Content-Type (tolerant of parameters and
 * casing) OR by the `%PDF-` magic bytes at the start of the body, whichever fires first.
 */
export function isPdf(contentType: string | null | undefined, firstBytes: Uint8Array | null | undefined): boolean {
  return isPdfContentType(contentType) || startsWithPdfMagic(firstBytes)
}

// How much of a decoded text body this checks — the first ~4KB is plenty to tell prose from
// binary, and scanning the whole (possibly 80k-char) body would cost real time on every fetch
// for no better an answer.
const BINARY_SAMPLE_CHARS = 4096

// Above this ratio of "not text" characters in the sample, the body is binary rather than
// prose. \t \n \r are excluded from the control-byte count deliberately — legitimate prose is
// full of them; U+FFFD (what TextDecoder emits for a byte sequence that is not valid UTF-8)
// and every other C0 control byte are not something real prose produces in bulk.
const BINARY_RATIO_THRESHOLD = 0.1

function isBinaryChar(ch: string): boolean {
  if (ch === '�') return true
  const code = ch.charCodeAt(0)
  return code < 0x20 && ch !== '\t' && ch !== '\n' && ch !== '\r'
}

/**
 * True when a decoded text body reads as binary data rather than prose — defense in depth for
 * a mislabeled or magic-byte-missed binary response (an image/zip/octet-stream body served
 * under a Content-Type this chain treats as text). Ratio-based over a fixed sample so
 * legitimate non-Latin text (CJK, Cyrillic, emoji — all valid UTF-8 TextDecoder decodes
 * cleanly with zero replacement characters) never trips it.
 */
export function looksBinary(text: string): boolean {
  if (text.length === 0) return false
  const sample = text.slice(0, BINARY_SAMPLE_CHARS)
  let bad = 0
  let total = 0
  for (const ch of sample) {
    total++
    if (isBinaryChar(ch)) bad++
  }
  return total > 0 && bad / total > BINARY_RATIO_THRESHOLD
}
