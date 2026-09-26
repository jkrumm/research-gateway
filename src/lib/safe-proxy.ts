// A loopback-only HTTP + CONNECT proxy that refuses to reach a private/reserved address —
// the backstop for the human-solve escalation path's solver Chrome (bin/solver.ts), which
// renders an LLM-chosen (attacker-influenced) URL. `assertPublicHttpUrl` in ssrf.ts already
// guards the URL Chrome is TOLD to open, but Chrome itself can be steered somewhere else
// afterward (a redirect, a fetch() from page script, DNS rebinding between that check and
// Chrome's own connect) with no further check in between. Routing Chrome's own traffic through
// this proxy closes that gap: it resolves DNS ITSELF, decides safety from the RESOLVED address
// (defeating rebinding — a hostname that resolves safely now cannot later connect anywhere
// unsafe through this proxy), and refuses if ANY resolved address is unsafe.
//
// Precisely what this covers, not a blanket "network-level boundary": Chrome's HTTP(S) and
// WebSocket traffic is routed through this proxy (`--proxy-server` + `--proxy-bypass-list=
// <-loopback>`, bin/solver.ts's chromeLaunchArgs); WebRTC is a separate path this proxy does
// not see at all, restricted instead at the Chrome-flag level to proxied UDP only
// (`--force-webrtc-ip-handling-policy=disable_non_proxied_udp` /
// `--webrtc-ip-handling-policy=disable_non_proxied_udp`). Those two are the only network paths
// page JS running in Chrome can reach — there is no other raw TCP/UDP socket API available to
// it, so nothing is unaccounted for, but say so as two mechanisms, not one boundary.
//
// Adapted from agentrhq/webcmd src/fetch/safe-proxy.ts (Apache-2.0). The private/reserved-range
// table itself is NOT duplicated here — this file shares ssrf.ts's table via
// `isPrivateAddressStrict` (the fuller, webcmd-derived range set — this proxy has no TEST-NET
// fixture depending on those ranges staying reachable, unlike `assertPublicHttpUrl`'s callers,
// so there is no reason not to close them here) and `isBlockedHostnameLiteral`.
//
// Caveat that does NOT change with this proxy in place: a CONNECT tunnel carries TLS
// end-to-end (the proxy only sees encrypted bytes past the handshake), so the Cloudflare-visible
// TLS/HTTP fingerprint and the egress IP the target site sees are both unchanged — this guards
// the DESTINATION Chrome can reach, not what it looks like once it gets there.

import { lookup as dnsLookup } from 'node:dns'
import * as http from 'node:http'
import * as net from 'node:net'
import type { Duplex } from 'node:stream'
import { isBlockedHostnameLiteral, isPrivateAddressStrict, normalizeHostname } from './ssrf.js'

export interface SafeProxy {
  url: string
  port: number
  close(): Promise<void>
  /** The first refused destination this proxy has seen, if any — surfaced for a live-verify
   * probe / health check without parsing log lines. */
  policyError(): Error | undefined
}

export interface SafeProxyOptions {
  /** Fixed port to bind (0 = OS-assigned, used only by tests). Production always passes
   * `HUMAN_SOLVE_PROXY_PORT` so Chrome's `--proxy-server` flag can be a constant. */
  port?: number
  /** Override for tests only — production always uses node:dns's real resolver. */
  lookup?: typeof dnsLookup
}

/** Pure decision function, exported so it is unit-testable without a real server or a real DNS
 * lookup: given resolved addresses for a destination, would this proxy refuse it? Mirrors the
 * "refuse if ANY resolved address is unsafe" rule the HTTP and CONNECT handlers both apply. */
export function wouldRefuseDestination(host: string, addresses: string[]): boolean {
  if (isBlockedHostnameLiteral(host)) return true
  if (addresses.length === 0) return true
  return addresses.some((address) => isPrivateAddressStrict(address))
}

/** The guard both the HTTP and CONNECT handlers apply right after `resolveSafe` returns (a real,
 * asynchronous DNS round trip): dialling upstream is refused once either the whole proxy is
 * shutting down, or the CALLER's own socket has already errored/closed while that lookup was
 * still pending — either way, nobody is left to read a response on it. Extracted as a pure
 * predicate so this is unit-testable without a real socket and real TCP-teardown timing, same
 * convention as `wouldRefuseDestination` above. */
export function shouldAbandonAfterResolve(closing: boolean, callerSocketDestroyed: boolean): boolean {
  return closing || callerSocketDestroyed
}

async function resolveSafe(rawHost: string, lookup: typeof dnsLookup): Promise<string> {
  const host = normalizeHostname(rawHost)
  if (isBlockedHostnameLiteral(host)) {
    throw new Error(`Unsafe fetch destination: ${host}`)
  }
  if (net.isIP(host)) {
    if (isPrivateAddressStrict(host)) throw new Error(`Unsafe fetch destination: ${host}`)
    return host
  }
  const addresses = await new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
    lookup(host, { all: true, verbatim: true }, (error, result) => (error ? reject(error) : resolve(result)))
  })
  if (wouldRefuseDestination(host, addresses.map((a) => a.address))) {
    throw new Error(`Unsafe fetch destination: ${host}`)
  }
  return addresses[0]!.address
}

export async function createSafeProxy(options: SafeProxyOptions = {}): Promise<SafeProxy> {
  const lookup = options.lookup ?? dnsLookup

  // Sockets opened through this proxy, including the upstream halves the HTTP server never
  // learns about. `close()` destroys them: a keep-alive CONNECT tunnel otherwise keeps
  // `server.close()` pending until the peer or the OS gives up.
  const sockets = new Set<Duplex>()
  // Both request paths await DNS before connecting upstream, so a resolution landing after
  // `close()` could otherwise open an untracked socket. Once closing, nothing new is tracked
  // or dialled.
  let closing = false
  let firstPolicyError: Error | undefined
  const track = <T extends Duplex>(socket: T): T => {
    if (closing) {
      socket.destroy()
      return socket
    }
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => socket.destroy())
    return socket
  }

  const server = http.createServer(async (request, response) => {
    let upstream: http.ClientRequest | undefined
    request.on('error', () => {
      upstream?.destroy()
      response.destroy()
    })
    response.on('error', () => {
      upstream?.destroy()
      request.destroy()
    })
    try {
      const target = new URL(request.url ?? '')
      const address = await resolveSafe(target.hostname, lookup)
      if (closing) {
        response.destroy()
        return
      }
      upstream = http.request(
        {
          host: address,
          port: Number(target.port) || 80,
          method: request.method,
          path: `${target.pathname}${target.search}`,
          headers: { ...request.headers, host: target.host },
        },
        (upstreamResponse) => {
          response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
          upstreamResponse.pipe(response)
        },
      )
      upstream.on('socket', track)
      upstream.on('error', (error) => response.destroy(error))
      request.pipe(upstream)
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Unsafe fetch destination:')) firstPolicyError ??= error
      response.writeHead(403).end(error instanceof Error ? error.message : 'Unsafe fetch destination')
    }
  })
  server.on('connection', track)
  server.on('connect', async (request, client, head) => {
    track(client)
    let upstream: net.Socket | undefined
    client.on('error', () => upstream?.destroy())
    client.on('close', () => upstream?.destroy())
    try {
      const authority = new URL(`http://${request.url ?? ''}`)
      const portText = authority.port
      const address = await resolveSafe(authority.hostname, lookup)
      if (shouldAbandonAfterResolve(closing, client.destroyed)) {
        client.destroy()
        return
      }
      const tunnel = track(net.connect({ host: address, port: Number(portText) || 443 }))
      upstream = tunnel
      tunnel.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) tunnel.write(head)
        // TLS travels end-to-end through this pipe — the proxy sees only the encrypted bytes
        // past this point, so it decides safety once, on the CONNECT target, not per byte.
        tunnel.pipe(client)
        client.pipe(tunnel)
      })
      tunnel.on('error', (error) => client.destroy(error))
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Unsafe fetch destination:')) firstPolicyError ??= error
      client.end(`HTTP/1.1 403 Forbidden\r\n\r\n${error instanceof Error ? error.message : ''}`)
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Safe proxy did not bind')

  let closed: Promise<void> | undefined
  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    policyError: () => firstPolicyError,
    close: () =>
      (closed ??= new Promise((resolve, reject) => {
        closing = true
        for (const socket of sockets) socket.destroy()
        sockets.clear()
        server.close((error) => (error ? reject(error) : resolve()))
      })),
  }
}
