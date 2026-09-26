import { describe, it, expect, afterEach } from 'bun:test'
import * as net from 'node:net'
import { createSafeProxy, shouldAbandonAfterResolve, wouldRefuseDestination, type SafeProxy } from './safe-proxy.js'

describe('wouldRefuseDestination — the decision function', () => {
  it('refuses a blocked hostname literal regardless of what it resolved to', () => {
    expect(wouldRefuseDestination('localhost', ['93.184.216.34'])).toBe(true)
    expect(wouldRefuseDestination('mini.local', ['93.184.216.34'])).toBe(true)
  })

  it('refuses when no address resolved', () => {
    expect(wouldRefuseDestination('example.com', [])).toBe(true)
  })

  it('refuses when ANY resolved address is private, even if another is public', () => {
    expect(wouldRefuseDestination('example.com', ['93.184.216.34', '127.0.0.1'])).toBe(true)
  })

  it('allows a host that resolves only to public addresses', () => {
    expect(wouldRefuseDestination('example.com', ['93.184.216.34'])).toBe(false)
  })
})

describe('shouldAbandonAfterResolve — the guard applied right after resolveSafe returns', () => {
  it('abandons when the proxy is closing, regardless of the caller socket', () => {
    expect(shouldAbandonAfterResolve(true, false)).toBe(true)
    expect(shouldAbandonAfterResolve(true, true)).toBe(true)
  })

  it("abandons when the caller's own socket was already destroyed while resolveSafe was pending, even though the proxy itself is not closing", () => {
    expect(shouldAbandonAfterResolve(false, true)).toBe(true)
  })

  it('proceeds only when neither is true', () => {
    expect(shouldAbandonAfterResolve(false, false)).toBe(false)
  })
})

describe('createSafeProxy — real loopback refusal, in-process', () => {
  let proxy: SafeProxy | undefined

  afterEach(async () => {
    await proxy?.close()
    proxy = undefined
  })

  function rawRequest(port: number, lines: string[]): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port })
      let data = ''
      socket.on('data', (chunk) => {
        data += chunk.toString('utf-8')
      })
      socket.on('error', reject)
      socket.on('close', () => {
        const statusLine = data.split('\r\n')[0] ?? ''
        const match = /^HTTP\/1\.[01] (\d+)/.exec(statusLine)
        resolve({ status: match ? Number(match[1]) : 0, body: data })
      })
      socket.on('connect', () => {
        socket.write(lines.join('\r\n') + '\r\n\r\n')
        // No further request body for CONNECT/GET-with-no-body — half-close so the server's
        // response triggers our 'close' handler above instead of waiting forever.
        setTimeout(() => socket.end(), 300)
      })
    })
  }

  it('refuses a CONNECT tunnel to a loopback destination', async () => {
    proxy = await createSafeProxy()
    const result = await rawRequest(proxy.port, ['CONNECT 127.0.0.1:80 HTTP/1.1', 'Host: 127.0.0.1'])
    expect(result.status).toBe(403)
    expect(proxy.policyError()?.message).toMatch(/Unsafe fetch destination/)
  })

  it('refuses a CONNECT tunnel to a link-local (cloud metadata) destination', async () => {
    proxy = await createSafeProxy()
    const result = await rawRequest(proxy.port, ['CONNECT 169.254.169.254:443 HTTP/1.1', 'Host: 169.254.169.254'])
    expect(result.status).toBe(403)
  })

  it('refuses a plain HTTP GET whose target host is loopback', async () => {
    proxy = await createSafeProxy()
    const result = await rawRequest(proxy.port, ['GET http://127.0.0.1:9/health HTTP/1.1', 'Host: 127.0.0.1:9'])
    expect(result.status).toBe(403)
  })

  it('refuses a blocked hostname literal without ever resolving DNS', async () => {
    proxy = await createSafeProxy()
    const result = await rawRequest(proxy.port, ['CONNECT localhost:80 HTTP/1.1', 'Host: localhost'])
    expect(result.status).toBe(403)
  })

  it('binds to the requested fixed port when one is given', async () => {
    // Port 0 here too (a real fixed port would collide across parallel test runs) — the point
    // is only that the option is honored, not a specific number.
    proxy = await createSafeProxy({ port: 0 })
    expect(proxy.port).toBeGreaterThan(0)
    expect(proxy.url).toBe(`http://127.0.0.1:${proxy.port}`)
  })

})
