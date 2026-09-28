import { describe, it, expect } from 'bun:test'
import { CHECKPOINT_VERSION, serializeCheckpoint, parseCheckpoint, type ResearchCheckpoint } from './checkpoint.js'

function checkpoint(overrides: Partial<ResearchCheckpoint> = {}): ResearchCheckpoint {
  return {
    version: CHECKPOINT_VERSION,
    subQuestions: [{ id: 'q1', question: 'What changed in the API?' }],
    round: 2,
    digests: [
      {
        subQuestion: 'What changed in the API?',
        summary: 'Nothing notable.',
        findings: [{ claim: 'v2 shipped', url: 'https://example.invalid/changelog', confidence: 'high' }],
        sourcesRead: ['https://example.invalid/changelog'],
        openGaps: [],
        blockedSources: [],
      },
    ],
    ledgers: [{ retrieved: ['https://example.invalid/changelog'], missing: [], snippet: [], failed: [] }],
    askedLower: ['what changed in the api?'],
    failures: [],
    alreadyRetried: false,
    leadUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, reasoningTokens: 0, cachedInputTokens: 0, durationMs: 100 },
    workerUsage: { inputTokens: 20, outputTokens: 8, totalTokens: 28, reasoningTokens: 0, cachedInputTokens: 4, durationMs: 200 },
    workersDispatchedTotal: 1,
    ...overrides,
  }
}

describe('serializeCheckpoint / parseCheckpoint', () => {
  it('round-trips a checkpoint exactly', () => {
    const cp = checkpoint()
    const parsed = parseCheckpoint(serializeCheckpoint(cp))
    expect(parsed).toEqual(cp)
  })

  it('round-trips a checkpoint with no more rounds to run (empty subQuestions)', () => {
    const cp = checkpoint({ subQuestions: [], round: 3 })
    const parsed = parseCheckpoint(serializeCheckpoint(cp))
    expect(parsed).toEqual(cp)
  })

  it('returns null for a null or undefined input', () => {
    expect(parseCheckpoint(null)).toBeNull()
    expect(parseCheckpoint(undefined)).toBeNull()
  })

  it('returns null for an empty string', () => {
    expect(parseCheckpoint('')).toBeNull()
  })

  it('returns null for malformed JSON', () => {
    expect(parseCheckpoint('{not json')).toBeNull()
  })

  it('returns null for valid JSON that is not an object at all', () => {
    expect(parseCheckpoint('42')).toBeNull()
    expect(parseCheckpoint('"just a string"')).toBeNull()
    expect(parseCheckpoint('null')).toBeNull()
  })

  it('returns null on a version mismatch, so a future shape change degrades to a fresh run rather than a crash', () => {
    const wrongVersion = JSON.stringify({ ...checkpoint(), version: 999 })
    expect(parseCheckpoint(wrongVersion)).toBeNull()
  })

  it('returns null when a required field is missing', () => {
    const cp = checkpoint() as Record<string, unknown>
    delete cp['digests']
    expect(parseCheckpoint(JSON.stringify(cp))).toBeNull()
  })

  it('returns null when a field has the wrong type', () => {
    const cp = { ...checkpoint(), round: 'two' }
    expect(parseCheckpoint(JSON.stringify(cp))).toBeNull()
  })
})
