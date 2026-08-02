import { describe, it, expect } from 'bun:test'
// Imported from `sonar-parse.ts`, NOT `sonar.ts` — the latter imports `env.ts`, which
// parses `process.env` at import time and throws without secrets. Splitting the mapper out
// is what makes it testable at all (same convention as `cost.ts` vs `usage.ts`). The
// fixtures below are trimmed from real captures of the IU endpoint, not invented: the null
// `date` beside a populated `last_updated`, and the empty snippet, are both things it
// actually returns.
import { parseSonarResponse } from './sonar-parse.js'

const response = (results: unknown[], usage?: unknown) => ({
  choices: [{ message: { role: 'assistant', content: 'discarded' } }],
  citations: [],
  search_results: results,
  usage: usage ?? {
    prompt_tokens: 17,
    completion_tokens: 16,
    cost: { input_tokens_cost: 0.00002, output_tokens_cost: 0.00004, request_cost: 0.005, total_cost: 0.00502 },
  },
})

const hit = (over: Record<string, unknown> = {}) => ({
  title: 'Bun — A fast all-in-one JavaScript runtime',
  url: 'https://bun.com/',
  snippet: 'Install Bun v1.3.14',
  date: null,
  last_updated: '2026-08-01',
  source: 'web',
  place_metadata: null,
  ...over,
})

describe('parseSonarResponse', () => {
  it('maps results and falls back from a null `date` to `last_updated`', () => {
    const { results } = parseSonarResponse(response([hit()]), 20)
    expect(results).toEqual([
      {
        title: 'Bun — A fast all-in-one JavaScript runtime',
        url: 'https://bun.com/',
        snippet: 'Install Bun v1.3.14',
        published: '2026-08-01',
      },
    ])
  })

  it('prefers `date` over `last_updated` when both are present', () => {
    const { results } = parseSonarResponse(
      response([hit({ date: '2026-07-08', last_updated: '2026-07-24' })]),
      20,
    )
    expect(results[0]!.published).toBe('2026-07-08')
  })

  it('reports published: null when neither date field is present', () => {
    const { results } = parseSonarResponse(response([hit({ date: null, last_updated: null })]), 20)
    expect(results[0]!.published).toBeNull()
  })

  it('drops duplicate URLs, keeping the first (Perplexity returns them ranked)', () => {
    const { results } = parseSonarResponse(
      response([hit({ snippet: 'first' }), hit({ snippet: 'second' }), hit({ url: 'https://other.dev/' })]),
      20,
    )
    expect(results.map((r) => r.url)).toEqual(['https://bun.com/', 'https://other.dev/'])
    expect(results[0]!.snippet).toBe('first')
  })

  it('trims to maxResults — the fan-out dial that keeps a standard job from fetching 35 pages', () => {
    const many = Array.from({ length: 20 }, (_, i) => hit({ url: `https://example.com/${i}` }))
    expect(parseSonarResponse(response(many), 8).results).toHaveLength(8)
    expect(parseSonarResponse(response(many), 20).results).toHaveLength(20)
  })

  it('counts dedup against maxResults only for what it keeps', () => {
    // Two duplicates then three distinct: a cap of 3 must yield 3 distinct hits, not 3
    // slots two of which were burned by the duplicate.
    const results = parseSonarResponse(
      response([
        hit({ url: 'https://a.dev/' }),
        hit({ url: 'https://a.dev/' }),
        hit({ url: 'https://b.dev/' }),
        hit({ url: 'https://c.dev/' }),
        hit({ url: 'https://d.dev/' }),
      ]),
      3,
    ).results
    expect(results.map((r) => r.url)).toEqual(['https://a.dev/', 'https://b.dev/', 'https://c.dev/'])
  })

  it('bills the whole response, not the kept slice — trimming is a context decision', () => {
    const many = Array.from({ length: 20 }, (_, i) => hit({ url: `https://example.com/${i}` }))
    const trimmed = parseSonarResponse(response(many), 5)
    const full = parseSonarResponse(response(many), 20)
    expect(trimmed.usage.costUsd).toBe(full.usage.costUsd)
    expect(trimmed.usage.costUsd).toBe(0.00502)
  })

  it('tolerates a missing snippet and a missing title without dropping the URL', () => {
    const { results } = parseSonarResponse(
      response([{ url: 'https://sparse.dev/', date: null, last_updated: null }]),
      20,
    )
    expect(results[0]).toEqual({ title: '', url: 'https://sparse.dev/', snippet: '', published: null })
  })

  it('defaults searchQueries to 1 — plain `sonar` omits num_search_queries, one call is one search', () => {
    const { usage } = parseSonarResponse(response([hit()]), 20)
    expect(usage.searchQueries).toBe(1)
  })

  it('carries num_search_queries through when the model reports it (sonar-deep-research)', () => {
    const { usage } = parseSonarResponse(
      response([hit()], { prompt_tokens: 47, completion_tokens: 14335, num_search_queries: 29, cost: { total_cost: 0.39283 } }),
      20,
    )
    expect(usage.searchQueries).toBe(29)
    expect(usage.costUsd).toBe(0.39283)
  })

  it('reports zeroed usage rather than throwing when the cost block is absent', () => {
    const { usage } = parseSonarResponse({ search_results: [hit()] }, 20)
    expect(usage).toEqual({ costUsd: 0, inputTokens: 0, outputTokens: 0, searchQueries: 1 })
  })

  it('THROWS on an empty result set — the signature of the passthrough being normalized away', () => {
    // A gateway that strips `search_results` returns HTTP 200 with a perfectly valid
    // answer and no sources. Returning `[]` here would read to the worker as "the web has
    // nothing"; throwing is what hands the query to the Tavily fallback instead.
    expect(() => parseSonarResponse(response([]), 20)).toThrow('no search_results')
    expect(() => parseSonarResponse({ choices: [], usage: {} }, 20)).toThrow('no search_results')
  })

  it('throws on a response whose search_results is not an array', () => {
    expect(() => parseSonarResponse({ search_results: 'nope' }, 20)).toThrow()
  })
})
