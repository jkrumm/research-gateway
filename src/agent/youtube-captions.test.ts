import { describe, it, expect } from 'bun:test'
import { pickCaptionTrack, parseJson3, buildTranscriptText, type YtdlpInfo } from './youtube-captions.js'

describe('pickCaptionTrack', () => {
  it('picks manual over auto in the same language', () => {
    const info: YtdlpInfo = {
      language: 'en',
      subtitles: { en: [{ ext: 'json3', url: 'https://manual.example/en.json3' }] },
      automatic_captions: { en: [{ ext: 'json3', url: 'https://auto.example/en.json3' }] },
    }
    expect(pickCaptionTrack(info)).toEqual({ source: 'manual', code: 'en', url: 'https://manual.example/en.json3' })
  })

  it('falls back to auto when no manual track exists', () => {
    const info: YtdlpInfo = {
      language: 'en',
      subtitles: null,
      automatic_captions: { en: [{ ext: 'json3', url: 'https://auto.example/en.json3' }] },
    }
    expect(pickCaptionTrack(info)).toEqual({ source: 'auto', code: 'en', url: 'https://auto.example/en.json3' })
  })

  it('accepts the `<lang>-orig` code variant', () => {
    const info: YtdlpInfo = {
      language: 'de',
      subtitles: { 'de-orig': [{ ext: 'json3', url: 'https://manual.example/de-orig.json3' }] },
    }
    expect(pickCaptionTrack(info)).toEqual({ source: 'manual', code: 'de-orig', url: 'https://manual.example/de-orig.json3' })
  })

  it('accepts the `<lang>-<lang>` code variant', () => {
    const info: YtdlpInfo = {
      language: 'de',
      subtitles: { 'de-de': [{ ext: 'json3', url: 'https://manual.example/de-de.json3' }] },
    }
    expect(pickCaptionTrack(info)).toEqual({ source: 'manual', code: 'de-de', url: 'https://manual.example/de-de.json3' })
  })

  it('prefers the plain `<lang>` code over `-orig`/`-<lang>` variants', () => {
    const info: YtdlpInfo = {
      language: 'de',
      subtitles: {
        de: [{ ext: 'json3', url: 'https://manual.example/de.json3' }],
        'de-orig': [{ ext: 'json3', url: 'https://manual.example/de-orig.json3' }],
      },
    }
    expect(pickCaptionTrack(info)?.url).toBe('https://manual.example/de.json3')
  })

  it("falls back to English when the video's own language has no track at all", () => {
    const info: YtdlpInfo = {
      language: 'fr',
      subtitles: { en: [{ ext: 'json3', url: 'https://manual.example/en.json3' }] },
      automatic_captions: null,
    }
    expect(pickCaptionTrack(info)).toEqual({ source: 'manual', code: 'en', url: 'https://manual.example/en.json3' })
  })

  it('falls back to auto-English as the last resort', () => {
    const info: YtdlpInfo = {
      language: 'fr',
      subtitles: null,
      automatic_captions: { en: [{ ext: 'json3', url: 'https://auto.example/en.json3' }] },
    }
    expect(pickCaptionTrack(info)).toEqual({ source: 'auto', code: 'en', url: 'https://auto.example/en.json3' })
  })

  it('defaults to English when `language` is absent', () => {
    const info: YtdlpInfo = {
      subtitles: { en: [{ ext: 'json3', url: 'https://manual.example/en.json3' }] },
    }
    expect(pickCaptionTrack(info)?.code).toBe('en')
  })

  it('splits a region-tagged language code down to its base', () => {
    const info: YtdlpInfo = {
      language: 'en-US',
      subtitles: { en: [{ ext: 'json3', url: 'https://manual.example/en.json3' }] },
    }
    expect(pickCaptionTrack(info)?.code).toBe('en')
  })

  it('ignores non-json3 formats entirely', () => {
    const info: YtdlpInfo = {
      language: 'en',
      subtitles: { en: [{ ext: 'vtt', url: 'https://manual.example/en.vtt' }] },
      automatic_captions: { en: [{ ext: 'srv3', url: 'https://auto.example/en.srv3' }] },
    }
    expect(pickCaptionTrack(info)).toBeNull()
  })

  it('returns null when both tables are missing', () => {
    expect(pickCaptionTrack({ language: 'en', subtitles: null, automatic_captions: null })).toBeNull()
  })

  it('returns null when both tables are empty objects', () => {
    expect(pickCaptionTrack({ language: 'en', subtitles: {}, automatic_captions: {} })).toBeNull()
  })

  it('skips a format entry with a missing url', () => {
    const info: YtdlpInfo = {
      language: 'en',
      subtitles: { en: [{ ext: 'json3' }] },
    }
    expect(pickCaptionTrack(info)).toBeNull()
  })
})

describe('parseJson3', () => {
  it('joins segs across events and collapses whitespace', () => {
    const body = JSON.stringify({
      events: [
        { segs: [{ utf8: 'Hello' }, { utf8: ' world.' }] },
        { segs: [{ utf8: '\n' }] },
        { segs: [{ utf8: 'Second   sentence.' }] },
      ],
    })
    expect(parseJson3(body)).toBe('Hello world. Second sentence.')
  })

  it('skips null/undefined segs without throwing', () => {
    const body = JSON.stringify({
      events: [{ segs: [{ utf8: 'A' }, null, { utf8: 'B' }] }, { segs: undefined }, {}],
    })
    expect(parseJson3(body)).toBe('AB')
  })

  it('returns empty string for malformed JSON', () => {
    expect(parseJson3('{not json')).toBe('')
  })

  it('returns empty string when events is missing', () => {
    expect(parseJson3(JSON.stringify({ foo: 'bar' }))).toBe('')
  })

  it('parses a real-shaped json3 fixture into the expected text', () => {
    const fixture = JSON.stringify({
      wireMagic: 'pb3',
      events: [
        { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: '- Today, we are' }] },
        { tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: ' finally gonna' }] },
        { tStartMs: 2000, dDurationMs: 1000, segs: [{ utf8: ' bring everyone up to speed.' }] },
      ],
    })
    expect(parseJson3(fixture)).toBe('- Today, we are finally gonna bring everyone up to speed.')
  })
})

describe('buildTranscriptText', () => {
  it('renders title, metadata line and transcript', () => {
    const text = buildTranscriptText({
      title: 'A Long Talk',
      uploader: 'Some Channel',
      durationSec: 6500,
      lang: 'en',
      source: 'manual',
      transcript: 'The full talk text.',
    })
    expect(text).toContain('# A Long Talk')
    expect(text).toContain('Some Channel')
    expect(text).toContain('1:48:20')
    expect(text).toContain('The full talk text.')
  })

  it('states explicitly when captions are auto-generated', () => {
    const text = buildTranscriptText({
      title: 'A Talk',
      uploader: 'A Channel',
      durationSec: 166,
      lang: 'de',
      source: 'auto',
      transcript: 'unpunctuated machine text',
    })
    expect(text.toLowerCase()).toContain('auto-generated')
  })

  it('does not mention auto-generation for manual captions', () => {
    const text = buildTranscriptText({
      title: 'A Talk',
      uploader: 'A Channel',
      durationSec: 166,
      lang: 'en',
      source: 'manual',
      transcript: 'punctuated text.',
    })
    expect(text.toLowerCase()).not.toContain('auto-generated')
  })

  it('handles null title/uploader/duration without throwing', () => {
    const text = buildTranscriptText({
      title: null,
      uploader: null,
      durationSec: null,
      lang: 'en',
      source: 'manual',
      transcript: 'text',
    })
    expect(text).toContain('Untitled video')
    expect(text).toContain('unknown')
  })
})
