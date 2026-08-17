// Wayback Machine rescue for pages the live origin refuses to serve at all.
//
// Measured 2026-08-17 against the deployed chain, on
// `www.dpreview.com/forums/threads/opinions-on-the-xf-16mm-f-2-8-astrophotography-specifically.4455495`:
// the live origin answers HTTP 403 to plain fetch AND to lightpanda, and Tavily Extract returns
// "Failed to fetch url" — every step of the chain fails. The same page through
// `https://web.archive.org/web/9999/<url>` 302s to
// `https://web.archive.org/web/20230408162519/<url>`, which reads with plain Readability:
// 20,076 chars, 0 Tavily credits. The archive toolbar Wayback injects does NOT confuse
// Readability — measured through the deployed chain, so this module deliberately does not strip
// it.
//
// `archive.org/wayback/available?url=…` (the availability JSON API) returned HTTP 502 TWICE in
// the same session — do not use it. The `/web/9999/<url>` redirect form is the one that works.
//
// Dependency-free by design (no env/log/fetch import) so it stays unit-testable — same
// convention as ledger.ts / extract.ts / site-adapters.ts / response-kind.ts.

// `9999` is a deliberately partial timestamp — Wayback resolves any partial/out-of-range
// timestamp to its NEAREST snapshot, which in practice is the latest one available. Verified:
// `/web/9999/`, `/web/2026/` and `/web/2/` all redirected to the same snapshot for the dpreview
// thread above, so there is nothing to gain from a more precise value here.
export function waybackLookupUrl(url: string): string {
  return `https://web.archive.org/web/9999/${url}`
}

const ARCHIVE_HOSTS = new Set(['web.archive.org', 'archive.org'])

/** True for web.archive.org / archive.org and their subdomains — refuses archive-of-archive recursion. */
export function isArchiveUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  const host = parsed.hostname.toLowerCase()
  return ARCHIVE_HOSTS.has(host) || [...ARCHIVE_HOSTS].some((h) => host.endsWith(`.${h}`))
}

// 14-digit Wayback snapshot timestamp, e.g. the `20230408162519` in
// `/web/20230408162519/https://example.com`.
const SNAPSHOT_PATH_RE = /\/web\/(\d{14})/

function isoFromSnapshotDigits(digits: string): string {
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`
}

/**
 * Best-effort ISO (`YYYY-MM-DD`) date of the snapshot actually served. Prefers the RFC-1123
 * `Memento-Datetime` header Wayback sets on every replayed page (e.g.
 * `Sat, 08 Apr 2023 16:25:19 GMT`); falls back to the 14-digit timestamp embedded in the
 * `Content-Location` (or any URL) path. Returns null when neither parses — the step must still
 * work without a date, just with a less specific banner.
 */
export function parseSnapshotDate(headers: { memento?: string | null; contentLocation?: string | null }): string | null {
  if (headers.memento) {
    const parsed = new Date(headers.memento)
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 10)
    }
  }
  if (headers.contentLocation) {
    const match = SNAPSHOT_PATH_RE.exec(headers.contentLocation)
    if (match?.[1]) return isoFromSnapshotDigits(match[1])
  }
  return null
}

/**
 * The staleness banner prepended to archived text. Load-bearing: a worker reading a stale
 * snapshot must not cite it as current, and the ledger still records the page as `retrieved` —
 * it genuinely was read, so staleness travels in-band via this banner rather than as a new
 * ledger tier.
 */
export function archiveBanner(originalUrl: string, isoDate: string | null): string {
  const when = isoDate ?? 'date unknown'
  return `[Archived snapshot of ${originalUrl} taken ${when} via the Wayback Machine — this is not the live page and may be out of date.]\n\n`
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * Whole days between a snapshot's ISO (`YYYY-MM-DD`) date and `now`. `now` is a parameter
 * rather than `new Date()` inline, so this stays exactly reproducible in tests — same
 * clock-injection convention as the rest of this dependency-free module.
 *
 * Null in, null out: a missing or unparseable snapshot date leaves the rescue's age
 * unmeasured rather than guessed. Never negative — a snapshot dated "today" can still read
 * as fractionally in the future once timezones/clock skew enter, and a negative age would
 * corrupt the max-merge tools.ts's meterArchive does across a job's rescues — clamped to 0.
 */
export function snapshotAgeDays(isoDate: string | null, now: Date): number | null {
  if (!isoDate) return null
  const snapshot = new Date(isoDate)
  if (Number.isNaN(snapshot.getTime())) return null
  return Math.max(0, Math.floor((now.getTime() - snapshot.getTime()) / MS_PER_DAY))
}
