import { lookup } from 'node:dns/promises'

// Residual gaps (acceptable for v1; full IP-pinning deferred):
//  1. DNS rebinding — we validate the resolved IP here, but the runtime re-resolves the
//     hostname at actual connect time (TOCTOU window). Per-hop redirect validation is now
//     closed: safeFetch() in tools.ts calls assertPublicHttpUrl() on every redirect target
//     before following it.

const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata'])

const BLOCKED_SUFFIXES = ['.local', '.internal', '.localdomain']

function isPrivateIp(ip: string): boolean {
  // IPv6 checks (case-insensitive prefix matching on normalized lowercase)
  const lower = ip.toLowerCase()
  if (lower === '::1') return true // loopback
  if (lower === '::') return true // unspecified
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true // fc00::/7 ULA
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
    return true // fe80::/10 link-local
  }
  // IPv4-mapped: ::ffff:a.b.c.d
  if (lower.startsWith('::ffff:')) {
    const embedded = ip.slice('::ffff:'.length)
    return isPrivateIp(embedded)
  }

  // IPv4 checks: parse into 32-bit integer
  const parts = ip.split('.')
  if (parts.length !== 4) return false
  const octets = parts.map(Number)
  if (octets.some((o) => isNaN(o) || o < 0 || o > 255)) return false
  const n = ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0

  // 0.0.0.0/8
  if ((n & 0xff000000) >>> 0 === 0x00000000) return true
  // 10.0.0.0/8
  if ((n & 0xff000000) >>> 0 === 0x0a000000) return true
  // 100.64.0.0/10 (CGNAT — includes Tailscale range)
  if ((n & 0xffc00000) >>> 0 === 0x64400000) return true
  // 127.0.0.0/8
  if ((n & 0xff000000) >>> 0 === 0x7f000000) return true
  // 169.254.0.0/16 (link-local, includes 169.254.169.254 cloud metadata)
  if ((n & 0xffff0000) >>> 0 === 0xa9fe0000) return true
  // 172.16.0.0/12
  if ((n & 0xfff00000) >>> 0 === 0xac100000) return true
  // 192.0.0.0/24
  if ((n & 0xffffff00) >>> 0 === 0xc0000000) return true
  // 192.168.0.0/16
  if ((n & 0xffff0000) >>> 0 === 0xc0a80000) return true
  // 198.18.0.0/15
  if ((n & 0xfffe0000) >>> 0 === 0xc6120000) return true
  // 224.0.0.0 and above (multicast + reserved)
  if (n >= 0xe0000000) return true

  return false
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

  const hostname = parsed.hostname.toLowerCase()

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error(`Blocked hostname: ${hostname}`)
  }

  for (const suffix of BLOCKED_SUFFIXES) {
    if (hostname.endsWith(suffix)) {
      throw new Error(`Blocked hostname suffix: ${hostname}`)
    }
  }

  // DNS resolution — also covers literal IPs (lookup returns them directly)
  let addresses: Array<{ address: string }>
  try {
    addresses = await lookup(hostname, { all: true })
  } catch (err) {
    throw new Error(`DNS resolution failed for ${hostname}: ${String(err)}`)
  }

  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new Error(`Resolved to private/reserved IP: ${address}`)
    }
  }
}
