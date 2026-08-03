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

/** True when no later step in the fetch chain could possibly do better. */
export function isDefinitivelyMissing(status: number): boolean {
  return DEFINITIVE_MISSING.has(status)
}
