import { describe, it, expect } from 'bun:test'
import { parseLightpandaStdout } from './parse.js'

const long = (n = 400) => 'Real page content. '.repeat(Math.ceil(n / 19)).slice(0, n)

const dump = (parts: { status?: number; content?: string }) =>
  JSON.stringify({
    url: 'https://example.com/a',
    http_status: parts.status ?? 200,
    headers: [{ name: 'Server', value: 'nginx' }],
    dump: 'markdown',
    content: parts.content ?? long(),
  })

describe('parseLightpandaStdout', () => {
  it('returns the markdown content of a rendered page', () => {
    const out = parseLightpandaStdout(dump({ content: `# Title\n\n${long()}` }))
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.text).toContain('Real page content.')
    expect(out.status).toBe(200)
  })

  it('FAILS on http_status 0 even though the process exited 0 and content is non-empty', () => {
    // The measured shape for a dead domain. `content` is lightpanda's own synthetic error
    // page — taking it at face value would file "Reason: CouldntResolveHost" as retrieved
    // page text and let a citation rest on it.
    const out = parseLightpandaStdout(
      JSON.stringify({
        url: 'https://this-domain-does-not-exist-xyz123.com/',
        http_status: 0,
        headers: [],
        dump: 'markdown',
        content: '\n# Navigation failed\n\nReason: CouldntResolveHost\n',
      }),
    )
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error).toContain('CouldntResolveHost')
  })

  it('fails on an HTTP error status', () => {
    const out = parseLightpandaStdout(dump({ status: 404, content: long() }))
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error).toContain('404')
  })

  it('fails on the synthetic navigation page even if the status looks fine', () => {
    // Belt and braces: today this always arrives with http_status 0, but a future version
    // pairing it with a 200 must not slip through as page content.
    const out = parseLightpandaStdout(
      dump({ status: 200, content: `# Navigation failed\n\nReason: ConnectionRefused\n\n${long()}` }),
    )
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error).toContain('ConnectionRefused')
  })

  it('fails on content below the 200-char floor rather than returning a stub', () => {
    const out = parseLightpandaStdout(dump({ content: 'Too short.' }))
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error).toContain('chars of content')
  })

  it('survives an uncaught page exception printed to stdout AFTER the dump', () => {
    // Reproducible on techempower.com/benchmarks, 3/3 runs: lightpanda writes uncaught page-JS
    // exceptions to stdout, so a naive JSON.parse of the whole stream throws `Extra data`.
    const out = parseLightpandaStdout(`${dump({})}\nUncaught TypeError: Illegal invocation\n`)
    expect(out.ok).toBe(true)
  })

  it('survives noise printed BEFORE the dump', () => {
    const out = parseLightpandaStdout(`Uncaught TypeError: Illegal invocation\n{"not":"a dump"}\n${dump({})}`)
    expect(out.ok).toBe(true)
  })

  it('fails when stdout carries no dump at all', () => {
    for (const stdout of ['', 'Uncaught TypeError: Illegal invocation\n', 'not json']) {
      const out = parseLightpandaStdout(stdout)
      expect(out.ok).toBe(false)
      if (out.ok) return
      expect(out.error).toContain('no parseable result')
    }
  })

  it('fails on a truncated dump line rather than half-parsing it', () => {
    const out = parseLightpandaStdout(dump({}).slice(0, 200))
    expect(out.ok).toBe(false)
  })
})
