import { describe, it, expect } from 'bun:test'
import { canonicalYoutubeWatchUrl, parseDurationSeconds } from './youtube.js'

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
