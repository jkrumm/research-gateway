import { lookup } from 'node:dns/promises'

// Residual gap: DNS rebinding. `assertPublicHttpUrl` below validates the resolved IP at
// call time, but a caller that re-resolves the hostname later (a runtime's own connect) could
// see a different, private address by then. Two closures exist for the two callers that matter:
//  - `safeFetch()` in tools.ts re-validates every redirect hop before following it.
//  - The human-solve escalation path (bin/solver.ts's Chrome) instead routes through
//    `safe-proxy.ts`, which resolves DNS itself and connects to the RESOLVED address — so
//    Chrome's own connect can never land anywhere this check didn't just approve.

const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata', 'ip6-localhost', 'instance-data'])

const BLOCKED_SUFFIXES = ['.local', '.internal', '.localdomain', '.localhost']

/** Strips IPv6 brackets and a trailing dot, lowercases. Shared normalization for every
 * hostname this file or safe-proxy.ts ever compares. */
export function normalizeHostname(hostname: string): string {
  return hostname
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.+$/, '')
}

/** True for a hostname that is blocked by name alone, before any DNS resolution happens. */
export function isBlockedHostnameLiteral(hostname: string): boolean {
  const normalized = normalizeHostname(hostname)
  if (normalized === '') return true
  if (BLOCKED_HOSTNAMES.has(normalized)) return true
  return BLOCKED_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
}

// ── The one private/reserved-range table ─────────────────────────────────────────
// Shared by `assertPublicHttpUrl` below (per-hostname DNS check, used by tools.ts/ytdlp.ts/
// fetch-chain.ts) and by `safe-proxy.ts` (per-resolved-address check on every proxied
// connection from the human-solve escalation path's Chrome). The IPv6 half is ported wholesale
// from agentrhq/webcmd's `src/fetch/safe-proxy.ts` (Apache-2.0): it additionally closes
// IPv4-compatible (`::a.b.c.d`), IPv4-translated, NAT64 (`64:ff9b::/96`, `64:ff9b:1::/48`) and
// 6to4 (`2002::/16`) addresses that embed a private IPv4 destination, plus bracketed literals —
// none of which the previous version of this file caught.
//
// The IPv4 table deliberately stays at the PREVIOUS (pre-webcmd) range set, not webcmd's fuller
// one: `fetch-chain.test.ts`/`otel-spans.test.ts`/`html-parse.test.ts` use 203.0.113.0/24
// (TEST-NET-3) and 198.51.100.0/24 (TEST-NET-2) on purpose, as "public, non-routable, no real
// DNS" fixtures — genuinely unroutable, so treating them as public here is harmless, and
// blocking them would break every one of those fixtures. `isPrivateIpv4Strict` below (used only
// by safe-proxy.ts, which has no such fixture dependency) closes the TEST-NETs and the
// 192.88.99.0/24 6to4 relay anycast range on top of this same table.

function parseIpv4(value: string): number[] | undefined {
  const parts = value.split('.')
  if (parts.length !== 4) return undefined
  const octets = parts.map(Number)
  if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return undefined
  return octets
}

function isPrivateIpv4(octets: number[]): boolean {
  const [a, b, c] = octets as [number, number, number, number]
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 — CGNAT, includes the tailnet
    (a === 169 && b === 254) || // link-local, includes 169.254.169.254 cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) || // 192.0.0.0/24 — IETF protocol assignments
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking, 198.18.0.0/15
    a >= 224 // multicast + reserved
  )
}

/** The stricter IPv4 table — everything `isPrivateIpv4` blocks, plus the three TEST-NETs and
 * the 6to4 relay anycast range. Used only by `safe-proxy.ts`: the solver Chrome's egress has no
 * "TEST-NET fixture" caller depending on those ranges staying reachable, so there is no reason
 * not to close them there. */
function isPrivateIpv4Strict(octets: number[]): boolean {
  const [a, b, c] = octets as [number, number, number, number]
  return (
    isPrivateIpv4(octets) ||
    (a === 192 && b === 0 && c === 2) || // TEST-NET-1
    (a === 192 && b === 88 && c === 99) || // 6to4 relay anycast
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) // TEST-NET-3
  )
}

function parseHexWord(value: string): number | undefined {
  if (!/^[0-9a-f]{1,4}$/i.test(value)) return undefined
  return Number.parseInt(value, 16)
}

// Parses a bracket-free IPv6 literal (optionally with a trailing embedded IPv4 tail, e.g.
// "::ffff:127.0.0.1") into its 8 16-bit words.
function parseIpv6Words(address: string): number[] | undefined {
  let normalized = address.toLowerCase()
  const dotted = normalized.match(/(^|:)(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) {
    const bytes = parseIpv4(dotted[2]!)
    if (!bytes) return undefined
    normalized = `${normalized.slice(0, dotted.index! + dotted[1]!.length)}${((bytes[0]! << 8) | bytes[1]!).toString(16)}:${((bytes[2]! << 8) | bytes[3]!).toString(16)}`
  }
  if (normalized.split('::').length > 2) return undefined
  const [leftText, rightText] = normalized.split('::')
  const left = leftText ? leftText.split(':').map(parseHexWord) : []
  const right = rightText ? rightText.split(':').map(parseHexWord) : []
  if ([...left, ...right].some((word) => word === undefined)) return undefined
  const missing = 8 - left.length - right.length
  if ((normalized.includes('::') && missing < 1) || (!normalized.includes('::') && missing !== 0)) return undefined
  return [...left, ...Array.from({ length: missing }, () => 0), ...right] as number[]
}

function wordsToIpv4(high: number, low: number): number[] {
  return [high >>> 8, high & 0xff, low >>> 8, low & 0xff]
}

function embeddedIpv4(words: number[]): number[] | undefined {
  const last = wordsToIpv4(words[6]!, words[7]!)
  const zero = (end: number): boolean => words.slice(0, end).every((word) => word === 0)
  if (zero(6)) return last // IPv4-compatible, including ::127.0.0.1
  if (zero(5) && words[5] === 0xffff) return last // IPv4-mapped
  if (zero(4) && words[4] === 0xffff && words[5] === 0) return last // IPv4-translated
  if (words[0] === 0x64 && words[1] === 0xff9b && words.slice(2, 6).every((word) => word === 0)) return last // NAT64 well-known, 64:ff9b::/96
  if (words[0] === 0x64 && words[1] === 0xff9b && words[2] === 1) return last // NAT64 local-use, 64:ff9b:1::/48
  return undefined
}

function isPrivateIpv6(address: string, checkIpv4: (octets: number[]) => boolean): boolean {
  const words = parseIpv6Words(address)
  if (!words) return true // unparseable — fail closed, never treat as public

  const embedded = embeddedIpv4(words)
  if (embedded) return checkIpv4(embedded)

  // Global unicast is 2000::/3; everything else (unspecified, loopback, link-local, ULA,
  // multicast, documentation, and future special-use space) fails closed.
  if (words[0]! < 0x2000 || words[0]! > 0x3fff) return true
  if (words[0] === 0x2001 && words[1] === 0x0db8) return true // 2001:db8::/32 documentation

  // 6to4 (2002::/16) carries an IPv4 destination in words 1-2 — don't let an alternate IPv6
  // spelling turn a private/metadata IPv4 destination into "public".
  if (words[0] === 0x2002 && checkIpv4(wordsToIpv4(words[1]!, words[2]!))) return true
  return false
}

/** True if `address` (an IPv4 or bracket-free IPv6 literal, as returned by DNS resolution or a
 * URL's hostname) is a private, reserved, or otherwise non-public destination — the previous
 * (non-TEST-NET-closing) table `assertPublicHttpUrl` below has always used. */
export function isPrivateAddress(address: string): boolean {
  const unscoped = address.split('%', 1)[0]!
  const ipv4 = parseIpv4(unscoped)
  if (ipv4) return isPrivateIpv4(ipv4)
  return isPrivateIpv6(unscoped, isPrivateIpv4)
}

/** Same table, plus the TEST-NETs and the 6to4 relay anycast range (`isPrivateIpv4Strict`
 * above) — for `safe-proxy.ts` only, which has no TEST-NET-fixture caller to preserve. */
export function isPrivateAddressStrict(address: string): boolean {
  const unscoped = address.split('%', 1)[0]!
  const ipv4 = parseIpv4(unscoped)
  if (ipv4) return isPrivateIpv4Strict(ipv4)
  return isPrivateIpv6(unscoped, isPrivateIpv4Strict)
}

export async function assertPublicHttpUrl(raw: string): Promise<void> {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`Invalid URL: ${raw}`)
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Disallowed protocol: ${parsed.protocol}`)
  }

  const hostname = normalizeHostname(parsed.hostname)

  if (isBlockedHostnameLiteral(hostname)) {
    throw new Error(`Blocked hostname: ${hostname}`)
  }

  // DNS resolution — also covers literal IPs (lookup returns them directly)
  let addresses: Array<{ address: string }>
  try {
    addresses = await lookup(hostname, { all: true })
  } catch (err) {
    throw new Error(`DNS resolution failed for ${hostname}: ${String(err)}`)
  }

  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new Error(`Resolved to private/reserved IP: ${address}`)
    }
  }
}
