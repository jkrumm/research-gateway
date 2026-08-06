import { describe, it, expect } from 'bun:test'
import { canonicalYoutubeWatchUrl, parseDurationSeconds, parseYoutubeSearch } from './youtube.js'

describe('canonicalYoutubeWatchUrl', () => {
  it('accepts a plain watch URL unchanged in shape', () => {
    expect(canonicalYoutubeWatchUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    )
  })

  it('accepts a bare youtube.com watch URL', () => {
    expect(canonicalYoutubeWatchUrl('https://youtube.com/watch?v=dQw4w9WgXcQ')).toBe(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    )
  })

  it('accepts m.youtube.com and music.youtube.com watch URLs, canonicalising to www', () => {
    expect(canonicalYoutubeWatchUrl('https://m.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    )
    expect(canonicalYoutubeWatchUrl('https://music.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    )
  })

  it('accepts a youtu.be short link and rewrites it to the canonical watch URL', () => {
    expect(canonicalYoutubeWatchUrl('https://youtu.be/dQw4w9WgXcQ')).toBe(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    )
  })

  it('keeps extra query params off the canonical form (only v matters)', () => {
    expect(canonicalYoutubeWatchUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&list=PL123')).toBe(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    )
  })

  it('rejects a shorts URL', () => {
    expect(canonicalYoutubeWatchUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBeNull()
  })

  it('rejects a channel URL', () => {
    expect(canonicalYoutubeWatchUrl('https://www.youtube.com/@SomeChannel')).toBeNull()
  })

  it('rejects a search results URL', () => {
    expect(canonicalYoutubeWatchUrl('https://www.youtube.com/results?search_query=bun')).toBeNull()
  })

  it('rejects a playlist URL', () => {
    expect(canonicalYoutubeWatchUrl('https://www.youtube.com/playlist?list=PL123')).toBeNull()
  })

  it('rejects a bare host with no path', () => {
    expect(canonicalYoutubeWatchUrl('https://www.youtube.com/')).toBeNull()
  })

  it('rejects a non-YouTube host', () => {
    expect(canonicalYoutubeWatchUrl('https://vimeo.com/watch?v=dQw4w9WgXcQ')).toBeNull()
  })

  it('rejects a watch URL with a malformed video id', () => {
    expect(canonicalYoutubeWatchUrl('https://www.youtube.com/watch?v=a')).toBeNull()
    expect(canonicalYoutubeWatchUrl('https://www.youtube.com/watch?v=' + 'x'.repeat(30))).toBeNull()
  })

  it('rejects a youtu.be link with a malformed video id', () => {
    expect(canonicalYoutubeWatchUrl('https://youtu.be/a')).toBeNull()
  })

  it('rejects a watch URL with no v param at all', () => {
    expect(canonicalYoutubeWatchUrl('https://www.youtube.com/watch')).toBeNull()
  })

  it('returns null for an unparseable string rather than throwing', () => {
    expect(canonicalYoutubeWatchUrl('not a url')).toBeNull()
  })

  // A non-web scheme is not a video URL and must not be rewritten into one. Note this is
  // tidiness, not a grounding fix: ledger.normalizeUrl excludes the scheme, so an http form
  // already shares a ledger key with the https URL the chain actually dials.
  it('rejects a non-http(s) scheme', () => {
    expect(canonicalYoutubeWatchUrl('ftp://youtube.com/watch?v=dQw4w9WgXcQ')).toBeNull()
    expect(canonicalYoutubeWatchUrl('file://youtu.be/dQw4w9WgXcQ')).toBeNull()
  })

  it('still accepts plain http, which normalizeUrl treats as the same page', () => {
    expect(canonicalYoutubeWatchUrl('http://youtube.com/watch?v=dQw4w9WgXcQ')).toBe(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    )
  })
})

describe('parseDurationSeconds', () => {
  it('parses H:MM:SS', () => {
    expect(parseDurationSeconds('1:48:20')).toBe(6500)
  })

  it('parses M:SS', () => {
    expect(parseDurationSeconds('2:46')).toBe(166)
  })

  it('returns null for null input', () => {
    expect(parseDurationSeconds(null)).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseDurationSeconds('')).toBeNull()
  })

  it('returns null for non-numeric / live-stream text', () => {
    expect(parseDurationSeconds('LIVE')).toBeNull()
    expect(parseDurationSeconds('garbage')).toBeNull()
  })
})

// Hand-written ytInitialData fixture: one entry with a `runs`-style title, one with a
// `simpleText` title and no lengthText (a livestream/premiere shape), and enough nesting to
// exercise the recursive walk rather than a flat top-level array.
const FIXTURE_DATA = {
  contents: {
    twoColumnSearchResultsRenderer: {
      primaryContents: {
        sectionListRenderer: {
          contents: [
            {
              itemSectionRenderer: {
                contents: [
                  {
                    videoRenderer: {
                      videoId: 'dQw4w9WgXcQ',
                      title: { runs: [{ text: 'A ' }, { text: 'Long Talk' }] },
                      ownerText: { runs: [{ text: 'Some Channel' }] },
                      lengthText: { simpleText: '1:48:20' },
                      publishedTimeText: { simpleText: '3 years ago' },
                      viewCountText: { simpleText: '1,234,567 views' },
                    },
                  },
                  {
                    videoRenderer: {
                      videoId: 'abcdefghijk',
                      title: { simpleText: 'A Live Premiere' },
                      ownerText: { simpleText: 'Another Channel' },
                      publishedTimeText: { simpleText: 'Streamed 2 days ago' },
                      viewCountText: { simpleText: '42 watching' },
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    },
  },
}

function fixtureHtml(data: unknown): string {
  return `<html><script>var ytInitialData = ${JSON.stringify(data)};</script></html>`
}

describe('parseYoutubeSearch', () => {
  it('extracts a runs-style title, channel, duration, published and views', () => {
    const results = parseYoutubeSearch(fixtureHtml(FIXTURE_DATA), 10)
    const first = results.find((r) => r.videoId === 'dQw4w9WgXcQ')
    expect(first).toEqual({
      videoId: 'dQw4w9WgXcQ',
      title: 'A Long Talk',
      channel: 'Some Channel',
      durationText: '1:48:20',
      durationSeconds: 6500,
      publishedText: '3 years ago',
      viewsText: '1,234,567 views',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    })
  })

  it('handles an entry with no lengthText (durationText/durationSeconds both null)', () => {
    const results = parseYoutubeSearch(fixtureHtml(FIXTURE_DATA), 10)
    const second = results.find((r) => r.videoId === 'abcdefghijk')
    expect(second?.title).toBe('A Live Premiere')
    expect(second?.durationText).toBeNull()
    expect(second?.durationSeconds).toBeNull()
  })

  it('caps results at the given limit', () => {
    expect(parseYoutubeSearch(fixtureHtml(FIXTURE_DATA), 1)).toHaveLength(1)
  })

  it('dedupes by videoId', () => {
    const duped = {
      contents: [{ videoRenderer: FIXTURE_DATA.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents[0]!.itemSectionRenderer.contents[0]!.videoRenderer }, { videoRenderer: FIXTURE_DATA.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents[0]!.itemSectionRenderer.contents[0]!.videoRenderer }],
    }
    expect(parseYoutubeSearch(fixtureHtml(duped), 10)).toHaveLength(1)
  })

  it('returns [] for malformed HTML with no ytInitialData', () => {
    expect(parseYoutubeSearch('<html><body>nothing here</body></html>', 10)).toEqual([])
  })

  it('returns [] when ytInitialData is present but not valid JSON', () => {
    expect(parseYoutubeSearch('<script>var ytInitialData = {not json};</script>', 10)).toEqual([])
  })

  // The loop pushes before it checks the limit, so a non-positive limit would otherwise
  // return one result. The tool's zod schema enforces min(1), but this is exported as
  // general-purpose pure logic.
  it('returns [] for a limit of 0 or a negative limit', () => {
    expect(parseYoutubeSearch(fixtureHtml(FIXTURE_DATA), 0)).toEqual([])
    expect(parseYoutubeSearch(fixtureHtml(FIXTURE_DATA), -1)).toEqual([])
  })
})
