import { describe, it, expect } from 'bun:test'
import { assertPublicHttpUrl, isPrivateAddress, isPrivateAddressStrict, isBlockedHostnameLiteral, normalizeHostname } from './ssrf.js'

async function rejects(url: string): Promise<boolean> {
  try {
    await assertPublicHttpUrl(url)
    return false
  } catch {
    return true
  }
}

describe('isPrivateAddress — IPv4', () => {
  it('flags every RFC1918/CGNAT/link-local/loopback range', () => {
    expect(isPrivateAddress('10.0.0.1')).toBe(true)
    expect(isPrivateAddress('172.16.0.1')).toBe(true)
    expect(isPrivateAddress('192.168.1.1')).toBe(true)
    expect(isPrivateAddress('127.0.0.1')).toBe(true)
    expect(isPrivateAddress('169.254.169.254')).toBe(true)
    expect(isPrivateAddress('100.64.0.1')).toBe(true) // CGNAT / the tailnet
  })

  it('flags 192.0.0.0/24 and the benchmarking range', () => {
    expect(isPrivateAddress('192.0.0.1')).toBe(true) // IETF protocol assignments
    expect(isPrivateAddress('198.18.0.1')).toBe(true) // benchmarking, /15
  })

  it('flags multicast and reserved space', () => {
    expect(isPrivateAddress('224.0.0.1')).toBe(true)
    expect(isPrivateAddress('240.0.0.1')).toBe(true)
  })

  it('accepts a public address, including the TEST-NETs other test suites use as fixtures', () => {
    expect(isPrivateAddress('93.184.216.34')).toBe(false)
    expect(isPrivateAddress('1.1.1.1')).toBe(false)
    // fetch-chain.test.ts / otel-spans.test.ts / html-parse.test.ts use 203.0.113.0/24 and
    // 198.51.100.0/24 as "public, non-routable, no real DNS" fixtures on purpose — genuinely
    // unroutable, so treating them as public here is harmless, and blocking them would break
    // every one of those fixtures. `isPrivateAddressStrict` below (safe-proxy.ts only) closes
    // these.
    expect(isPrivateAddress('203.0.113.20')).toBe(false)
    expect(isPrivateAddress('198.51.100.9')).toBe(false)
  })
})

describe('isPrivateAddress — IPv6', () => {
  it('flags loopback, unspecified, link-local and ULA', () => {
    expect(isPrivateAddress('::1')).toBe(true)
    expect(isPrivateAddress('::')).toBe(true)
    expect(isPrivateAddress('fe80::1')).toBe(true)
    expect(isPrivateAddress('fc00::1')).toBe(true)
    expect(isPrivateAddress('fd12:3456::1')).toBe(true)
  })

  it('flags IPv4-mapped and IPv4-compatible addresses embedding a private IPv4', () => {
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isPrivateAddress('::ffff:7f00:1')).toBe(true) // ::ffff:127.0.0.1, hex form
    expect(isPrivateAddress('::127.0.0.1')).toBe(true) // IPv4-compatible (deprecated)
  })

  it('flags NAT64 addresses embedding a private IPv4', () => {
    expect(isPrivateAddress('64:ff9b::7f00:1')).toBe(true) // well-known NAT64, ::127.0.0.1
    expect(isPrivateAddress('64:ff9b:1:0:0:0:7f00:1')).toBe(true) // NAT64 local-use
  })

  it('flags 6to4 addresses embedding a private IPv4', () => {
    expect(isPrivateAddress('2002:0a00:0001::')).toBe(true) // 2002:<10.0.0.1 hex>:: — 6to4 of 10.0.0.1
  })

  it('flags the documentation range and anything outside global unicast', () => {
    expect(isPrivateAddress('2001:db8::1')).toBe(true)
    expect(isPrivateAddress('ff02::1')).toBe(true) // multicast
  })

  it('accepts a public IPv6 address, including one embedding a public IPv4', () => {
    expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false)
    expect(isPrivateAddress('::ffff:1.1.1.1')).toBe(false)
  })

  it('fails closed on an unparseable literal', () => {
    expect(isPrivateAddress('not-an-address')).toBe(true)
  })
})

describe('isPrivateAddressStrict — safe-proxy.ts only', () => {
  it('additionally closes the three TEST-NETs and the 6to4 relay anycast range', () => {
    expect(isPrivateAddressStrict('192.0.2.1')).toBe(true) // TEST-NET-1
    expect(isPrivateAddressStrict('198.51.100.1')).toBe(true) // TEST-NET-2
    expect(isPrivateAddressStrict('203.0.113.1')).toBe(true) // TEST-NET-3
    expect(isPrivateAddressStrict('192.88.99.1')).toBe(true) // 6to4 relay anycast
  })

  it('still flags everything the non-strict table flags', () => {
    expect(isPrivateAddressStrict('127.0.0.1')).toBe(true)
    expect(isPrivateAddressStrict('10.0.0.1')).toBe(true)
    expect(isPrivateAddressStrict('::1')).toBe(true)
  })

  it('still accepts a genuinely public address', () => {
    expect(isPrivateAddressStrict('93.184.216.34')).toBe(false)
  })
})

describe('isBlockedHostnameLiteral / normalizeHostname', () => {
  it('blocks localhost, the cloud metadata hostname, and the extra webcmd-table hostnames', () => {
    expect(isBlockedHostnameLiteral('localhost')).toBe(true)
    expect(isBlockedHostnameLiteral('metadata')).toBe(true)
    expect(isBlockedHostnameLiteral('ip6-localhost')).toBe(true)
    expect(isBlockedHostnameLiteral('instance-data')).toBe(true)
  })

  it('blocks .local/.internal/.localdomain/.localhost suffixes', () => {
    expect(isBlockedHostnameLiteral('mini.local')).toBe(true)
    expect(isBlockedHostnameLiteral('service.internal')).toBe(true)
    expect(isBlockedHostnameLiteral('host.localdomain')).toBe(true)
    expect(isBlockedHostnameLiteral('foo.localhost')).toBe(true)
  })

  it('strips brackets and a trailing dot, lowercases', () => {
    expect(normalizeHostname('[::1]')).toBe('::1')
    expect(normalizeHostname('EXAMPLE.com.')).toBe('example.com')
  })

  it('does not block an ordinary public hostname', () => {
    expect(isBlockedHostnameLiteral('example.com')).toBe(false)
  })
})

describe('assertPublicHttpUrl', () => {
  it('rejects a non-http(s) protocol', async () => {
    expect(await rejects('file:///etc/passwd')).toBe(true)
  })

  it('rejects private IPv4 and IPv6 literals', async () => {
    expect(await rejects('http://127.0.0.1/')).toBe(true)
    expect(await rejects('http://[::1]/')).toBe(true)
    expect(await rejects('http://[::ffff:7f00:1]/')).toBe(true)
  })

  it('accepts the TEST-NETs other test suites rely on as fixtures', async () => {
    expect(await rejects('http://203.0.113.20/')).toBe(false)
    expect(await rejects('http://198.51.100.9/')).toBe(false)
  })

  it('accepts a public https URL', async () => {
    expect(await rejects('https://example.com/page')).toBe(false)
  })
})
