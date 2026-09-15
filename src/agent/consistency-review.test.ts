import { describe, it, expect } from 'bun:test'
// Imported from `extract.ts` directly, NOT `consistency.ts` — the review pass's import graph
// (llm.ts) pulls in `env.ts`, which parses `process.env` at import time and throws without
// secrets. Same convention as run.test.ts importing from `assemble.ts`.
import { resolveConsistencyReview } from './extract.js'

// Long enough to clear the 200-char floor on its own.
const ORIGINAL =
  '# Wild Rift patch 7.2 build guide\n\n' +
  'Patch 7.2 removed boot enchantments entirely, so the boot line ends at tier-2 upgrades. '.repeat(3) +
  '\n\n## Recommended builds\n\nPlated Steelcaps into the Gargoyle Enchant remains the standard tank line.'

describe('resolveConsistencyReview', () => {
  it('returns the original untouched when the reviewer finds no contradiction', () => {
    const result = resolveConsistencyReview(ORIGINAL, { consistent: true })
    expect(result).toEqual({ report: ORIGINAL, corrected: false })
  })

  it('returns the original when no review arrived (no tool call)', () => {
    expect(resolveConsistencyReview(ORIGINAL, null)).toEqual({ report: ORIGINAL, corrected: false })
  })

  it('accepts a plausible corrected body', () => {
    const corrected = ORIGINAL.replace(
      'Plated Steelcaps into the Gargoyle Enchant remains the standard tank line.',
      'The boot line ends at Plated Steelcaps — no enchant follows it in 7.2.',
    )
    const result = resolveConsistencyReview(ORIGINAL, { consistent: false, report: corrected })
    expect(result).toEqual({ report: corrected, corrected: true })
  })

  it('falls back to the original when consistent is false but no report text came back', () => {
    const result = resolveConsistencyReview(ORIGINAL, { consistent: false })
    expect(result).toEqual({ report: ORIGINAL, corrected: false })
  })

  it('falls back to the original when the corrected body is under the length floor', () => {
    const result = resolveConsistencyReview(ORIGINAL, { consistent: false, report: 'Fixed.' })
    expect(result).toEqual({ report: ORIGINAL, corrected: false })
  })

  it('falls back to the original when the corrected body is materially shorter — a rewrite, not a deletion', () => {
    // ~50% of the original: resolving a contradiction must not mean deleting the sections
    // that contained it.
    const gutted = ORIGINAL.slice(0, Math.floor(ORIGINAL.length * 0.5))
    const result = resolveConsistencyReview(ORIGINAL, { consistent: false, report: gutted })
    expect(result).toEqual({ report: ORIGINAL, corrected: false })
  })

  it('accepts a corrected body slightly shorter than the original — editorial latitude is not deletion', () => {
    // ~90% of the original length: tightening prose while resolving the contradiction is
    // legitimate and must pass.
    const tightened = ORIGINAL.slice(0, Math.floor(ORIGINAL.length * 0.9))
    const result = resolveConsistencyReview(ORIGINAL, { consistent: false, report: tightened })
    expect(result).toEqual({ report: tightened, corrected: true })
  })
})
