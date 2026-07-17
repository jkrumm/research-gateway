import { describe, it, expect } from 'bun:test'
// Imported from `assemble.ts` directly, NOT `run.ts` — `run.ts` re-exports these for
// compatibility but its own import graph (worker.ts/synthesize.ts/plan.ts -> llm.ts)
// pulls in `env.ts`, which parses `process.env` at import time and throws without secrets.
// `assemble.ts` has no such chain, so these pure helpers are testable with zero env vars.
import { assembleReport, nextRoundQuestions } from './assemble.js'
import type { WorkerDigest } from './schema.js'

function digest(overrides: Partial<WorkerDigest> = {}): WorkerDigest {
  return {
    subQuestion: 'What is X?',
    summary: 'X is Y.',
    findings: [],
    sourcesRead: [],
    openGaps: [],
    ...overrides,
  }
}

describe('assembleReport', () => {
  it('is total: empty input returns empty strings/arrays without throwing', () => {
    const report = assembleReport([])
    expect(report.report).toBe('')
    expect(report.citations).toEqual([])
    expect(report.sources).toEqual([])
  })

  it('builds a "## subQuestion\\n\\nsummary" section per digest, joined by a blank line', () => {
    const report = assembleReport([
      digest({ subQuestion: 'Q1', summary: 'A1' }),
      digest({ subQuestion: 'Q2', summary: 'A2' }),
    ])
    expect(report.report).toBe('## Q1\n\nA1\n\n## Q2\n\nA2')
  })

  it('flattens every digest finding into a { claim, url } citation', () => {
    const report = assembleReport([
      digest({
        findings: [
          { claim: 'A', url: 'https://a.example', confidence: 'high' },
          { claim: 'B', url: 'https://b.example', confidence: 'medium' },
        ],
      }),
      digest({ findings: [{ claim: 'C', url: 'https://c.example', confidence: 'low' }] }),
    ])
    expect(report.citations).toEqual([
      { claim: 'A', url: 'https://a.example' },
      { claim: 'B', url: 'https://b.example' },
      { claim: 'C', url: 'https://c.example' },
    ])
  })

  it('dedupes sourcesRead across digests into a single union', () => {
    const report = assembleReport([
      digest({ sourcesRead: ['https://a.example', 'https://b.example'] }),
      digest({ sourcesRead: ['https://b.example', 'https://c.example'] }),
    ])
    expect(new Set(report.sources)).toEqual(new Set(['https://a.example', 'https://b.example', 'https://c.example']))
    expect(report.sources.length).toBe(3)
  })

  // Anti-regression for the pre-redesign bug: 22 of 67 jobs returned citations: 0. Any
  // digest that carries findings must always survive into non-empty citations.
  it('digests WITH findings always produce citations.length > 0', () => {
    const report = assembleReport([
      digest({ findings: [{ claim: 'load-bearing claim', url: 'https://x.example', confidence: 'high' }] }),
    ])
    expect(report.citations.length).toBeGreaterThan(0)
  })
})

describe('nextRoundQuestions', () => {
  it('dedups a gap case-insensitively against already-asked questions', () => {
    const digests = [digest({ openGaps: ['What About Z?'] })]
    const result = nextRoundQuestions(digests, new Set(['what about z?']), 5)
    expect(result).toEqual([])
  })

  it('dedups duplicate gaps within the same round', () => {
    const digests = [digest({ openGaps: ['Gap A', 'gap a', 'Gap B'] })]
    const result = nextRoundQuestions(digests, new Set(), 5)
    expect(result.map((q) => q.question)).toEqual(['Gap A', 'Gap B'])
  })

  it('respects maxQuestions, truncating the gap list', () => {
    const digests = [digest({ openGaps: ['Gap A', 'Gap B', 'Gap C'] })]
    const result = nextRoundQuestions(digests, new Set(), 2)
    expect(result.length).toBe(2)
    expect(result.map((q) => q.question)).toEqual(['Gap A', 'Gap B'])
  })

  it('returns [] when every gap was already asked — the convergence property', () => {
    const digests = [digest({ openGaps: ['Gap A', 'Gap B'] })]
    const asked = new Set(['gap a', 'gap b'])
    const result = nextRoundQuestions(digests, asked, 5)
    expect(result).toEqual([])
  })

  it('assigns stable gap-N ids to surfaced questions', () => {
    const digests = [digest({ openGaps: ['Gap A', 'Gap B'] })]
    const result = nextRoundQuestions(digests, new Set(), 5)
    expect(result).toEqual([
      { id: 'gap-1', question: 'Gap A' },
      { id: 'gap-2', question: 'Gap B' },
    ])
  })
})
