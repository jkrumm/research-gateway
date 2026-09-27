import { assertPublicHttpUrl } from '../../lib/ssrf.js'
import { log } from '../../lib/log.js'

// Lowercase host of a URL, or '' if it does not parse — used by the `tool.fetchPage` error
// log (Part 2 below) and by the `fetch.host` span attribute, so recurring blocked hosts are
// greppable AND groupable. That aggregation is how site-adapters.ts picks its next entry
// (see that file's header).
export function hostOf(u: string): string {
  try {
    return new URL(u).hostname.toLowerCase()
  } catch {
    return ''
  }
}

// A fetcher slot the origin rung can be run against — the plain, self-identifying bot request
// by default, or the impersonation rung's `impersonatedFetch` (see origin.ts's `runOrigin`).
// Takes only a signal: the redirect mode and (for the default) the bot user-agent are fixed by
// the implementation, never per-call, so `safeFetch`'s manual-redirect loop below behaves
// identically no matter which fetcher it is driving.
export type Fetcher = (url: string, init: { signal?: AbortSignal | undefined }) => Promise<Response>

export const defaultFetcher: Fetcher = (url, init) =>
  fetch(url, {
    headers: { 'user-agent': 'research-gateway/0.1 (+research bot)' },
    redirect: 'manual',
    // Omitted rather than set to `undefined` — `exactOptionalPropertyTypes` treats an explicit
    // `signal: undefined` as distinct from the key being absent, and Bun's fetch types want
    // `AbortSignal | null`, never `| undefined`.
    ...(init.signal ? { signal: init.signal } : {}),
  })

// Follows redirects BY HAND so every hop can be re-validated against the SSRF guard. A
// single `fetch` with `redirect: 'follow'` would validate the first address and then follow
// a 302 to anywhere — including the metadata service. The same is true of the impersonation
// rung's fetcher: it is NEVER allowed to follow its own redirects (impersonate.ts pins
// `followRedirects: false` / `redirect: 'manual'` for exactly this reason) — `fetcher` is
// swapped, this loop and its SSRF re-check are not.
//
// Returns the final URL alongside the response: with `redirect: 'manual'` the response is
// the REDIRECT TARGET's, and callers that attribute anything to the requested URL (the
// ledger's missing tier) must attribute it to where the answer actually came from.
export async function safeFetch(
  startUrl: string,
  jobId = '-',
  maxHops = 3,
  signal?: AbortSignal,
  fetcher: Fetcher = defaultFetcher,
): Promise<{ res: Response; finalUrl: string }> {
  let current = startUrl
  for (let hop = 0; ; hop++) {
    await assertPublicHttpUrl(current) // re-validate EVERY hop (initial + each redirect target)
    const res = await fetcher(current, {
      // The per-hop timeout AND the chain-wide budget: whichever fires first aborts the hop.
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    })
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (!loc) return { res, finalUrl: current }
      if (hop >= maxHops) throw new Error('too many redirects')
      const next = new URL(loc, current).toString() // resolve relative redirects
      log('tool.redirect', { jobId, from: current, to: next, status: res.status, hop: hop + 1 })
      current = next
      continue
    }
    return { res, finalUrl: current }
  }
}
