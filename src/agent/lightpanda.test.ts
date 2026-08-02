import { describe, it, expect } from 'bun:test'
import { parseRenderResponse, renderUrl } from './lightpanda.js'

const long = (n = 400) => 'Real page content. '.repeat(Math.ceil(n / 19)).slice(0, n)

describe('parseRenderResponse', () => {
  it('accepts a successful render', () => {
    const out = parseRenderResponse(200, { ok: true, text: long(), status: 200 })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.text).toContain('Real page content.')
  })

  it('reports a sidecar failure with the reason it gave', () => {
    const out = parseRenderResponse(200, { ok: false, error: 'navigation failed: CouldntResolveHost' })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error).toContain('CouldntResolveHost')
  })

  it('distinguishes the sidecar being broken from a page that would not render', () => {
    const out = parseRenderResponse(502, { ok: true, text: long() })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error).toContain('502')
  })

  it('REFUSES a success envelope that carries no real content', () => {
    // The invariant this whole chain is built around: a response that looks successful but is
    // empty or stubbed must be an error, not page content. The sidecar enforces the same floor
    // — this is the boundary check that survives a sidecar bug or a version skew.
    for (const body of [
      { ok: true, text: 'Too short.' },
      { ok: true, text: '   ' },
      { ok: true },
      { ok: true, text: 42 },
    ]) {
      const out = parseRenderResponse(200, body)
      expect(out.ok).toBe(false)
    }
  })

  it('rejects a body that is not an object', () => {
    for (const body of [null, 'text', 42]) {
      expect(parseRenderResponse(200, body).ok).toBe(false)
    }
  })

  it('builds the render endpoint, tolerating a trailing slash on the base', () => {
    expect(renderUrl('http://research-gateway-lightpanda:7781')).toBe(
      'http://research-gateway-lightpanda:7781/render',
    )
    expect(renderUrl('http://research-gateway-lightpanda:7781/')).toBe(
      'http://research-gateway-lightpanda:7781/render',
    )
  })
})
