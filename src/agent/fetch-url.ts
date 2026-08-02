// Host rewrites applied before fetching a page. Dependency-free by design (no env/log
// import) so it is unit-testable without booting the env-parsing chain — same convention as
// ledger.ts / extract.ts / cost.ts.
//
// This is deliberately NOT a general "try a mirror" mechanism. Each entry is a host that was
// MEASURED to fail in a specific, silent way, with a specific replacement measured to work.

// Reddit's modern front end answers a bot with HTTP **200** and an ~8 KB JavaScript shell
// (measured 2026-08-02: www.reddit.com 8,497 bytes vs old.reddit.com 266,954 bytes for the
// same thread). That is the worst possible failure shape for this pipeline: the response is
// "successful", so `safeFetch` returns it, Readability then extracts almost nothing, the
// thin-content path falls through to Tavily Extract — burning a credit on a page that was
// never going to yield — and the URL finally lands on the ledger as `failed`, making every
// claim resting on it uncitable.
//
// It is worth fixing rather than tolerating: in one measured deep run, 6 of 13 unverified
// entries were www.reddit.com — 46% of that run's verification failures from a single host —
// and Reddit is where practitioner reports actually live, which is exactly the long-tail
// evidence the Sonar migration was meant to reach.
const HOST_REWRITES: Record<string, string> = {
  'www.reddit.com': 'old.reddit.com',
  'reddit.com': 'old.reddit.com',
}

/**
 * The URL to actually fetch. The caller MUST keep the original for the retrieval ledger and
 * for what it reports back: the model cites the URL it was given by search, and
 * `normalizeUrl` does not treat `old.reddit.com/...` and `www.reddit.com/...` as the same
 * page (it strips `www.`, not arbitrary subdomains). Recording the rewritten host would
 * therefore leave every honest Reddit citation ungrounded — the exact failure the rewrite
 * is meant to remove.
 */
export function rewriteFetchUrl(raw: string): string {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return raw // not a URL we can reason about; the SSRF guard will reject it downstream
  }

  const replacement = HOST_REWRITES[parsed.host.toLowerCase()]
  if (!replacement) return raw

  parsed.host = replacement
  return parsed.toString()
}
