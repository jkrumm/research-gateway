import { describe, it, expect } from 'bun:test'
// prompt.ts has no `env.js` import chain (schema.js types + depth.js data only), so these
// render purely (brain.js is pure too) — same convention as assemble.ts's tests in run.test.ts.
import { backgroundSection, ownerNoteTag, synthesisPrompt } from './prompt.js'

describe('backgroundSection', () => {
  it('returns an empty string when no context was passed — call sites interpolate unconditionally', () => {
    expect(backgroundSection(undefined)).toBe('')
  })

  it('returns an empty string for an empty context', () => {
    expect(backgroundSection('')).toBe('')
  })

  it('renders the context under the "Given background" heading the static prompts name', () => {
    expect(backgroundSection('Bun 1.2 is the current version.')).toBe(
      '\n\n## Given background\n\nBun 1.2 is the current version.\n',
    )
  })

  it('trims surrounding whitespace from the caller-supplied text', () => {
    expect(backgroundSection('  some fact  \n')).toBe('\n\n## Given background\n\nsome fact\n')
  })
})

describe('ownerNoteTag — a brain note reaches synthesis marked as a dated prior', () => {
  const base = 'https://brain.example.test'
  it('tags a note URL, and nothing else', () => {
    expect(ownerNoteTag(`${base}/wiki/gaming/sourcing`, base)).toContain("OWNER'S NOTE")
    expect(ownerNoteTag('https://wrchina.gg/c/dr-mundo/', base)).toBe('')
    expect(ownerNoteTag(`${base}/wiki/gaming/sourcing`, undefined)).toBe('')
  })

  it('the synthesis rule it points at exists', () => {
    expect(synthesisPrompt('standard')).toContain("OWNER'S NOTE (dated prior)")
  })
})
