import { describe, it, expect } from 'bun:test'
import { matchExpect, parseGolden, resolverFor } from './lib.js'

describe('matchExpect', () => {
  it('passes when any static pattern matches, case-insensitively', () => {
    const result = matchExpect('The server returns 413 for that body.', { any: ['\\b413\\b'] }, null)
    expect(result.pass).toBe(true)
    expect(result.matched).toBe('413')
    const header = matchExpect('Use the retry-after response header.', { any: ['Retry-After'] }, null)
    expect(header.pass).toBe(true)
  })

  it('fails when no static pattern matches', () => {
    const result = matchExpect('The server returns 400.', { any: ['\\b413\\b'] }, null)
    expect(result.pass).toBe(false)
    expect(result.matched).toBeNull()
  })

  it('passes a live value only when it appears as a literal', () => {
    expect(matchExpect('Latest is 4.6.5 today.', { live: 'npm:hono' }, '4.6.5').pass).toBe(true)
    // A missing resolver value can never score, even if some other version is present.
    expect(matchExpect('Latest is 4.6.5 today.', { live: 'npm:hono' }, null).pass).toBe(false)
    expect(matchExpect('Latest is 4.6.4 today.', { live: 'npm:hono' }, '4.6.5').pass).toBe(false)
  })

  it('treats a live value as a literal, not a regex', () => {
    // A version with a dot must not match a different version that happens to share the shape.
    expect(matchExpect('The release is 1x2x3.', { live: 'crates:serde' }, '1.2.3').pass).toBe(false)
  })
})

describe('resolverFor', () => {
  it('builds the npm latest URL', () => {
    const resolver = resolverFor('npm:hono')
    expect(resolver.url).toBe('https://registry.npmjs.org/hono/latest')
    expect(resolver.headers['User-Agent']).toBe('research-gateway-eval')
  })

  it('builds the PyPI JSON URL', () => {
    expect(resolverFor('pypi:requests').url).toBe('https://pypi.org/pypi/requests/json')
  })

  it('builds the crates.io URL with a User-Agent (the registry requires one)', () => {
    const resolver = resolverFor('crates:serde')
    expect(resolver.url).toBe('https://crates.io/api/v1/crates/serde')
    expect(resolver.headers['User-Agent']).toBeTruthy()
  })

  it('adds an Authorization header for GitHub only when a token is given', () => {
    expect(resolverFor('github-release:oven-sh/bun').headers['Authorization']).toBeUndefined()
    expect(resolverFor('github-release:oven-sh/bun', 'tok').headers['Authorization']).toBe('Bearer tok')
    // The token must not leak onto any other scheme.
    expect(resolverFor('npm:hono', 'tok').headers['Authorization']).toBeUndefined()
  })

  it('rejects malformed and unknown resolver names', () => {
    expect(() => resolverFor('hono')).toThrow('expected "<scheme>:<target>"')
    expect(() => resolverFor('npm:')).toThrow('expected "<scheme>:<target>"')
    expect(() => resolverFor('maven:hono')).toThrow('Unknown live resolver scheme')
  })
})

describe('resolver response parsing', () => {
  it('reads .version from an npm response', () => {
    expect(resolverFor('npm:hono').parse({ name: 'hono', version: '4.6.5' })).toBe('4.6.5')
  })

  it('reads .info.version from a PyPI response', () => {
    expect(resolverFor('pypi:requests').parse({ info: { name: 'requests', version: '2.32.3' } })).toBe('2.32.3')
  })

  it('reads .crate.max_stable_version from a crates.io response', () => {
    expect(resolverFor('crates:serde').parse({ crate: { max_stable_version: '1.0.219' } })).toBe('1.0.219')
  })

  it('strips the bun-v prefix from a Bun release tag', () => {
    expect(resolverFor('github-release:oven-sh/bun').parse({ tag_name: 'bun-v1.2.21' })).toBe('1.2.21')
  })

  it('strips a plain v prefix from an ordinary release tag', () => {
    expect(resolverFor('github-release:some/repo').parse({ tag_name: 'v2.0.0' })).toBe('2.0.0')
  })

  it('throws a labelled error when the expected field is missing', () => {
    expect(() => resolverFor('npm:hono').parse({})).toThrow('Resolver response missing `version`')
    expect(() => resolverFor('github-release:oven-sh/bun').parse({})).toThrow('Resolver response missing `tag_name`')
  })
})

describe('parseGolden', () => {
  it('parses both expect shapes and both depths', () => {
    const items = parseGolden(
      [
        '{"id":"a","query":"q?","depth":"quick","expect":{"any":["\\\\b413\\\\b"]}}',
        '{"id":"b","query":"q?","depth":"standard","expect":{"live":"npm:hono"}}',
      ].join('\n'),
    )
    expect(items).toHaveLength(2)
    expect(items[0]?.expect).toEqual({ any: ['\\b413\\b'] })
    expect(items[1]?.expect).toEqual({ live: 'npm:hono' })
  })

  it('skips blank lines', () => {
    expect(parseGolden('\n\n')).toEqual([])
  })

  it('rejects an unknown depth, a missing field, and a bad regex', () => {
    expect(() => parseGolden('{"id":"a","query":"q?","depth":"slow","expect":{"any":["x"]}}')).toThrow('depth must be one of')
    expect(() => parseGolden('{"id":"a","query":"q?","depth":"quick"}')).toThrow('expect must be')
    expect(() => parseGolden('{"id":"a","query":"q?","depth":"quick","expect":{"any":["("]}}')).toThrow('invalid regex')
  })
})
