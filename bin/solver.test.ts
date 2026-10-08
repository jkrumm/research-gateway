import { describe, it, expect } from 'bun:test'
import {
  capHtml,
  checkUrlSafety,
  classifyFetchOutcome,
  decideStaleChromeAction,
  hasChallengeEvidence,
  isAuthWallUrl,
  isChallengeTitle,
  looksChallenged,
  resolveFetchOutcome,
  validateRequest,
  type FetchObservation,
} from './solver.js'

describe('checkUrlSafety', () => {
  it('accepts a plain https URL', async () => {
    expect(await checkUrlSafety('https://example.com/page')).toEqual({ ok: true })
  })

  it('rejects a non-http(s) protocol', async () => {
    const result = await checkUrlSafety('file:///etc/passwd')
    expect(result.ok).toBe(false)
  })

  it('rejects localhost', async () => {
    expect((await checkUrlSafety('http://localhost:9333/')).ok).toBe(false)
  })

  it('rejects the cloud metadata hostname', async () => {
    expect((await checkUrlSafety('http://metadata/')).ok).toBe(false)
  })

  it('rejects .local and .internal suffixes', async () => {
    expect((await checkUrlSafety('http://mini.local/')).ok).toBe(false)
    expect((await checkUrlSafety('http://service.internal/')).ok).toBe(false)
  })

  it('rejects private IPv4 literals', async () => {
    expect((await checkUrlSafety('http://127.0.0.1/')).ok).toBe(false)
    expect((await checkUrlSafety('http://10.0.0.5/')).ok).toBe(false)
    expect((await checkUrlSafety('http://192.168.1.1/')).ok).toBe(false)
    expect((await checkUrlSafety('http://169.254.169.254/')).ok).toBe(false)
    expect((await checkUrlSafety('http://172.16.0.1/')).ok).toBe(false)
  })

  // The gaps solver.ts's own now-deleted isPrivateIpLiteral had, now closed by delegating to
  // src/lib/ssrf.ts's assertPublicHttpUrl.
  it('rejects ranges the old local check missed', async () => {
    expect((await checkUrlSafety('http://100.64.0.1/')).ok).toBe(false) // CGNAT / Tailscale
    expect((await checkUrlSafety('http://198.18.0.1/')).ok).toBe(false) // benchmarking
    expect((await checkUrlSafety('http://192.0.0.1/')).ok).toBe(false) // IETF protocol assignments
    expect((await checkUrlSafety('http://224.0.0.1/')).ok).toBe(false) // multicast
  })

  it('rejects bracketed IPv6 loopback and IPv4-mapped literals', async () => {
    expect((await checkUrlSafety('http://[::1]/')).ok).toBe(false)
    expect((await checkUrlSafety('http://[::ffff:7f00:1]/')).ok).toBe(false) // ::ffff:127.0.0.1
  })

  it('rejects IPv6 unique-local (fc00::/7) and link-local (fe80::/10) literals', async () => {
    expect((await checkUrlSafety('http://[fc00::1]/')).ok).toBe(false)
    expect((await checkUrlSafety('http://[fe80::1]/')).ok).toBe(false)
  })

  it('accepts a public IPv4 literal', async () => {
    expect((await checkUrlSafety('http://93.184.216.34/')).ok).toBe(true)
  })

  it('rejects an unparseable URL', async () => {
    expect((await checkUrlSafety('not a url')).ok).toBe(false)
  })
})

describe('validateRequest', () => {
  const base = { v: 1, mode: 'fetch', url: 'https://example.com/', timeoutMs: 1000, proxyPort: 9423 }

  it('accepts a well-formed request', async () => {
    const result = await validateRequest(base)
    expect(result.ok).toBe(true)
  })

  it('rejects a bad mode', async () => {
    expect((await validateRequest({ ...base, mode: 'bogus' })).ok).toBe(false)
  })

  it('rejects a missing/invalid proxyPort', async () => {
    expect((await validateRequest({ ...base, proxyPort: undefined })).ok).toBe(false)
    expect((await validateRequest({ ...base, proxyPort: 0 })).ok).toBe(false)
    expect((await validateRequest({ ...base, proxyPort: 70_000 })).ok).toBe(false)
    expect((await validateRequest({ ...base, proxyPort: 1.5 })).ok).toBe(false)
  })

  it('rejects a missing url', async () => {
    expect((await validateRequest({ ...base, url: undefined })).ok).toBe(false)
  })

  it('rejects a non-positive timeoutMs', async () => {
    expect((await validateRequest({ ...base, timeoutMs: 0 })).ok).toBe(false)
    expect((await validateRequest({ ...base, timeoutMs: -5 })).ok).toBe(false)
  })

  it('rejects a request whose url fails the safety check', async () => {
    expect((await validateRequest({ ...base, url: 'http://localhost/' })).ok).toBe(false)
  })

  it('rejects a non-object payload', async () => {
    expect((await validateRequest('nope')).ok).toBe(false)
    expect((await validateRequest(null)).ok).toBe(false)
  })

  it('rejects the wrong protocol version', async () => {
    expect((await validateRequest({ ...base, v: 2 })).ok).toBe(false)
  })
})

describe('isChallengeTitle', () => {
  it('flags known challenge titles', () => {
    expect(isChallengeTitle('Just a moment...')).toBe(true)
    expect(isChallengeTitle('Attention Required! | Cloudflare')).toBe(true)
    expect(isChallengeTitle('Checking your browser before accessing example.com')).toBe(true)
  })

  it('flags an empty title within the grace window (still loading)', () => {
    expect(isChallengeTitle('', 0)).toBe(true)
    expect(isChallengeTitle('   ', 5_000)).toBe(true)
  })

  it('stops flagging an empty title past the grace window (plain-text doc, no <title>)', () => {
    expect(isChallengeTitle('', 10_001)).toBe(false)
  })

  it('defaults elapsedMs to 0, so a bare call still treats empty as still-loading', () => {
    expect(isChallengeTitle('')).toBe(true)
  })

  it('passes a normal page title regardless of elapsed time', () => {
    expect(isChallengeTitle('Example Domain')).toBe(false)
    expect(isChallengeTitle('Example Domain', 60_000)).toBe(false)
  })
})

describe('looksChallenged', () => {
  it('flags markers in the first 20k chars', () => {
    expect(looksChallenged('<html>cf-chl-widget stuff</html>', 5_000)).toBe(true)
  })

  it('flags a page whose text is too short', () => {
    expect(looksChallenged('<html><body>hi</body></html>', 10)).toBe(true)
  })

  it('passes a normal, long, marker-free page', () => {
    const html = `<html><body>${'real content '.repeat(200)}</body></html>`
    expect(looksChallenged(html, 5_000)).toBe(false)
  })
})

describe('capHtml', () => {
  it('passes short html through unchanged', () => {
    expect(capHtml('short')).toBe('short')
  })

  it('truncates at 5 MB for ordinary text', () => {
    const huge = 'x'.repeat(6 * 1024 * 1024)
    const capped = capHtml(huge)
    expect(capped.length).toBe(5 * 1024 * 1024)
  })

  it('shrinks further for quote-heavy html so the JSON-serialized line stays under the output byte cap', () => {
    // Every char here doubles when JSON-escaped (`"` -> `\"`) — a naive raw-char-length cap
    // alone would let the serialized `{ok:true,html:"...",...}` line blow past the parent's
    // MAX_STDOUT_BYTES (8 MiB) even though html.length itself was within the 5 MB bound.
    const huge = '"'.repeat(6 * 1024 * 1024)
    const capped = capHtml(huge)
    const serializedBytes = Buffer.byteLength(JSON.stringify(capped))
    expect(serializedBytes).toBeLessThanOrEqual(6 * 1024 * 1024)
    expect(capped.length).toBeLessThan(5 * 1024 * 1024)
  })

  it('shrinks even further for control-character-heavy html (a single char can escape to 6 bytes)', () => {
    const huge = '\u0001'.repeat(6 * 1024 * 1024) // JSON.stringify escapes this to `\u0001` (6 bytes)
    const capped = capHtml(huge)
    const serializedBytes = Buffer.byteLength(JSON.stringify(capped))
    expect(serializedBytes).toBeLessThanOrEqual(6 * 1024 * 1024)
  })
})

describe('decideStaleChromeAction', () => {
  it('gives up and falls through when the launch lock could not be acquired, regardless of mismatch', () => {
    expect(decideStaleChromeAction({ lockAcquired: false, stillMismatched: true })).toBe('give-up-fallthrough')
    expect(decideStaleChromeAction({ lockAcquired: false, stillMismatched: false })).toBe('give-up-fallthrough')
  })

  it('reports already-fixed when another racer resolved the mismatch while the lock was held', () => {
    expect(decideStaleChromeAction({ lockAcquired: true, stillMismatched: false })).toBe('already-fixed')
  })

  it('only kills when the lock is held AND the mismatch is still there', () => {
    expect(decideStaleChromeAction({ lockAcquired: true, stillMismatched: true })).toBe('kill')
  })
})

const CF_HTML = '<html><head><title>Just a moment...</title></head><body>Checking your browser <div id="cf-chl-widget"></div></body></html>'
const DATADOME_HTML = '<html><body><iframe src="https://geo.captcha-delivery.com/captcha/?initialCid=abc"></iframe></body></html>'
const NOT_FOUND_HTML = `<html><head><title>Not found</title></head><body>${'Page not found. '.repeat(8)}</body></html>`
const LONG_PAGE_HTML = `<html><head><title>Docs</title></head><body>${'content '.repeat(60)}</body></html>`

function obs(over: Partial<FetchObservation>): FetchObservation {
  return { title: 'Docs', html: LONG_PAGE_HTML, textLen: 480, url: 'https://example.com/page', status: 200, ...over }
}
const FETCH = { requestedUrl: 'https://example.com/page', atDeadline: false }
const DEADLINE = { requestedUrl: 'https://example.com/page', atDeadline: true }

describe('hasChallengeEvidence', () => {
  it('a challenge title is evidence, an empty title is not', () => {
    expect(hasChallengeEvidence({ title: 'Just a moment...', html: '', status: 200 })).toBe(true)
    expect(hasChallengeEvidence({ title: '', html: '', status: 200 })).toBe(false)
  })

  it('Cloudflare managed-challenge html is evidence at any status', () => {
    expect(hasChallengeEvidence({ title: '', html: CF_HTML, status: 403 })).toBe(true)
    expect(hasChallengeEvidence({ title: '', html: CF_HTML, status: 200 })).toBe(true)
  })

  it('DataDome captcha-delivery is evidence even without a block status', () => {
    expect(hasChallengeEvidence({ title: '', html: DATADOME_HTML, status: 403 })).toBe(true)
    expect(hasChallengeEvidence({ title: '', html: DATADOME_HTML })).toBe(true)
  })

  it('PerimeterX px-captcha is evidence', () => {
    expect(hasChallengeEvidence({ title: '', html: '<div id="px-captcha"></div>', status: 200 })).toBe(true)
  })

  it('a reCAPTCHA/Turnstile widget only counts on a block status', () => {
    const widget = '<form><div class="g-recaptcha"></div><div class="cf-turnstile"></div></form>'
    expect(hasChallengeEvidence({ title: '', html: widget, status: 200 })).toBe(false)
    expect(hasChallengeEvidence({ title: '', html: widget, status: 404 })).toBe(false)
    expect(hasChallengeEvidence({ title: '', html: widget, status: 403 })).toBe(true)
    expect(hasChallengeEvidence({ title: '', html: '<div class="cf-turnstile"></div>', status: 403 })).toBe(true)
  })

  it('a plain 404 / 401 / empty shell carries no evidence', () => {
    expect(hasChallengeEvidence({ title: 'Not found', html: NOT_FOUND_HTML, status: 404 })).toBe(false)
    expect(hasChallengeEvidence({ title: 'Sign in', html: '<html><body>Sign in</body></html>', status: 401 })).toBe(false)
    expect(hasChallengeEvidence({ title: '', html: '<html><body><div id="root"></div></body></html>', status: 200 })).toBe(false)
  })
})

describe('isAuthWallUrl', () => {
  it('flags sign-in paths and hosts', () => {
    for (const u of [
      'https://example.com/login',
      'https://example.com/users/sign-in?next=/x',
      'https://example.com/signin',
      'https://example.com/sso/start',
      'https://example.com/oauth2/authorize',
      'https://example.com/auth/callback',
      'https://accounts.example.com/',
      'https://login.example.com/x',
    ]) {
      expect(isAuthWallUrl(u)).toBe(true)
    }
  })

  it('leaves content URLs and garbage alone', () => {
    for (const u of ['https://example.com/authors/jane', 'https://example.com/login-tips', 'https://example.com/docs', 'not a url']) {
      expect(isAuthWallUrl(u)).toBe(false)
    }
  })
})

describe('classifyFetchOutcome', () => {
  it('Cloudflare "Just a moment" 403 is a challenge at the deadline, a wait before it', () => {
    const cf = obs({ title: 'Just a moment...', html: CF_HTML, textLen: 60, status: 403 })
    expect(classifyFetchOutcome(cf, FETCH)).toBe('wait')
    expect(classifyFetchOutcome(cf, DEADLINE)).toBe('challenge')
  })

  it('DataDome 403 with a captcha-delivery iframe is a challenge', () => {
    const dd = obs({ title: '', html: DATADOME_HTML, textLen: 0, status: 403 })
    expect(classifyFetchOutcome(dd, FETCH)).toBe('wait')
    expect(classifyFetchOutcome(dd, DEADLINE)).toBe('challenge')
  })

  it('a thin 404 returns at once as an http_status passthrough, no deadline needed', () => {
    const nf = obs({ title: 'Not found', html: NOT_FOUND_HTML, textLen: 120, status: 404 })
    expect(classifyFetchOutcome(nf, FETCH)).toBe('http_status')
    expect(classifyFetchOutcome(obs({ status: 410, textLen: 40 }), FETCH)).toBe('http_status')
  })

  it('401 and other >=400 statuses without markers pass through', () => {
    expect(classifyFetchOutcome(obs({ status: 401, textLen: 30, html: '<html><body>Unauthorized</body></html>' }), FETCH)).toBe('http_status')
    expect(classifyFetchOutcome(obs({ status: 500, textLen: 30 }), FETCH)).toBe('http_status')
    expect(classifyFetchOutcome(obs({ status: 403, textLen: 30, html: '<html><body>Forbidden</body></html>' }), FETCH)).toBe('http_status')
  })

  it('a redirect to a login URL is auth_required, but a requested login URL is not', () => {
    const redirected = obs({ url: 'https://example.com/login?next=%2Fpage', textLen: 90, html: '<html><body>Please sign in</body></html>' })
    expect(classifyFetchOutcome(redirected, FETCH)).toBe('auth_required')
    expect(classifyFetchOutcome(redirected, { requestedUrl: 'https://example.com/login', atDeadline: false })).toBe('wait')
  })

  it('an empty SPA shell with no markers is no_challenge at the deadline, a wait before it', () => {
    const shell = obs({ title: '', html: '<html><body><div id="root"></div></body></html>', textLen: 0 })
    expect(classifyFetchOutcome(shell, FETCH)).toBe('wait')
    expect(classifyFetchOutcome(shell, DEADLINE)).toBe('no_challenge')
  })

  it('a healthy page is returned as page', () => {
    expect(classifyFetchOutcome(obs({}), FETCH)).toBe('page')
    expect(classifyFetchOutcome(obs({ status: undefined }), FETCH)).toBe('page')
  })
})

describe('hasChallengeEvidence — hard blocks are not human-solvable', () => {
  const waf = '<html><body><h1>Sorry, you have been blocked</h1><p>Cloudflare Ray ID: abc</p>' + 'x'.repeat(300) + '</body></html>'
  it('Cloudflare WAF 403 ("Attention Required!" + "you have been blocked") is not escalation evidence', () => {
    expect(hasChallengeEvidence({ title: 'Attention Required! | Cloudflare', html: waf, status: 403 })).toBe(false)
  })
  it('Akamai "Access Denied" 403 variants are not escalation evidence', () => {
    const html = '<html><body><h1>Access Denied</h1>Reference #18.abc akamai</body></html>'
    expect(hasChallengeEvidence({ title: 'Access Denied', html, status: 403 })).toBe(false)
    expect(hasChallengeEvidence({ title: 'Access Denied - example.com', html, status: 403 })).toBe(false)
  })
  it('a captcha widget on a block status still counts, even with Cloudflare named first', () => {
    const html = '<html><body>Protected by Cloudflare<div class="g-recaptcha"></div></body></html>'
    expect(hasChallengeEvidence({ title: 'Blocked', html, status: 403 })).toBe(true)
  })
  it('Turnstile on a 429 counts; Turnstile in a 200 login form does not', () => {
    const html = '<html><body><div class="cf-turnstile"></div></body></html>'
    expect(hasChallengeEvidence({ title: 'x', html, status: 429 })).toBe(true)
    expect(hasChallengeEvidence({ title: 'Sign in', html, status: 200 })).toBe(false)
  })
})

describe('resolveFetchOutcome', () => {
  const clean = { title: 'x', html: '<html></html>', textLen: 10, url: 'https://e.com/' }
  it('passes an observed outcome through', () => {
    expect(resolveFetchOutcome({ outcome: 'page' }, null, true)).toBe('page')
  })
  it('keeps waiting before the deadline without a read', () => {
    expect(resolveFetchOutcome(null, null, false)).toBe('wait')
  })
  it('never calls a deadline with no read ever made "no_challenge"', () => {
    expect(resolveFetchOutcome(null, null, true)).toBe('observation_failed')
  })
  it('falls back on the last read at the deadline', () => {
    expect(resolveFetchOutcome(null, clean, true)).toBe('no_challenge')
    expect(resolveFetchOutcome(null, { ...clean, html: '<title>Just a moment...</title>' }, true)).toBe('challenge')
  })
})

describe('classifyFetchOutcome — auth wall needs a thin page', () => {
  it('a full content page under /auth is a page, not an auth wall', () => {
    const obs = { title: 'Auth docs', html: '<html></html>', textLen: 5000, url: 'https://e.com/docs/auth' }
    expect(classifyFetchOutcome(obs, { requestedUrl: 'https://e.com/docs', atDeadline: false })).toBe('page')
  })
})
