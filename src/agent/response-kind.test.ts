import { describe, it, expect } from 'bun:test'
import { isRawContentType, isDefinitivelyMissing, PARSE_INPUT_CAP, MAX_BODY_BYTES, parseInputOverflow } from './response-kind.js'

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

  // Load-bearing: a blocked page is not an absent one. Medium answers the renderer with 403
  // on pages a plain fetch reads at step one, so treating 403 as definitive would delete a
  // recovery the benchmark actually observes.
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

describe('PARSE_INPUT_CAP', () => {
  // The number is the fix, not a tuning default: it is what bounds the worst-case
  // synchronous parse (linkedom + Readability on the shared event loop) that starved
  // heartbeats and the HTTP listener on 2026-09-20. If someone moves it, they should do
  // it with the measurements in hand, not by editing the constant on a hunch.
  it('stays at the measured value the oversized-body guard depends on', () => {
    expect(PARSE_INPUT_CAP).toBe(2_000_000)
  })

  it('sits far above any real article page so it never bites honest traffic', () => {
    // Typical article pages land under 200k chars (fetch-chain.ts's header); the largest
    // real pages are an order of magnitude past that. The cap is for adversarial and
    // accidental giants, not for pages the parser can handle.
    expect(PARSE_INPUT_CAP).toBeGreaterThanOrEqual(1_000_000)
  })
})

describe('MAX_BODY_BYTES', () => {
  // The invariant, not the number: the reader in fetch-chain.ts counts BYTES and this cap
  // counts CHARACTERS, so the byte bound has to be wide enough that it can never be the
  // reason a page the character cap would have accepted goes missing. A UTF-8 character is
  // at most 4 bytes, which makes 4x the exact-width — narrower and a legitimate page at the
  // parse cap gets cut before the parse decision is even reached.
  it('never cuts a body the character cap would have accepted', () => {
    const MAX_UTF8_BYTES_PER_CHAR = 4
    expect(MAX_BODY_BYTES).toBeGreaterThanOrEqual(PARSE_INPUT_CAP * MAX_UTF8_BYTES_PER_CHAR)
  })
})

describe('parseInputOverflow', () => {
  // The decision both step 1 and the Wayback rescue make, in one place — so a single cut body
  // cannot be a miss on one path and a parse on the other.
  it('passes a body that is inside both bounds', () => {
    expect(parseInputOverflow({ text: 'x'.repeat(PARSE_INPUT_CAP), truncated: false })).toBeNull()
  })

  it('rejects a whole body over the character cap, and says by how much', () => {
    const reason = parseInputOverflow({ text: 'x'.repeat(PARSE_INPUT_CAP + 1), truncated: false })
    expect(reason).toContain('oversized')
    expect(reason).toContain(String(PARSE_INPUT_CAP))
  })

  it('rejects a CUT body even when what arrived is under the character cap', () => {
    // The byte reader can stop mid-body, so `text` may be short while the document it came
    // from was not. Parsing a prefix is worse than not parsing: Readability would return the
    // opening of a page as if it were all of it.
    expect(parseInputOverflow({ text: 'x'.repeat(64), truncated: true })).toContain('oversized')
  })

  it('names the byte bound when the body was cut, not the character cap', () => {
    // Which bound fired is the difference between "this page is a giant" and "we stopped
    // reading it" — the second is a caller-side choice and reads wrong in a trace otherwise.
    expect(parseInputOverflow({ text: '', truncated: true })).toContain(String(MAX_BODY_BYTES))
  })
})
