import { describe, it, expect } from 'bun:test'
import { isRawContentType, isDefinitivelyMissing } from './response-kind.js'

describe('isRawContentType', () => {
  it('accepts JSON, including with charset parameters and odd casing', () => {
    expect(isRawContentType('application/json')).toBe(true)
    expect(isRawContentType('application/json; charset=utf-8')).toBe(true)
    expect(isRawContentType('Application/JSON')).toBe(true)
  })

  it('accepts structured-suffix types', () => {
    expect(isRawContentType('application/vnd.api+json')).toBe(true)
    expect(isRawContentType('application/ld+json')).toBe(true)
    expect(isRawContentType('application/rss+xml')).toBe(true)
    expect(isRawContentType('application/atom+xml; charset=utf-8')).toBe(true)
  })

  it('accepts plain text, markdown, csv and yaml', () => {
    expect(isRawContentType('text/plain')).toBe(true)
    expect(isRawContentType('text/markdown')).toBe(true)
    expect(isRawContentType('text/csv')).toBe(true)
    expect(isRawContentType('application/yaml')).toBe(true)
  })

  // The whole extraction chain exists for HTML. Sending it down the verbatim path would
  // hand a model raw markup and skip Readability, the site adapters and every renderer.
  it('NEVER treats HTML as raw', () => {
    expect(isRawContentType('text/html')).toBe(false)
    expect(isRawContentType('text/html; charset=utf-8')).toBe(false)
    expect(isRawContentType('application/xhtml+xml')).toBe(false)
  })

  it('is false for a missing or empty header — the HTML path is the safe default', () => {
    expect(isRawContentType(null)).toBe(false)
    expect(isRawContentType(undefined)).toBe(false)
    expect(isRawContentType('')).toBe(false)
  })

  it('is false for binary types the chain cannot use', () => {
    expect(isRawContentType('application/pdf')).toBe(false)
    expect(isRawContentType('image/png')).toBe(false)
    expect(isRawContentType('application/octet-stream')).toBe(false)
  })
})

describe('isDefinitivelyMissing', () => {
  it('short-circuits only 404 and 410', () => {
    expect(isDefinitivelyMissing(404)).toBe(true)
    expect(isDefinitivelyMissing(410)).toBe(true)
  })

  // Load-bearing: a blocked page is not an absent one. Surfline answers the renderer with
  // 403 on a page Jina reads fine, so treating 403 as definitive would delete a recovery
  // the benchmark actually observes.
  it('does NOT short-circuit "blocked" statuses, which a different client can get past', () => {
    expect(isDefinitivelyMissing(401)).toBe(false)
    expect(isDefinitivelyMissing(403)).toBe(false)
    expect(isDefinitivelyMissing(429)).toBe(false)
  })

  it('does not short-circuit server errors, which are transient', () => {
    expect(isDefinitivelyMissing(500)).toBe(false)
    expect(isDefinitivelyMissing(502)).toBe(false)
    expect(isDefinitivelyMissing(503)).toBe(false)
  })

  it('does not short-circuit success', () => {
    expect(isDefinitivelyMissing(200)).toBe(false)
    expect(isDefinitivelyMissing(204)).toBe(false)
  })
})
