import { describe, it, expect } from 'bun:test'
import {
  parseQueryTerms,
  isNearDuplicateQuery,
  parseFrontmatter,
  resolveTitle,
  resolveUpdatedDate,
  countTermMatches,
  computeIdf,
  selectInformativeTerms,
  scoreNote,
  isStrongMatch,
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

  it('drops stopwords like the rephrasing filler that derailed the brain tool', () => {
    expect(parseQueryTerms('gpt-6-luna reverted after one day')).toEqual(['gpt', 'luna', 'reverted', 'after'])
  })

  it('drops "my own" and "today" from a first-person query', () => {
    expect(parseQueryTerms('in my own setup today')).toEqual([])
  })
})

describe('isNearDuplicateQuery', () => {
  it('treats a superset rephrase as a near-duplicate', () => {
    expect(isNearDuplicateQuery(['gpt', 'luna'], ['gpt', 'luna', 'reverted'])).toBe(true)
    expect(isNearDuplicateQuery(['gpt', 'luna', 'reverted'], ['gpt', 'luna'])).toBe(true)
  })

  it('treats heavy term overlap as a near-duplicate even without a strict subset', () => {
    expect(
      isNearDuplicateQuery(
        ['research', 'gateway', 'lead', 'worker', 'model'],
        ['research', 'gateway', 'orchestrator', 'worker', 'model'],
      ),
    ).toBe(true)
  })

  it('is false for genuinely different queries', () => {
    expect(isNearDuplicateQuery(['deepseek', 'pricing'], ['lightpanda', 'sidecar'])).toBe(false)
  })

  it('is false when either side is empty', () => {
    expect(isNearDuplicateQuery([], ['deepseek'])).toBe(false)
    expect(isNearDuplicateQuery(['deepseek'], [])).toBe(false)
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

describe('computeIdf', () => {
  function note(relPath: string, content: string): BrainCandidate {
    return { relPath, content }
  }

  it('scores a term present in every candidate at exactly 0', () => {
    const candidates = [note('a.md', 'research gateway'), note('b.md', 'research gateway model')]
    const idf = computeIdf({ candidates, terms: ['research'] })
    expect(idf.get('research')).toBe(0)
  })

  it('scores a term present in only one of many candidates well above 0', () => {
    const candidates = [
      note('a.md', 'deepseek pricing'),
      note('b.md', 'unrelated one'),
      note('c.md', 'unrelated two'),
      note('d.md', 'unrelated three'),
    ]
    const idf = computeIdf({ candidates, terms: ['deepseek'] })
    expect(idf.get('deepseek')).toBeGreaterThan(1)
  })

  it('never produces Infinity/NaN for an empty candidate set', () => {
    const idf = computeIdf({ candidates: [], terms: ['deepseek'] })
    expect(idf.get('deepseek')).toBe(0)
  })
})

describe('selectInformativeTerms', () => {
  it('drops a term whose IDF is at or below the corpus-noise floor', () => {
    const idf = new Map([
      ['research', 0], // in every candidate
      ['deepseek', 2], // in a small minority
    ])
    expect(selectInformativeTerms(['research', 'deepseek'], idf)).toEqual(['deepseek'])
  })

  it('drops an unscored term (missing from the idf map) as uninformative', () => {
    expect(selectInformativeTerms(['ghost'], new Map())).toEqual([])
  })
})

describe('scoreNote', () => {
  it('weights a title match far above a lone body match', () => {
    const idf = new Map([['routing', 1]])
    const titled = scoreNote({ title: 'Model routing', frontmatterBlock: '', body: 'unrelated text', terms: ['routing'], idf })
    const bodyOnly = scoreNote({
      title: 'Unrelated',
      frontmatterBlock: '',
      body: 'a note about routing once',
      terms: ['routing'],
      idf,
    })
    expect(titled).toBeGreaterThan(bodyOnly)
  })

  it('returns 0 when no term matches anywhere', () => {
    const idf = new Map([['zzz', 1]])
    expect(scoreNote({ title: 'x', frontmatterBlock: 'y', body: 'z', terms: ['zzz'], idf })).toBe(0)
  })

  it('returns 0 for a term with 0 (or no) idf weight even if it textually matches', () => {
    const idf = new Map([['research', 0]])
    expect(scoreNote({ title: 'research', frontmatterBlock: '', body: 'research research', terms: ['research'], idf })).toBe(0)
  })
})

describe('isStrongMatch', () => {
  it('is false with no informative terms at all', () => {
    expect(isStrongMatch({ title: 'x', frontmatterBlock: '', body: 'y', informativeTerms: [] })).toBe(false)
  })

  it('is false for a single passing one-word body mention (the false-positive this replaces)', () => {
    // One of two informative terms hit once in the body: 50% coverage, under the 60% bar.
    expect(
      isStrongMatch({
        title: 'Unrelated note',
        frontmatterBlock: '',
        body: 'a note that mentions luna once in passing',
        informativeTerms: ['luna', 'reverted'],
      }),
    ).toBe(false)
  })

  it('is true when the title carries at least one informative term and coverage clears the bar', () => {
    expect(
      isStrongMatch({
        title: 'gpt-6-luna reverted',
        frontmatterBlock: '',
        body: 'the model was reverted after one day',
        informativeTerms: ['luna', 'reverted'],
      }),
    ).toBe(true)
  })

  it('is true with 2+ distinct informative body hits even with no title/frontmatter hit', () => {
    expect(
      isStrongMatch({
        title: 'Unrelated title',
        frontmatterBlock: '',
        body: 'gpt-6-luna was reverted the next day after launch',
        informativeTerms: ['luna', 'reverted'],
      }),
    ).toBe(true)
  })

  it('is false for a single informative term repeated only in the body, never in title/frontmatter', () => {
    // 100% coverage (the one term matches), but neither gate passes: it's not in the
    // title/frontmatter, and a single distinct term can never reach the "2+ distinct body
    // hits" bar on its own — a single-term query needs a title/frontmatter hit to qualify.
    expect(
      isStrongMatch({
        title: 'Unrelated title',
        frontmatterBlock: '',
        body: 'luna luna luna appears many times but nothing else does',
        informativeTerms: ['luna'],
      }),
    ).toBe(false)
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

  // Distractors that share none of the query terms — realistic corpus shape (the query terms
  // are a minority of the candidate set), which is what makes IDF weighting meaningful at all.
  // A 1-2 candidate corpus where every candidate contains every term collapses every term's IDF
  // to 0 by construction, which is correct behaviour, not a test artifact — so these tests give
  // the ranking room to actually discriminate, same as the real ~200-note vault does.
  function distractors(count: number, prefix = 'distractor'): BrainCandidate[] {
    return Array.from({ length: count }, (_, i) => note(`wiki/${prefix}-${i}.md`, `---\ntitle: Distractor ${i}\n---\n\nunrelated content here`))
  }

  it('ranks a title match above a body-only match', () => {
    const candidates = [
      note('wiki/a.md', '---\ntitle: Unrelated\n---\n\nmentions model routing once in passing'),
      note('wiki/b.md', '---\ntitle: Model routing\n---\n\n# Model routing\n\nthe full story of model routing'),
      ...distractors(4),
    ]
    const results = rankAndBuildNotes({ candidates, terms: ['model', 'routing'], baseUrl })
    expect(results[0]?.title).toBe('Model routing')
  })

  it('drops candidates that never clear the strong-match bar', () => {
    const candidates = [note('wiki/a.md', '---\ntitle: Nothing relevant\n---\n\nunrelated content'), ...distractors(3)]
    const results = rankAndBuildNotes({ candidates, terms: ['deepseek'], baseUrl })
    expect(results).toEqual([])
  })

  it('drops a note that only weakly, passingly mentions the topic once', () => {
    // The exact false-positive rankAndBuildNotes now exists to prevent: "one" informative term
    // out of two, matched once in the body — under the 60% coverage bar.
    const candidates = [
      note('wiki/a.md', '---\ntitle: Unrelated topic\n---\n\na note that mentions luna once in passing'),
      note('wiki/b.md', '---\ntitle: gpt-6-luna reverted\n---\n\nthe model was reverted after one day'),
      ...distractors(4),
    ]
    const results = rankAndBuildNotes({ candidates, terms: ['luna', 'reverted'], baseUrl })
    expect(results.map((r) => r.title)).toEqual(['gpt-6-luna reverted'])
  })

  it('returns empty when no note clears the strong-match bar for a query with no answer in the vault', () => {
    const candidates = [
      note('wiki/a.md', '---\ntitle: Model routing\n---\n\nresearch-gateway runs deepseek for both lead and worker roles'),
      ...distractors(5),
    ]
    // "gpt-6-luna reverted" — the exact query from the live incident this fixes, against a
    // vault that genuinely has no note about it.
    const results = rankAndBuildNotes({ candidates, terms: ['gpt', 'luna', 'reverted'], baseUrl })
    expect(results).toEqual([])
  })

  it('caps results at maxResults', () => {
    const relevant = Array.from({ length: 10 }, (_, i) => note(`wiki/n${i}.md`, `---\ntitle: deepseek note ${i}\n---\n\ndeepseek deepseek`))
    const candidates = [...relevant, ...distractors(15)]
    const results = rankAndBuildNotes({ candidates, terms: ['deepseek'], baseUrl, maxResults: 3 })
    expect(results.length).toBe(3)
  })

  it('produces no results (not a crash) when baseUrl is unset', () => {
    const candidates = [note('wiki/a.md', '---\ntitle: deepseek\n---\n\ndeepseek'), ...distractors(5)]
    const results = rankAndBuildNotes({ candidates, terms: ['deepseek'], baseUrl: undefined })
    expect(results).toEqual([])
  })

  it('bounds the combined excerpt budget across all returned notes', () => {
    const long = Array.from({ length: 300 }, (_, i) => `paragraph ${i} deepseek content here.`).join(' ')
    const relevant = Array.from({ length: 5 }, (_, i) => note(`wiki/n${i}.md`, `---\ntitle: deepseek ${i}\n---\n\n${long}`))
    const candidates = [...relevant, ...distractors(6)]
    const results = rankAndBuildNotes({ candidates, terms: ['deepseek'], baseUrl })
    const total = results.reduce((sum, r) => sum + r.excerpt.length, 0)
    expect(total).toBeLessThanOrEqual(6_000)
  })

  it('carries the resolved updated date through', () => {
    const candidates = [note('wiki/a.md', '---\ntitle: deepseek\ntimestamp: 2026-09-23\n---\n\ndeepseek'), ...distractors(5)]
    const results = rankAndBuildNotes({ candidates, terms: ['deepseek'], baseUrl })
    expect(results[0]?.updated).toBe('2026-09-23')
  })
})
