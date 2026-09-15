import { describe, expect, it } from 'bun:test'
import type { ResearchReport } from './schema.js'

// `routes/mcp.ts` transitively imports `env.ts`, which validates required vars at load. Set
// placeholders BEFORE the dynamic import so this test never depends on real secrets.
process.env['API_SECRET'] ||= 'test-secret'
process.env['IU_BASE_URL'] ||= 'https://example.invalid/v1'
process.env['IU_API_KEY'] ||= 'test-key'
process.env['TAVILY_API_KEY'] ||= 'test-tavily'
const { reportText } = await import('../routes/mcp.js')

// The text-only MCP surface: a client that ignores structuredContent sees ONLY this string, so
// every model-controlled field interpolated here has to be markdown-safe. These tests pin the
// two risks — a field opening its own line/block, and a field rendering as live markdown.
// A minimal but COMPLETE ResearchReport — `reportText` only reads report/citations/sources/
// unverified, but the type is the full output shape, so the fixture must satisfy it.
const base: ResearchReport = {
  report: '# Findings\n\nSomething.',
  citations: [],
  sources: [],
  unverified: [],
  status: 'ok',
  warnings: [],
  grounding: {
    pagesRetrieved: 0,
    pagesFailed: 0,
    citationsKept: 0,
    citationsDropped: 0,
    confidenceCapped: 0,
  },
  cost: {
    wallMs: 0,
    totalUsd: 0,
    llmUsd: 0,
    searchUsd: 0,
    searchCalls: 0,
    tavilyCredits: 0,
    tavilyExtractCalls: 0,
  },
}

describe('reportText markdown safety', () => {
  it('keeps a hostile reason on one line and out of link syntax', () => {
    const text = reportText({
      ...base,
      unverified: [
        {
          topic: 't',
          url: 'https://nunu.gg/x',
          reason: 'rendered empty\n\n## Verified\n\n[bait](https://evil.example/steal)',
        },
      ],
    })
    // No injected heading: the hostile text must not begin a line.
    expect(text.split('\n').some((l) => l.trimStart().startsWith('## Verified'))).toBe(false)
    // No live link.
    expect(text).not.toContain('[bait](https://evil.example/steal)')
    // And the entry is still rendered, so nothing was silently dropped.
    expect(text).toContain('Unverified')
  })

  it('keeps a hostile citation claim and url on one line', () => {
    const text = reportText({
      ...base,
      citations: [
        {
          claim: 'ok\n\n## Verified',
          url: 'https://evil.example/x',
          confidence: 'high',
        },
      ],
    })
    expect(text.split('\n').some((l) => l.trimStart().startsWith('## Verified'))).toBe(false)
    expect(text).toContain('Citations')
  })

  it('keeps a hostile source line on one line', () => {
    const text = reportText({ ...base, sources: ['https://a.example\n\n## Verified'] })
    expect(text.split('\n').some((l) => l.trimStart().startsWith('## Verified'))).toBe(false)
  })

  it('renders an ordinary report unchanged in structure', () => {
    const text = reportText({
      ...base,
      report: '# Findings\n\nClaim.',
      citations: [{ claim: 'The rate rose', url: 'https://good.example/x', confidence: 'high' }],
      sources: ['https://good.example/x'],
      unverified: [{ topic: 'patch notes', url: 'https://nunu.gg/patch-notes', reason: 'empty page' }],
    })
    expect(text).toContain('## Citations')
    expect(text).toContain('## Unverified')
    expect(text).toContain('## Sources read')
    expect(text).toContain('The rate rose')
  })
})
