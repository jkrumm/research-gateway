import { describe, it, expect } from 'bun:test'
import { parseJinaResponse, jinaUrl } from './jina.js'

const body = (parts: { title?: string; warning?: string; content?: string }) =>
  [
    `Title: ${parts.title ?? ''}`,
    `URL Source: https://example.com/a`,
    ...(parts.warning ? [`Warning: ${parts.warning}`] : []),
    'Markdown Content:',
    parts.content ?? '',
  ].join('\n')

const long = (n = 400) => 'Real page content. '.repeat(Math.ceil(n / 19)).slice(0, n)

describe('parseJinaResponse', () => {
  it('returns the content with the title prepended', () => {
    const out = parseJinaResponse(body({ title: 'Bun in production', content: long() }))
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.text.startsWith('Bun in production')).toBe(true)
    expect(out.text).toContain('Real page content.')
  })

  it('strips Jina\'s own header block from the content', () => {
    const out = parseJinaResponse(body({ title: 'T', content: long() }))
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.text).not.toContain('URL Source:')
    expect(out.text).not.toContain('Markdown Content:')
  })

  it('FAILS on a Warning line even though the HTTP status was 200', () => {
    // The actual shape Jina returns for a blocked target — measured against Reddit. Taking
    // it at face value would record "You've been blocked by network security" as retrieved
    // page content and let a citation rest on it.
    const out = parseJinaResponse(
      body({
        warning: 'Target URL returned error 403: Forbidden',
        content: "You've been blocked by network security.\n\n" + long(),
      }),
    )
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error).toContain('403')
  })

  it('fails on content below the 200-char floor rather than returning a stub', () => {
    const out = parseJinaResponse(body({ title: 'T', content: 'Too short.' }))
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error).toContain('chars of content')
  })

  it('handles a response with no content marker by treating the whole body as content', () => {
    const out = parseJinaResponse(long(500))
    expect(out.ok).toBe(true)
  })

  it('works when there is no title', () => {
    const out = parseJinaResponse(body({ content: long() }))
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.text.startsWith('Real page content.')).toBe(true)
  })

  it('builds the reader URL by prefixing, keeping the target intact', () => {
    expect(jinaUrl('https://old.reddit.com/r/x/?sort=top')).toBe(
      'https://r.jina.ai/https://old.reddit.com/r/x/?sort=top',
    )
  })
})
