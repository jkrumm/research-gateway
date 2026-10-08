import { describe, expect, it } from 'bun:test'
import { classifySynthesisReply, isCompactRetryable, reportFromText, trySalvage } from './synthesis-outcome.js'
import type { WorkerDigest } from './schema.js'

const valid = { report: '# R', citations: [], sources: [], unverified: [] }
const digest: WorkerDigest = {
  subQuestion: 'Q',
  summary: 'A.',
  findings: [{ claim: 'c', url: 'https://a.example', confidence: 'high' }],
  sourcesRead: ['https://a.example'],
  openGaps: [],
  blockedSources: [],
}

describe('classifySynthesisReply', () => {
  it('accepts a valid submit_report call', () => {
    const r = classifySynthesisReply({ finishReason: 'tool-calls', text: '', toolCalls: [{ toolName: 'submit_report', input: valid }] })
    expect(r.kind).toBe('submitted')
  })

  it('reports length for a starved call, with or without a partial tool call', () => {
    expect(classifySynthesisReply({ finishReason: 'length', text: '', toolCalls: [] }).kind).toBe('length')
    expect(
      classifySynthesisReply({ finishReason: 'length', text: '', toolCalls: [{ toolName: 'submit_report', input: { report: 'x' } }] }).kind,
    ).toBe('length')
  })

  it('reports a malformed call with the failing paths', () => {
    const r = classifySynthesisReply({ finishReason: 'tool-calls', text: '', toolCalls: [{ toolName: 'submit_report', input: { report: 1 } }] })
    expect(r.kind).toBe('malformed-call')
    if (r.kind === 'malformed-call') expect(r.issues).toContain('report')
  })

  it('treats an SDK-invalid call as malformed', () => {
    const r = classifySynthesisReply({ finishReason: 'stop', text: '', toolCalls: [{ toolName: 'submit_report', input: valid, invalid: true }] })
    expect(r.kind).toBe('malformed-call')
  })

  it('separates a text-only reply from an empty one', () => {
    expect(classifySynthesisReply({ finishReason: 'stop', text: ' hello ', toolCalls: [] })).toEqual({ kind: 'text-only', text: 'hello' })
    expect(classifySynthesisReply({ finishReason: 'stop', text: '  ', toolCalls: [] }).kind).toBe('no-output')
  })
})

describe('reportFromText', () => {
  const prose = 'Findings. '.repeat(200)

  it('keeps the prose and takes citations from the digests', () => {
    const r = reportFromText(prose, [digest])
    expect(r?.report).toBe(prose.trim())
    expect(r?.citations).toEqual([{ claim: 'c', url: 'https://a.example', confidence: 'high' }])
  })

  it('refuses short text and JSON blobs', () => {
    expect(reportFromText('Sorry, I cannot.', [digest])).toBeNull()
    expect(reportFromText(`{"report":"${'x'.repeat(2000)}"}`, [digest])).toBeNull()
  })
})

describe('trySalvage / isCompactRetryable', () => {
  const prose = 'Findings. '.repeat(200)

  it('turns long prose into a submitted report and leaves other kinds alone', () => {
    expect(trySalvage({ kind: 'text-only', text: prose }, [digest]).kind).toBe('submitted')
    expect(trySalvage({ kind: 'text-only', text: 'short' }, [digest]).kind).toBe('text-only')
    expect(trySalvage({ kind: 'length' }, [digest]).kind).toBe('length')
  })

  it('keeps markdown that starts with a bracket, rejects only a JSON object', () => {
    expect(reportFromText(`[1] ${prose}`, [digest])).not.toBeNull()
  })

  it('applies the 1500-char floor exactly', () => {
    expect(reportFromText('x'.repeat(1499), [digest])).toBeNull()
    expect(reportFromText('x'.repeat(1500), [digest])).not.toBeNull()
  })

  it('retries compactly for everything except length and success', () => {
    expect(isCompactRetryable({ kind: 'guard' })).toBe(true)
    expect(isCompactRetryable({ kind: 'no-output' })).toBe(true)
    expect(isCompactRetryable({ kind: 'length' })).toBe(false)
    expect(isCompactRetryable({ kind: 'submitted', report: { report: '', citations: [], sources: [], unverified: [] } })).toBe(false)
  })
})
