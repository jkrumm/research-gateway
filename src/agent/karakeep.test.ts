import { describe, it, expect } from 'bun:test'
import {
  buildKarakeepSearchUrl,
  buildKarakeepPreviewUrl,
  parseBookmarkSearchResponse,
  parseHighlightsResponse,
  htmlToText,
  rankAndBuildBookmarks,
} from './karakeep.js'
import type { KarakeepBookmarkInput } from './karakeep.js'

const BASE = 'https://karakeep.example'

// Fixtures in the shape verified against Karakeep v1 on 2026-09-25 — a `link` bookmark, a `text`
// bookmark, and the surrounding envelope. No live calls in tests.
function linkBookmark(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'bm_link',
    createdAt: '2026-09-20T10:00:00.000Z',
    modifiedAt: '2026-09-21T10:00:00.000Z',
    title: null,
    note: null,
    summary: null,
    tags: [{ id: 't1', name: 'deepseek', attachedBy: 'human' }],
    archived: false,
    favourited: false,
    content: {
      type: 'link',
      url: 'https://example.com/original-article',
      title: 'DeepSeek routing notes',
      description: 'A short description',
      htmlContent: '<p>The <b>deepseek</b> routing model</p><script>ignore()</script>',
      crawlStatus: 'success',
    },
    ...overrides,
  }
}

describe('buildKarakeepSearchUrl', () => {
  it('builds the v1 search URL with query, limit and includeContent', () => {
    const url = buildKarakeepSearchUrl(BASE, 'model routing', 10)
    expect(url).toBe('https://karakeep.example/api/v1/bookmarks/search?q=model+routing&limit=10&includeContent=true')
  })

  it('strips a trailing slash from the base and never doubles the /api path', () => {
    expect(buildKarakeepSearchUrl('https://karakeep.example/', 'x', 3)).toBe(
      'https://karakeep.example/api/v1/bookmarks/search?q=x&limit=3&includeContent=true',
    )
  })
})

describe('buildKarakeepPreviewUrl', () => {
  it('builds the dashboard preview URL', () => {
    expect(buildKarakeepPreviewUrl(BASE, 'abc123')).toBe('https://karakeep.example/dashboard/preview/abc123')
  })
})

describe('parseBookmarkSearchResponse', () => {
  it('reads the bookmarks array and keeps entries with a string id', () => {
    const parsed = parseBookmarkSearchResponse({ bookmarks: [linkBookmark()], nextCursor: null })
    expect(parsed.length).toBe(1)
    expect(parsed[0]?.id).toBe('bm_link')
  })

  it('returns [] for a missing or non-array bookmarks field', () => {
    expect(parseBookmarkSearchResponse({})).toEqual([])
    expect(parseBookmarkSearchResponse({ bookmarks: null })).toEqual([])
    expect(parseBookmarkSearchResponse('not json')).toEqual([])
  })

  it('skips a malformed entry without an id instead of throwing', () => {
    const parsed = parseBookmarkSearchResponse({ bookmarks: [{ title: 'no id' }, null, linkBookmark()] })
    expect(parsed.map((b) => b.id)).toEqual(['bm_link'])
  })
})

describe('parseHighlightsResponse', () => {
  it('reads highlight texts', () => {
    expect(parseHighlightsResponse({ highlights: [{ text: 'important', note: 'x' }] })).toEqual(['important'])
  })

  it('tolerates an empty or missing highlights list', () => {
    expect(parseHighlightsResponse({ highlights: [] })).toEqual([])
    expect(parseHighlightsResponse({})).toEqual([])
  })
})

describe('htmlToText', () => {
  it('strips tags and scripts, keeping the prose', () => {
    expect(htmlToText('<p>The <b>deepseek</b> routing model</p><script>ignore()</script>')).toBe(
      'The deepseek routing model',
    )
  })

  it('turns block boundaries into newlines and decodes entities', () => {
    expect(htmlToText('<p>first</p><p>a &amp; b caf&#233;</p>')).toBe('first\na & b café')
  })
})

describe('rankAndBuildBookmarks', () => {
  const terms = ['deepseek']

  function bookmark(overrides: Partial<KarakeepBookmarkInput> & { id: string }): KarakeepBookmarkInput {
    const base = linkBookmark()
    return {
      id: overrides.id,
      createdAt: overrides.createdAt ?? base['createdAt'],
      modifiedAt: overrides.modifiedAt ?? base['modifiedAt'],
      title: overrides.title ?? base['title'],
      note: overrides.note ?? base['note'],
      summary: overrides.summary ?? base['summary'],
      tags: overrides.tags ?? base['tags'],
      content: overrides.content ?? base['content'],
    }
  }

  it('ranks a title match above a body-only match and cites the preview URL', () => {
    const results = rankAndBuildBookmarks({
      bookmarks: [
        bookmark({ id: 'body', title: null, content: { htmlContent: '<p>deepseek</p>' } }),
        bookmark({ id: 'title', title: 'DeepSeek pricing', content: { htmlContent: '<p>unrelated</p>' } }),
      ],
      terms,
      baseUrl: BASE,
    })
    expect(results.map((r) => r.id)).toEqual(['title', 'body'])
    expect(results[0]?.url).toBe('https://karakeep.example/dashboard/preview/title')
    expect(results[0]?.kind).toBe('bookmark')
  })

  it('names the original page URL in the excerpt but keeps the preview URL as the citation', () => {
    const results = rankAndBuildBookmarks({ bookmarks: [bookmark({ id: 'bm_link' })], terms, baseUrl: BASE })
    expect(results[0]?.url).toBe('https://karakeep.example/dashboard/preview/bm_link')
    expect(results[0]?.originalUrl).toBe('https://example.com/original-article')
    expect(results[0]?.excerpt).toContain('Original page: https://example.com/original-article')
  })

  it('handles a text bookmark via content.text', () => {
    const results = rankAndBuildBookmarks({
      bookmarks: [bookmark({ id: 'txt', title: null, content: { type: 'text', text: 'deepseek memo', url: null } })],
      terms,
      baseUrl: BASE,
    })
    expect(results.map((r) => r.id)).toEqual(['txt'])
  })

  it('drops a bookmark with nothing to excerpt', () => {
    const results = rankAndBuildBookmarks({
      bookmarks: [bookmark({ id: 'empty', title: null, note: null, summary: null, content: { type: 'asset' } })],
      terms,
      baseUrl: BASE,
    })
    expect(results).toEqual([])
  })

  it('caps results and attaches highlights', () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      bookmark({ id: `bm_${i}`, title: `deepseek note ${i}`, content: { htmlContent: '<p>deepseek</p>' } }),
    )
    const highlights = new Map([['bm_0', ['a highlighted sentence']]])
    const results = rankAndBuildBookmarks({ bookmarks: many, terms, baseUrl: BASE, highlightsById: highlights, maxResults: 3 })
    expect(results.length).toBe(3)
    expect(results.find((r) => r.id === 'bm_0')?.highlights).toEqual(['a highlighted sentence'])
  })

  it('carries the modified date through', () => {
    const results = rankAndBuildBookmarks({ bookmarks: [bookmark({ id: 'bm_link' })], terms, baseUrl: BASE })
    expect(results[0]?.updated).toBe('2026-09-21T10:00:00.000Z')
  })
})
