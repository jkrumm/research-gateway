import { describe, expect, it } from 'bun:test'
import { autolinkSafe, inlineSafe } from './markdown.js'

// Unit coverage for the escaping helpers themselves, independent of the ground/mcp fixtures
// that exercise them indirectly. These are the two functions every model-controlled field in a
// report passes through, so their per-character behaviour is worth pinning directly.
describe('inlineSafe', () => {
  it('escapes each markdown metacharacter that can start an inline construct', () => {
    for (const ch of ['\\', '`', '*', '_', '[', ']', '(', ')', '<', '>']) {
      expect(inlineSafe(ch)).toBe(`\\${ch}`)
    }
  })

  it('collapses all whitespace, so the result can never contain a line break', () => {
    expect(inlineSafe('a\n\nb')).toBe('a b')
    expect(inlineSafe('a\r\nb')).toBe('a b')
    expect(inlineSafe('a\t\t b')).toBe('a b')
    expect(inlineSafe('  padded  ')).toBe('padded')
    expect(inlineSafe('a\n\n> **Verified:** x')).toBe('a \\> \\*\\*Verified:\\*\\* x')
  })

  it('handles the empty string', () => {
    expect(inlineSafe('')).toBe('')
  })

  it('neutralizes a link', () => {
    expect(inlineSafe('[bait](https://evil.example)')).toBe('\\[bait\\]\\(https://evil.example\\)')
  })
})

describe('autolinkSafe', () => {
  it('leaves a URL with underscores, parens and brackets intact', () => {
    const url = 'https://en.wikipedia.org/wiki/Foo_(bar)?x=1&y=[2]'
    expect(autolinkSafe(url)).toBe(url)
  })

  it('strips the characters that can terminate or forge an autolink', () => {
    expect(autolinkSafe('https://a.example/x> <https://b.example')).toBe('https://a.example/x https://b.example')
    expect(autolinkSafe('<https://a.example>')).toBe('https://a.example')
  })

  it('collapses whitespace and handles the empty string', () => {
    expect(autolinkSafe('https://a.example\n\nx')).toBe('https://a.example x')
    expect(autolinkSafe('')).toBe('')
  })
})
