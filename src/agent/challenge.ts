// Adapted from agentrhq/webcmd src/fetch/classify.ts (Apache-2.0). The two-tier rule is
// webcmd's own hard-won lesson, kept verbatim: a header/body marker that ONLY ever appears on
// an actual anti-bot mitigation (`cf-mitigated`, "just a moment...") decides on its own at ANY
// status, including a 200 — Cloudflare's managed-challenge interstitial is served with a 200.
// A marker that also shows up on healthy pages (a bare `server: cloudflare`, the word
// "captcha" in a login form) only CORROBORATES an already-suspicious status (403/429/503) and
// never decides alone — that is the difference between a genuine block and the false
// positives webcmd's own history recorded (#264 a CSP allow-list, #283 a Cloudflare-fronted
// static page). Vendor fingerprinting (which WAF, for the log line) is ported from the same
// project's src/browser/analyze.ts:89-164 `WAF_SIGNATURES` table, extended here with
// datadome/perimeterx — analyze.ts targets browser-observed anti-bot only and never needed
// them, but webcmd's own classify.ts already treats both as corroborating fetch-level markers.

export type BlockVendor = 'cloudflare' | 'datadome' | 'perimeterx' | 'akamai' | 'geetest' | 'aliyun' | 'unknown'

export interface BlockVerdict {
  vendor: BlockVendor
  decisive: boolean
  /** Which marker matched, for logs — e.g. "header:cf-mitigated=challenge" or "body:just a moment". */
  signal: string
}

// Headers that describe *this* response. Everything else is excluded on purpose:
// `content-security-policy`, `report-to` and `link` are allow-lists of third parties a page
// may load, so a CSP naming `cdnjs.cloudflare.com` or `google.com/recaptcha` proves nothing
// about who served the bytes (webcmd #264).
const CHALLENGE_HEADERS = /^(?:server|cf-mitigated|cf-chl-[\w-]+|x-datadome[\w-]*|set-cookie)$/i

// Markers that do not legitimately appear outside an actual challenge, so they decide on
// their own at any status — including the managed-challenge interstitial Cloudflare serves
// with a 200.
//
// `cf-chl-bypass` is excluded from the `cf-chl-*` group on purpose: it is an ordinary counter
// header present on plenty of healthy Cloudflare-fronted responses (its value is a plain
// integer, not "challenge"/"1" as a sentinel), unlike `cf-mitigated` or another `cf-chl-*`
// header, which never legitimately appear outside an actual mitigation. Without this exclusion
// a bare `cf-chl-bypass: 1` on a normal 200 would satisfy the exact-value check below and read
// as decisive on its own.
const DECISIVE_HEADERS = /^(?:cf-mitigated|cf-chl-(?!bypass)[\w-]+)$/i
const DECISIVE_BODY_MARKERS =
  /cf-chl|cf-mitigated|just a moment|verify you are human|checking your browser|enable javascript and cookies/i

// Markers that appear constantly on healthy pages: a CDN name in `server:`, or a reCAPTCHA
// widget embedded in an ordinary login form. These only corroborate a status that already
// looks like a block, never decide alone (webcmd #283).
const CORROBORATING_MARKERS = /cloudflare|datadome|perimeterx|px-captcha|akamai|captcha|__cf_bm/i

const BLOCKED_STATUSES = new Set([403, 429, 503])

// Scan only the first 20,000 chars of a body — same bound webcmd uses, since a challenge
// marker (if present at all) is always near the top of the document.
const BODY_SCAN_CHARS = 20_000

// Vendor fingerprints: cookie names and body substrings that identify WHICH anti-bot vendor
// fired, for logs only — never used to decide whether something IS a block (that is entirely
// the decisive/corroborating rule above). Ordered so a more specific vendor is checked before
// a generic word like "captcha" would otherwise be reached via CORROBORATING_MARKERS alone.
const VENDOR_SIGNATURES: ReadonlyArray<{
  vendor: Exclude<BlockVendor, 'unknown'>
  headerNamePatterns?: RegExp[]
  cookiePatterns: RegExp[]
  bodyPatterns: RegExp[]
}> = [
  {
    vendor: 'cloudflare',
    headerNamePatterns: [/^cf-mitigated$/i, /^cf-chl-/i],
    cookiePatterns: [/^__cf_bm$/i, /^cf_clearance$/i, /^__cfduid$/i],
    bodyPatterns: [/cloudflare ray id/i, /checking your browser before accessing/i, /cf-chl-/i, /just a moment/i],
  },
  {
    vendor: 'datadome',
    headerNamePatterns: [/^x-datadome/i],
    cookiePatterns: [/^datadome$/i],
    bodyPatterns: [/datadome/i],
  },
  {
    vendor: 'perimeterx',
    headerNamePatterns: [],
    cookiePatterns: [/^_px\d?$/i, /^_pxhd$/i, /^_pxvid$/i],
    bodyPatterns: [/perimeterx/i, /px-captcha/i],
  },
  {
    vendor: 'akamai',
    headerNamePatterns: [],
    cookiePatterns: [/^_abck$/i, /^bm_sz$/i, /^bm_sv$/i],
    bodyPatterns: [/akamai/i],
  },
  {
    vendor: 'geetest',
    headerNamePatterns: [],
    cookiePatterns: [],
    bodyPatterns: [/geetest/i, /gt_captcha/i],
  },
  {
    vendor: 'aliyun',
    headerNamePatterns: [],
    cookiePatterns: [/^acw_sc__v2$/i, /^acw_tc$/i, /^ssxmod_itna/i],
    bodyPatterns: [/arg1\s*=\s*['"][0-9A-F]{30,}/, /\/ntc_captcha\//i],
  },
]

function headerEntries(headers: Headers | Record<string, string>): Array<[string, string]> {
  if (headers instanceof Headers) return [...headers.entries()]
  return Object.entries(headers)
}

// `set-cookie` may arrive as several cookies folded into one header value (comma-joined, or a
// single `Headers` entry per the Fetch spec's own combining rule) — split defensively rather
// than assume one cookie per header. A plain `.split(',')` breaks on a comma INSIDE an
// attribute value — `Expires=Wed, 21 Oct 2026 07:28:00 GMT` is itself comma-bearing — so this
// only splits at a comma that is followed by what looks like the START of the next cookie's
// `name=` (optional whitespace, then a run of non-`;`/`=`/whitespace chars, then `=`). A date
// like `21 Oct …` never matches that lookahead (it has no `=` before the next space), so it
// stays part of the same fragment as the cookie it belongs to.
const COOKIE_BOUNDARY = /,(?=\s*[^;=\s]+=)/

function cookieNamesFrom(entries: Array<[string, string]>): string[] {
  const names: string[] = []
  for (const [key, value] of entries) {
    if (key.toLowerCase() !== 'set-cookie') continue
    for (const part of value.split(COOKIE_BOUNDARY)) {
      const name = part.trim().split('=')[0]?.trim()
      if (name) names.push(name)
    }
  }
  return names
}

function vendorFor(entries: Array<[string, string]>, bodySample: string): BlockVendor {
  const cookieNames = cookieNamesFrom(entries)
  for (const sig of VENDOR_SIGNATURES) {
    if (sig.headerNamePatterns?.some((p) => entries.some(([key]) => p.test(key)))) return sig.vendor
    if (sig.cookiePatterns.some((p) => cookieNames.some((name) => p.test(name)))) return sig.vendor
    if (sig.bodyPatterns.some((p) => p.test(bodySample))) return sig.vendor
  }
  return 'unknown'
}

export function classifyBlock(input: {
  status: number
  headers: Headers | Record<string, string>
  bodySample: string
}): BlockVerdict | null {
  const { status, headers, bodySample } = input
  const entries = headerEntries(headers).filter(([key]) => CHALLENGE_HEADERS.test(key))
  const body = bodySample.slice(0, BODY_SCAN_CHARS)

  // Anchored to the WHOLE (trimmed) value — `cf-chl-bypass: 10` is an ordinary counter header
  // on a healthy response, not a decisive challenge marker; only an exact `1` or `challenge`
  // value is. An unanchored `/challenge|1/` would let any header value merely CONTAINING a "1"
  // (a request id, a count) decide the whole verdict on its own.
  const decisiveHeader = entries.find(([key, value]) => DECISIVE_HEADERS.test(key) && /^(?:challenge|1)$/i.test(value.trim()))
  if (decisiveHeader) {
    return { vendor: vendorFor(entries, body), decisive: true, signal: `header:${decisiveHeader[0]}=${decisiveHeader[1]}` }
  }

  const decisiveBody = DECISIVE_BODY_MARKERS.exec(body)
  if (decisiveBody) {
    return { vendor: vendorFor(entries, body), decisive: true, signal: `body:${decisiveBody[0]}` }
  }

  if (!BLOCKED_STATUSES.has(status)) return null

  const headerEvidence = entries.map(([key, value]) => `${key}:${value}`).join('\n')
  const corroborating = CORROBORATING_MARKERS.exec(`${headerEvidence}\n${body}`)
  if (!corroborating) return null
  return { vendor: vendorFor(entries, body), decisive: false, signal: `status:${status}+corroborating:${corroborating[0]}` }
}

// A script-heavy shell with almost no rendered text — Reddit's anonymous-crawler response is
// the canonical case (site-adapters.ts's header comment: 8,497 bytes vs 266,954 for the same
// thread on the alternate origin). Not a block (nothing challenges the requester), just a page
// whose text was never sent — rendering, not a human, is the fix.
export function isJavaScriptShell(html: string): boolean {
  return (
    /<(?:div|main)[^>]+(?:id|data-[^=]+)=["'](?:root|app)["']/i.test(html) &&
    (html.match(/<script\b/gi)?.length ?? 0) >= 1 &&
    html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, '').trim().length < 500
  )
}

export function describeBlock(v: BlockVerdict, status: number): string {
  return `blocked: ${v.vendor} challenge (HTTP ${status})`
}
