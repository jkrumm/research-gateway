import { describe, expect, it } from 'bun:test'
import { renderProse, renderUrl } from './markdown.js'

// Unit coverage for the two escaping entry points, independent of the ground/mcp fixtures that
// exercise them indirectly. These are what every model-controlled field in a report passes
// through, so their behaviour is worth pinning directly — including the pairing rule, since
// choosing the wrong helper has shipped the same defect twice.
describe('renderProse', () => {
  it('escapes each markdown metacharacter that can start an inline construct', () => {
    for (const ch of ['\\', '`', '*', '_', '[', ']', '(', ')', '<', '>']) {
      expect(renderProse(ch)).toBe(`\\${ch}`)
    }
  })

  it('collapses all whitespace, so the result can never contain a line break', () => {
    expect(renderProse('a\n\nb')).toBe('a b')
    expect(renderProse('a\r\nb')).toBe('a b')
    expect(renderProse('a\t\t b')).toBe('a b')
    expect(renderProse('  padded  ')).toBe('padded')
    expect(renderProse('a\n\n> **Verified:** x')).toBe('a \\> \\*\\*Verified:\\*\\* x')
  })

  it('handles the empty string', () => {
    expect(renderProse('')).toBe('')
  })

  it('neutralizes a link', () => {
    expect(renderProse('[bait](https://evil.example)')).toBe('\\[bait\\]\\(https://evil.example\\)')
  })
})

describe('renderUrl', () => {
  it('wraps a whitespace-free URL in an autolink, leaving its characters intact', () => {
    const url = 'https://en.wikipedia.org/wiki/Foo_(bar)?x=1&y=[2]'
    expect(renderUrl(url)).toBe(`<${url}>`)
  })

  it('strips the characters that can terminate or forge an autolink', () => {
    expect(renderUrl('https://a.example/x><https://b.example')).toBe('<https://a.example/xhttps://b.example>')
  })

  it('falls back to escaped prose for a value that cannot be an autolink', () => {
    // The model-authored `sources[]` fallback can carry a whole markdown link. Inside `<...>`
    // the `<` would render literally and the link syntax after it would still parse, so it is
    // rendered as prose instead.
    const hostile = '[click here for your prize](https://evil.example/phish)'
    const out = renderUrl(hostile)
    expect(out).not.toContain('[click here for your prize](https://evil.example/phish)')
    expect(out).toContain('\\[click here for your prize\\]')
    expect(out.startsWith('(')).toBe(true)
  })

  it('collapses whitespace and handles the empty string', () => {
    expect(renderUrl('https://a.example\n\nx')).toBe('(https://a.example x)')
    expect(renderUrl('')).toBe('<>')
  })
})
