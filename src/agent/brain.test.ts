import { describe, it, expect } from 'bun:test'
import {
  parseQueryTerms,
  parseFrontmatter,
  resolveTitle,
  resolveUpdatedDate,
  countTermMatches,
  scoreNote,
  buildExcerpt,
  buildNoteUrl,
  rankAndBuildNotes,
} from './brain.js'
import type { BrainCandidate } from './brain.js'

describe('parseQueryTerms', () => {
  it('lowercases, splits on non-alphanumerics, drops short terms, dedupes', () => {
    expect(parseQueryTerms('Model Routing DeepSeek, model!')).toEqual(['model', 'routing', 'deepseek'])
  })

  it('drops terms under 3 chars', () => {
    expect(parseQueryTerms('is a research gateway')).toEqual(['research', 'gateway'])
  })

  it('returns empty array for an all-short query', () => {
    expect(parseQueryTerms('a to is')).toEqual([])
  })
})

describe('parseFrontmatter', () => {
  it('extracts scalar key: value fields and strips them from the body', () => {
    const content = '---\ntitle: Model routing\ntimestamp: 2026-09-23\ntags:\n  - engineering\n---\n\n# Model routing\n\nBody text.'
    const { frontmatter, body } = parseFrontmatter(content)
    expect(frontmatter['title']).toBe('Model routing')
    expect(frontmatter['timestamp']).toBe('2026-09-23')
    expect(body).toContain('# Model routing')
    expect(body).not.toContain('title: Model routing')
  })

  it('strips quotes around quoted scalar values', () => {
    const { frontmatter } = parseFrontmatter('---\ntitle: "Quoted Title"\n---\nbody')
    expect(frontmatter['title']).toBe('Quoted Title')
  })

  it('returns the whole content as body when there is no frontmatter block', () => {
    const { frontmatter, body } = parseFrontmatter('# No frontmatter\n\nJust a note.')
    expect(frontmatter).toEqual({})
    expect(body).toBe('# No frontmatter\n\nJust a note.')
  })
})

describe('resolveTitle', () => {
  it('prefers frontmatter title', () => {
    expect(resolveTitle('wiki/a.md', { title: 'From frontmatter' }, '# From H1')).toBe('From frontmatter')
  })

  it('falls back to the first H1 when no frontmatter title', () => {
    expect(resolveTitle('wiki/a.md', {}, 'intro\n\n# The Real Title\n\nmore text')).toBe('The Real Title')
  })

  it('falls back to the filename when neither is present', () => {
    expect(resolveTitle('wiki/engineering/model-routing.md', {}, 'no heading here')).toBe('model-routing')
  })
})

describe('resolveUpdatedDate', () => {
  it('prefers updated, then modified, then timestamp', () => {
    expect(resolveUpdatedDate({ updated: 'u', modified: 'm', timestamp: 't' })).toBe('u')
    expect(resolveUpdatedDate({ modified: 'm', timestamp: 't' })).toBe('m')
    expect(resolveUpdatedDate({ timestamp: 't' })).toBe('t')
  })

  it('returns null when none of the three fields are present', () => {
    expect(resolveUpdatedDate({ title: 'x' })).toBeNull()
  })
})

describe('countTermMatches', () => {
  it('counts case-insensitive fixed-string occurrences across all terms', () => {
    expect(countTermMatches('DeepSeek runs deepseek models via deepseek routing', ['deepseek', 'routing'])).toBe(4)
  })

  it('returns 0 for no matches', () => {
    expect(countTermMatches('nothing relevant here', ['zzz'])).toBe(0)
  })
})

describe('scoreNote', () => {
  it('weights a title match far above a lone body match', () => {
    const titled = scoreNote({ title: 'Model routing', frontmatterBlock: '', body: 'unrelated text', terms: ['routing'] })
    const bodyOnly = scoreNote({ title: 'Unrelated', frontmatterBlock: '', body: 'a note about routing once', terms: ['routing'] })
    expect(titled).toBeGreaterThan(bodyOnly)
  })

  it('returns 0 when no term matches anywhere', () => {
    expect(scoreNote({ title: 'x', frontmatterBlock: 'y', body: 'z', terms: ['zzz'] })).toBe(0)
  })
})

describe('buildExcerpt', () => {
  it('windows around a match with surrounding context', () => {
    const body = `${'padding '.repeat(50)}the deepseek model is fast${' more padding'.repeat(50)}`
    const excerpt = buildExcerpt(body, ['deepseek'])
    expect(excerpt).toContain('deepseek')
    expect(excerpt.length).toBeLessThan(body.length)
  })

  it('merges overlapping windows from nearby matches instead of duplicating them', () => {
    const body = 'the deepseek model uses deepseek routing for deepseek work'
    const excerpt = buildExcerpt(body, ['deepseek'])
    expect(excerpt.split('…').length).toBeLessThanOrEqual(2) // windows overlap and merge into one
  })

  it('falls back to the opening chars when there are no matches', () => {
    expect(buildExcerpt('no relevant terms here', ['zzz'])).toBe('no relevant terms here')
  })

  it('never exceeds the per-note cap even with many scattered matches', () => {
    const body = Array.from({ length: 200 }, (_, i) => `paragraph ${i} mentions deepseek here.`).join(' ')
    const excerpt = buildExcerpt(body, ['deepseek'])
    expect(excerpt.length).toBeLessThanOrEqual(1_500)
  })
})

describe('buildNoteUrl', () => {
  it('joins the base url with the per-segment-encoded slug, dropping the .md extension', () => {
    expect(buildNoteUrl('https://brain.mini.jkrumm.com', 'wiki/engineering/model-routing.md')).toBe(
      'https://brain.mini.jkrumm.com/wiki/engineering/model-routing',
    )
  })

  it('percent-encodes segments with spaces', () => {
    expect(buildNoteUrl('https://brain.mini.jkrumm.com', 'wiki/Areas/Some Note.md')).toBe(
      'https://brain.mini.jkrumm.com/wiki/Areas/Some%20Note',
    )
  })

  it('strips a trailing slash on the base url', () => {
    expect(buildNoteUrl('https://brain.mini.jkrumm.com/', 'wiki/a.md')).toBe('https://brain.mini.jkrumm.com/wiki/a')
  })

  it('returns null when no base url is configured', () => {
    expect(buildNoteUrl(undefined, 'wiki/a.md')).toBeNull()
  })
})

describe('rankAndBuildNotes', () => {
  const baseUrl = 'https://brain.mini.jkrumm.com'

  function note(relPath: string, content: string): BrainCandidate {
    return { relPath, content }
  }

  it('ranks a title match above a body-only match', () => {
    const candidates = [
      note('wiki/a.md', '---\ntitle: Unrelated\n---\n\nmentions model routing once in passing'),
      note('wiki/b.md', '---\ntitle: Model routing\n---\n\n# Model routing\n\nthe full story of model routing'),
    ]
    const results = rankAndBuildNotes({ candidates, terms: ['model', 'routing'], baseUrl })
    expect(results[0]?.title).toBe('Model routing')
  })

  it('drops candidates that score 0', () => {
    const candidates = [note('wiki/a.md', '---\ntitle: Nothing relevant\n---\n\nunrelated content')]
    const results = rankAndBuildNotes({ candidates, terms: ['deepseek'], baseUrl })
    expect(results).toEqual([])
  })

  it('caps results at maxResults', () => {
    const candidates = Array.from({ length: 10 }, (_, i) => note(`wiki/n${i}.md`, `---\ntitle: deepseek note ${i}\n---\n\ndeepseek`))
    const results = rankAndBuildNotes({ candidates, terms: ['deepseek'], baseUrl, maxResults: 3 })
    expect(results.length).toBe(3)
  })

  it('produces no results (not a crash) when baseUrl is unset', () => {
    const candidates = [note('wiki/a.md', '---\ntitle: deepseek\n---\n\ndeepseek')]
    const results = rankAndBuildNotes({ candidates, terms: ['deepseek'], baseUrl: undefined })
    expect(results).toEqual([])
  })

  it('bounds the combined excerpt budget across all returned notes', () => {
    const long = Array.from({ length: 300 }, (_, i) => `paragraph ${i} deepseek content here.`).join(' ')
    const candidates = Array.from({ length: 5 }, (_, i) => note(`wiki/n${i}.md`, `---\ntitle: deepseek ${i}\n---\n\n${long}`))
    const results = rankAndBuildNotes({ candidates, terms: ['deepseek'], baseUrl })
    const total = results.reduce((sum, r) => sum + r.excerpt.length, 0)
    expect(total).toBeLessThanOrEqual(6_000)
  })

  it('carries the resolved updated date through', () => {
    const candidates = [note('wiki/a.md', '---\ntitle: deepseek\ntimestamp: 2026-09-23\n---\n\ndeepseek')]
    const results = rankAndBuildNotes({ candidates, terms: ['deepseek'], baseUrl })
    expect(results[0]?.updated).toBe('2026-09-23')
  })
})
