import { describe, it, expect } from 'bun:test'
// Imported from `extract.ts` directly, NOT `consistency.ts` — the review pass's import graph
// (llm.ts) pulls in `env.ts`, which parses `process.env` at import time and throws without
// secrets. Same convention as run.test.ts importing from `assemble.ts`.
import { resolveConsistencyReview } from './extract.js'

const SOURCE_URL = 'https://example.com/patch-notes'
const OTHER_URL = 'https://example.com/build-guide'

// Long enough to clear any legacy length heuristic, with two URLs in the prose. Every
// sentence is unique — the resolver refuses ambiguous anchors, so a fixture that repeats
// one would fail the very contract it is testing.
const ORIGINAL =
  '# Wild Rift patch 7.2 build guide\n\n' +
  'The community build guide was refreshed for this patch. '.repeat(6) +
  'Patch 7.2 removed boot enchantments entirely, so the boot line ends at tier-2 upgrades.\n\n' +
  `See the official notes (${SOURCE_URL}) for the full removal list.\n\n` +
  '## Recommended builds\n\n' +
  `Plated Steelcaps into the Gargoyle Enchant remains the standard tank line (${OTHER_URL}).`

describe('resolveConsistencyReview', () => {
  it('returns the original untouched when the reviewer finds no contradiction', () => {
    const result = resolveConsistencyReview(ORIGINAL, { consistent: true })
    expect(result).toEqual({ report: ORIGINAL, corrected: false })
  })

  it('returns the original when no review arrived (no tool call)', () => {
    expect(resolveConsistencyReview(ORIGINAL, null)).toEqual({ report: ORIGINAL, corrected: false })
  })

  it('accepts a legitimate one-span correction', () => {
    const result = resolveConsistencyReview(ORIGINAL, {
      consistent: false,
      edits: [
        {
          find: 'Plated Steelcaps into the Gargoyle Enchant remains the standard tank line',
          replace: 'The boot line ends at Plated Steelcaps — no enchant follows it in 7.2',
        },
      ],
    })
    expect(result.corrected).toBe(true)
    expect(result.report).toContain('no enchant follows it in 7.2')
    expect(result.report).toContain(SOURCE_URL)
    expect(result.report).toContain(OTHER_URL)
  })

  it('applies multiple spans sequentially', () => {
    const result = resolveConsistencyReview(ORIGINAL, {
      consistent: false,
      edits: [
        {
          find: 'Plated Steelcaps into the Gargoyle Enchant remains the standard tank line',
          replace: 'The boot line ends at Plated Steelcaps — no enchant follows it in 7.2',
        },
        {
          find: 'Patch 7.2 removed boot enchantments entirely',
          replace: 'Patch 7.2 removed boot enchantments and their upgrade path',
        },
      ],
    })
    expect(result.corrected).toBe(true)
    expect(result.report).toContain('no enchant follows it in 7.2')
    expect(result.report).toContain('removed boot enchantments and their upgrade path')
    expect(result.report).toContain(OTHER_URL)
  })

  it('rejects a span whose replacement introduces an invented URL', () => {
    // The case the length floor could not see: invented sourcing replacing real prose.
    // Under the edits contract there is no whole body to swap — the reviewer works in
    // spans — and a span that swaps a real statement for prose citing a URL the run never
    // touched is refused by the citation-preservation check.
    const swap = resolveConsistencyReview(ORIGINAL, {
      consistent: false,
      edits: [
        {
          find: 'Plated Steelcaps into the Gargoyle Enchant remains the standard tank line',
          replace: 'The Gargoyle Enchant remains standard, per the notes at https://totally-invented.example/wiki',
        },
      ],
    })
    expect(swap).toEqual({ report: ORIGINAL, corrected: false })
  })

  it('rejects a span whose replacement drops a URL from the prose', () => {
    const result = resolveConsistencyReview(ORIGINAL, {
      consistent: false,
      edits: [
        {
          find: `Plated Steelcaps into the Gargoyle Enchant remains the standard tank line (${OTHER_URL})`,
          replace: 'Plated Steelcaps into the Gargoyle Enchant remains the standard tank line',
        },
      ],
    })
    expect(result).toEqual({ report: ORIGINAL, corrected: false })
  })

  it('rejects padding — spans cannot inflate the body, only restate spans', () => {
    // 1.6x padding via one enormous replacement is not available under the span contract;
    // what IS available (a bloated replace text) is still bounded to one span, so the
    // blast radius is a single paragraph, not the report. A span that swallows a URL
    // is refused like any other.
    const bloated = resolveConsistencyReview(ORIGINAL, {
      consistent: false,
      edits: [
        {
          find: 'Plated Steelcaps into the Gargoyle Enchant remains the standard tank line',
          replace: `${'Padded prose. '.repeat(400)}${OTHER_URL} — untouched`,
        },
      ],
    })
    expect(bloated).toEqual({ report: ORIGINAL, corrected: false })
  })

  it('falls back to the original when consistent is false but no edits came back', () => {
    const result = resolveConsistencyReview(ORIGINAL, { consistent: false })
    expect(result).toEqual({ report: ORIGINAL, corrected: false })
  })

  it('falls back to the original when an anchor is absent — a hallucinated span', () => {
    const result = resolveConsistencyReview(ORIGINAL, {
      consistent: false,
      edits: [{ find: 'This sentence does not appear anywhere in the report', replace: 'Whatever' }],
    })
    expect(result).toEqual({ report: ORIGINAL, corrected: false })
  })

  it('falls back to the original when an anchor occurs more than once — ambiguous', () => {
    const result = resolveConsistencyReview(ORIGINAL + '\n\n' + ORIGINAL, {
      consistent: false,
      edits: [
        {
          find: 'Plated Steelcaps into the Gargoyle Enchant remains the standard tank line',
          replace: 'The boot line ends at Plated Steelcaps',
        },
      ],
    })
    expect(result).toEqual({ report: ORIGINAL + '\n\n' + ORIGINAL, corrected: false })
  })

  it('falls back to the original when a span is a no-op', () => {
    const result = resolveConsistencyReview(ORIGINAL, {
      consistent: false,
      edits: [
        {
          find: 'Plated Steelcaps into the Gargoyle Enchant remains the standard tank line',
          replace: 'Plated Steelcaps into the Gargoyle Enchant remains the standard tank line',
        },
      ],
    })
    expect(result).toEqual({ report: ORIGINAL, corrected: false })
  })

  it('falls back to the original when any one span is bad — all-or-nothing, not partial', () => {
    // Span 1 is fine; span 2 hallucinates its anchor. Neither may apply.
    const result = resolveConsistencyReview(ORIGINAL, {
      consistent: false,
      edits: [
        {
          find: 'Patch 7.2 removed boot enchantments entirely',
          replace: 'Patch 7.2 removed boot enchantments and their upgrade path',
        },
        { find: 'Still no such sentence', replace: 'Whatever' },
      ],
    })
    expect(result).toEqual({ report: ORIGINAL, corrected: false })
  })

  it('falls back to the original when the edit set is empty', () => {
    const result = resolveConsistencyReview(ORIGINAL, { consistent: false, edits: [] })
    expect(result).toEqual({ report: ORIGINAL, corrected: false })
  })

  it('inserts a replacement containing $& literally — no replace-pattern interpretation', () => {
    const result = resolveConsistencyReview(ORIGINAL, {
      consistent: false,
      edits: [
        {
          find: 'Patch 7.2 removed boot enchantments entirely',
          replace: 'Patch 7.2 removed boot enchantments ($& is matched literally here)',
        },
      ],
    })
    expect(result.corrected).toBe(true)
    expect(result.report).toContain('$& is matched literally here')
    expect(result.report).not.toContain('entirely ($&')
  })
})
