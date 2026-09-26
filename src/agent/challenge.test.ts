import { describe, it, expect } from 'bun:test'
import { classifyBlock, isJavaScriptShell, describeBlock } from './challenge.js'

// Test cases 1-11 ported from agentrhq/webcmd src/fetch/classify.test.ts (Apache-2.0),
// translated to this module's `classifyBlock({ status, headers, bodySample })` API — webcmd's
// `isChallengeResponse(status, headers, body)` returns a bare boolean, this returns a verdict
// or null, so `!== null` is the equivalent assertion.
describe('classifyBlock — ported from webcmd', () => {
  it('recognizes explicit challenges but not bare forbidden responses', () => {
    expect(classifyBlock({ status: 403, headers: { server: 'cloudflare' }, bodySample: 'Just a moment...' })).not.toBeNull()
    expect(classifyBlock({ status: 403, headers: {}, bodySample: 'forbidden' })).toBeNull()
  })

  it('does not treat healthy provider evidence as a challenge', () => {
    expect(classifyBlock({ status: 200, headers: { 'x-datadome': 'protected' }, bodySample: '<main>real article</main>' })).toBeNull()
    expect(classifyBlock({ status: 200, headers: { 'set-cookie': '__cf_bm=abc' }, bodySample: '<main>real article</main>' })).toBeNull()
    expect(
      classifyBlock({
        status: 200,
        headers: { 'content-security-policy': 'script-src https://cdnjs.cloudflare.com' },
        bodySample: '<main>ok</main>',
      }),
    ).toBeNull()
  })

  it('recognizes script-heavy app shells', () => {
    expect(isJavaScriptShell('<div id="root"></div><script src="/app.js"></script><script>boot()</script>')).toBe(true)
  })

  // A CSP allow-list names third parties this page may load; it says nothing about who served
  // the response. news.ycombinator.com returns a healthy 200 whose CSP mentions
  // cdnjs.cloudflare.com and google.com/recaptcha (webcmd #264).
  it('ignores content-security-policy allow-lists naming a CDN or captcha vendor', () => {
    const csp = "default-src 'self'; script-src 'self' https://www.google.com/recaptcha/ https://cdnjs.cloudflare.com/"
    expect(classifyBlock({ status: 200, headers: { 'content-security-policy': csp }, bodySample: '<html><body>Hacker News</body></html>' })).toBeNull()
  })

  it('ignores report-to and link headers naming a challenge vendor', () => {
    const headers = {
      'report-to': '{"endpoints":[{"url":"https://report.cloudflare.com/"}]}',
      link: '<https://cdnjs.cloudflare.com>; rel=preconnect',
    }
    expect(classifyBlock({ status: 200, headers, bodySample: '<html><body>Real content</body></html>' })).toBeNull()
  })

  // example.com is a plain static page fronted by Cloudflare. `server: cloudflare` on a 200
  // that was actually served is not a challenge (webcmd #283).
  it('does not flag a Cloudflare-fronted 200 whose body is a real page', () => {
    const headers = { server: 'cloudflare', 'cf-cache-status': 'HIT', 'content-type': 'text/html' }
    expect(classifyBlock({ status: 200, headers, bodySample: '<html><body><h1>Example Domain</h1></body></html>' })).toBeNull()
  })

  it('still flags a managed-challenge interstitial served with a 200', () => {
    const headers = { server: 'cloudflare', 'cf-mitigated': 'challenge' }
    const verdict = classifyBlock({ status: 200, headers, bodySample: '<title>Just a moment...</title>' })
    expect(verdict).not.toBeNull()
    expect(verdict?.decisive).toBe(true)
    expect(verdict?.vendor).toBe('cloudflare')
  })

  // cf-mitigated only ever appears on an actual mitigation, so it stands alone even when the
  // body has been withheld.
  it('treats challenge-specific headers as evidence without a body marker', () => {
    expect(classifyBlock({ status: 403, headers: { 'cf-mitigated': 'challenge' }, bodySample: '' })).not.toBeNull()
    expect(classifyBlock({ status: 429, headers: { 'x-datadome': 'protected' }, bodySample: '' })).not.toBeNull()
  })

  it('treats a challenge cookie as evidence', () => {
    expect(classifyBlock({ status: 403, headers: { 'set-cookie': '__cf_bm=abc; Path=/' }, bodySample: 'blocked' })).not.toBeNull()
    expect(classifyBlock({ status: 200, headers: { 'set-cookie': 'session=abc; Path=/' }, bodySample: 'real page' })).toBeNull()
  })

  // A bare CDN name corroborates an already-suspicious status, but never decides on its own —
  // that is the difference between webcmd #283 and a genuine block.
  it('lets a bare CDN name corroborate a non-200 block', () => {
    expect(classifyBlock({ status: 403, headers: { server: 'cloudflare' }, bodySample: 'Access denied' })).not.toBeNull()
    expect(classifyBlock({ status: 200, headers: { server: 'akamai' }, bodySample: 'Real page content' })).toBeNull()
  })

  it('does not flag a healthy 200 with no challenge evidence anywhere', () => {
    expect(classifyBlock({ status: 200, headers: { 'content-type': 'text/html' }, bodySample: '<html><body>Hello</body></html>' })).toBeNull()
  })

  it('still catches a body-level captcha wall on a 403', () => {
    expect(classifyBlock({ status: 403, headers: {}, bodySample: '<div class="g-recaptcha">verify you are human</div>' })).not.toBeNull()
  })
})

describe('classifyBlock — measured cases from this repo', () => {
  // ticketmaster.com: measured 2026-08-xx, a 200 page whose ~28k chars begin with a
  // browser-support notice — reads like a wall, but is not a block: no decisive marker, no
  // 403/429/503 to let a bare corroborating word count.
  it('does not flag a 200 "browser not supported" notice', () => {
    const body = 'Your browser is not supported. '.repeat(900) // ~28,800 chars
    expect(classifyBlock({ status: 200, headers: { 'content-type': 'text/html' }, bodySample: body })).toBeNull()
  })

  // walmart.com: measured, a 243-char 200 "technical issues" body — existing thin-content
  // checks in fetch-chain.ts handle this as a miss; it must not ALSO be misclassified as a
  // challenge, which would wrongly trigger noteBlocked/cooldown for a host that isn't blocking.
  it('does not flag a short "technical issues" 200 body', () => {
    const body = "We're having technical issues. Please try again later."
    expect(classifyBlock({ status: 200, headers: { 'content-type': 'text/html' }, bodySample: body })).toBeNull()
  })

  it('does not flag server: cloudflare on an ordinary 200 page', () => {
    const headers = { server: 'cloudflare', 'content-type': 'text/html' }
    expect(classifyBlock({ status: 200, headers, bodySample: '<html><body><article>A normal article.</article></body></html>' })).toBeNull()
  })

  it('flags a 403 with cf-mitigated: challenge as a decisive cloudflare block', () => {
    const verdict = classifyBlock({ status: 403, headers: { 'cf-mitigated': 'challenge' }, bodySample: 'Access denied' })
    expect(verdict).toEqual({ vendor: 'cloudflare', decisive: true, signal: 'header:cf-mitigated=challenge' })
  })

  it('fingerprints datadome and perimeterx vendors from cookies', () => {
    const dd = classifyBlock({ status: 403, headers: { 'set-cookie': 'datadome=xyz; Path=/' }, bodySample: 'Access Denied' })
    expect(dd?.vendor).toBe('datadome')
    const px = classifyBlock({ status: 403, headers: { 'set-cookie': '_px3=xyz; Path=/' }, bodySample: 'blocked by perimeterx' })
    expect(px?.vendor).toBe('perimeterx')
  })
})

describe('describeBlock', () => {
  it('formats a human-readable line naming the vendor and status', () => {
    expect(describeBlock({ vendor: 'cloudflare', decisive: true, signal: 'x' }, 403)).toBe('blocked: cloudflare challenge (HTTP 403)')
  })
})

describe('cf-chl-bypass is a benign counter header, not a decisive challenge marker', () => {
  it('does not treat cf-chl-bypass on its own as decisive at any status, even with a "1" value', () => {
    expect(classifyBlock({ status: 200, headers: { 'cf-chl-bypass': '1' }, bodySample: '<html><body>real content</body></html>' })).toBeNull()
    expect(classifyBlock({ status: 403, headers: { 'cf-chl-bypass': '1' }, bodySample: '' })).toBeNull()
    expect(classifyBlock({ status: 503, headers: { 'cf-chl-bypass': '1' }, bodySample: '' })).toBeNull()
  })

  it('still lets a genuine corroborating marker alongside cf-chl-bypass decide a blocked status', () => {
    // The bare counter alone never decides — but a genuine corroborating signal (a bare
    // `server: cloudflare` here) present in the SAME response still corroborates the blocked
    // status normally, same as webcmd #283's "bare CDN name" case elsewhere in this file.
    const verdict = classifyBlock({
      status: 403,
      headers: { 'cf-chl-bypass': '1', server: 'cloudflare' },
      bodySample: 'Access denied',
    })
    expect(verdict?.decisive).toBe(false)
    expect(verdict?.vendor).toBe('cloudflare')
  })

  it('still treats another cf-chl-* header (not "bypass") as decisive', () => {
    const verdict = classifyBlock({ status: 403, headers: { 'cf-chl-genuine': 'challenge' }, bodySample: '' })
    expect(verdict?.decisive).toBe(true)
  })
})

describe('decisive header value must match exactly, not merely contain', () => {
  it('does not treat cf-chl-bypass: 10 on a healthy 200 as a decisive challenge', () => {
    // The old unanchored `/challenge|1/` matched the "1" inside "10" — an ordinary counter
    // header value, not a challenge marker.
    expect(classifyBlock({ status: 200, headers: { 'cf-chl-bypass': '10' }, bodySample: '<html><body>real article</body></html>' })).toBeNull()
  })

  it('still treats an exact "1" or "challenge" decisive header value as decisive, including with surrounding whitespace', () => {
    // cf-chl-bypass itself is excluded from DECISIVE_HEADERS entirely (see the dedicated
    // describe block below) — a non-"bypass" cf-chl-* header exercises the same exact-value
    // check.
    expect(classifyBlock({ status: 403, headers: { 'cf-chl-genuine': '1' }, bodySample: '' })?.decisive).toBe(true)
    expect(classifyBlock({ status: 403, headers: { 'cf-mitigated': 'challenge' }, bodySample: '' })?.decisive).toBe(true)
    expect(classifyBlock({ status: 403, headers: { 'cf-mitigated': ' challenge ' }, bodySample: '' })?.decisive).toBe(true)
  })
})

describe('cookie name parsing does not split on a comma inside an Expires attribute', () => {
  it('still identifies the vendor from a single cookie whose Expires attribute contains a comma', () => {
    const value = '__cf_bm=abcXYZ123; path=/; expires=Wed, 21-Oct-2026 07:28:00 GMT; HttpOnly; Secure; SameSite=None'
    const verdict = classifyBlock({ status: 403, headers: { 'set-cookie': value }, bodySample: 'Access denied' })
    expect(verdict?.vendor).toBe('cloudflare')
  })

  it('identifies both cookies in a folded set-cookie header despite each carrying a comma-bearing Expires', () => {
    const value =
      '__cf_bm=abc; path=/; expires=Wed, 21-Oct-2026 07:28:00 GMT; HttpOnly, cf_clearance=xyz; path=/; expires=Wed, 21-Oct-2026 08:00:00 GMT; HttpOnly'
    const verdict = classifyBlock({ status: 403, headers: { 'set-cookie': value }, bodySample: 'Access denied' })
    expect(verdict?.vendor).toBe('cloudflare')
  })
})
