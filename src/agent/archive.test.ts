import { describe, it, expect } from 'bun:test'
import { waybackLookupUrl, isArchiveUrl, parseSnapshotDate, archiveBanner } from './archive.js'

describe('waybackLookupUrl', () => {
  it('builds the partial-timestamp lookup form that redirects to the nearest snapshot', () => {
    expect(waybackLookupUrl('https://example.com/a')).toBe('https://web.archive.org/web/9999/https://example.com/a')
  })
})

describe('isArchiveUrl', () => {
  it('is true for web.archive.org and archive.org', () => {
    expect(isArchiveUrl('https://web.archive.org/web/9999/https://example.com')).toBe(true)
    expect(isArchiveUrl('https://archive.org/details/x')).toBe(true)
  })

  it('is true case-insensitively and for subdomains', () => {
    expect(isArchiveUrl('https://WEB.ARCHIVE.ORG/web/9999/x')).toBe(true)
    expect(isArchiveUrl('https://sub.web.archive.org/x')).toBe(true)
    expect(isArchiveUrl('https://foo.archive.org/x')).toBe(true)
  })

  it('is false for unrelated hosts, including near-misses', () => {
    expect(isArchiveUrl('https://example.com/a')).toBe(false)
    expect(isArchiveUrl('https://notarchive.org/x')).toBe(false)
    expect(isArchiveUrl('https://archive.org.evil.com/x')).toBe(false)
  })

  it('is false for unparseable input rather than throwing', () => {
    expect(isArchiveUrl('not a url')).toBe(false)
  })
})

describe('parseSnapshotDate', () => {
  it('parses an RFC-1123 Memento-Datetime header', () => {
    expect(parseSnapshotDate({ memento: 'Sat, 08 Apr 2023 16:25:19 GMT' })).toBe('2023-04-08')
  })

  it('falls back to a 14-digit timestamp in the Content-Location path when there is no Memento-Datetime', () => {
    expect(
      parseSnapshotDate({
        memento: null,
        contentLocation: '/web/20230408162519/https://www.dpreview.com/forums/thread/4455495',
      }),
    ).toBe('2023-04-08')
  })

  it('prefers Memento-Datetime over the path fallback when both are present', () => {
    expect(
      parseSnapshotDate({
        memento: 'Sat, 08 Apr 2023 16:25:19 GMT',
        contentLocation: '/web/20240101000000/https://example.com',
      }),
    ).toBe('2023-04-08')
  })

  it('returns null when neither header parses', () => {
    expect(parseSnapshotDate({})).toBeNull()
    expect(parseSnapshotDate({ memento: 'not a date', contentLocation: '/web/notadate/x' })).toBeNull()
  })
})

describe('archiveBanner', () => {
  it('includes the original url and the snapshot date, plus a blank line', () => {
    const banner = archiveBanner('https://www.dpreview.com/forums/threads/x.4455495', '2023-04-08')
    expect(banner).toBe(
      '[Archived snapshot of https://www.dpreview.com/forums/threads/x.4455495 taken 2023-04-08 via the Wayback Machine — this is not the live page and may be out of date.]\n\n',
    )
  })

  it('says "date unknown" rather than omitting the banner when there is no date', () => {
    const banner = archiveBanner('https://example.com/a', null)
    expect(banner).toContain('date unknown')
    expect(banner).toContain('https://example.com/a')
  })
})
