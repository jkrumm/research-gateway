import { describe, it, expect } from 'bun:test'
import { shouldForceSubmit, buildSalvageMessages, buildSalvageInstruction, SALVAGE_TOOL_NAME } from './salvage.js'

describe('shouldForceSubmit', () => {
  it('is false with no steps', () => {
    expect(shouldForceSubmit({ steps: [], maxContextTokens: 60_000 })).toBe(false)
  })

  it('trips the flat 80% check regardless of history', () => {
    expect(
      shouldForceSubmit({ steps: [{ usage: { inputTokens: 49_000 } }], maxContextTokens: 60_000 }),
    ).toBe(true)
  })

  it('stays false comfortably under 80% with no prior step to diff against', () => {
    expect(
      shouldForceSubmit({ steps: [{ usage: { inputTokens: 20_000 } }], maxContextTokens: 60_000 }),
    ).toBe(false)
  })

  it('extrapolates growth: a step under 80% that is about to jump past the ceiling next step trips early', () => {
    // The measured failure mode: one step with several fetchPage results can roughly double
    // input tokens in a single hop. 30k -> 44k is under 80% of 60k (48k) but +14k more next
    // step would land at 58k... use a case that clearly crosses the ceiling.
    const steps = [{ usage: { inputTokens: 20_000 } }, { usage: { inputTokens: 45_000 } }]
    expect(shouldForceSubmit({ steps, maxContextTokens: 60_000 })).toBe(true)
  })

  it('does not trip on shrinking or flat input', () => {
    const steps = [{ usage: { inputTokens: 40_000 } }, { usage: { inputTokens: 35_000 } }]
    expect(shouldForceSubmit({ steps, maxContextTokens: 60_000 })).toBe(false)
  })

  it('treats missing usage as zero input', () => {
    expect(shouldForceSubmit({ steps: [{}], maxContextTokens: 60_000 })).toBe(false)
  })
})

describe('buildSalvageMessages', () => {
  it('places the user prompt first, the transcript verbatim in the middle, and the instruction last', () => {
    const transcript = [
      { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'thinking' }] },
      { role: 'tool' as const, content: [] },
    ]
    const result = buildSalvageMessages({
      userPrompt: 'What is X?',
      transcript,
      instruction: 'Submit now.',
    })

    expect(result).toHaveLength(4)
    expect(result[0]).toEqual({ role: 'user', content: 'What is X?' })
    expect(result[1]).toBe(transcript[0])
    expect(result[2]).toBe(transcript[1])
    expect(result[3]).toEqual({ role: 'user', content: 'Submit now.' })
  })

  it('preserves an empty transcript without dropping the two user turns', () => {
    const result = buildSalvageMessages({ userPrompt: 'Q', transcript: [], instruction: 'Go.' })
    expect(result).toEqual([
      { role: 'user', content: 'Q' },
      { role: 'user', content: 'Go.' },
    ])
  })
})

describe('buildSalvageInstruction', () => {
  it('contains no tool-availability wording', () => {
    const instruction = buildSalvageInstruction().toLowerCase()
    expect(instruction).not.toMatch(/tool.*(unavailable|disabled|broken|no longer|not available|stopped working)/)
    expect(instruction).not.toContain('unavailable')
    expect(instruction).not.toContain('disabled')
    expect(instruction).not.toContain('nosuchtoolerror')
  })

  it('explicitly attributes the ending to budget, not to a tool failure', () => {
    const instruction = buildSalvageInstruction()
    expect(instruction).toContain('budget is spent')
    expect(instruction).toContain('not due to any problem with the tools themselves')
  })

  it('names the one tool it must call', () => {
    expect(buildSalvageInstruction()).toContain(SALVAGE_TOOL_NAME)
  })

  it('tells the model where unresolved items belong', () => {
    expect(buildSalvageInstruction()).toContain('openGaps')
  })
})
