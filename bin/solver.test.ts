import { describe, it, expect } from 'bun:test'
import { capHtml, checkUrlSafety, decideStaleChromeAction, isChallengeTitle, looksChallenged, validateRequest } from './solver.js'

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

  it('accepts warm mode', async () => {
    expect((await validateRequest({ ...base, mode: 'warm' })).ok).toBe(true)
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
