import { describe, it, expect } from 'bun:test'
// prompt.ts has no `env.js` import chain (schema.js types + depth.js data only), so these
// render purely — same convention as assemble.ts's tests in run.test.ts.
import { backgroundSection } from './prompt.js'

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
