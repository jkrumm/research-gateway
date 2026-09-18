import { describe, it, expect } from 'bun:test'
// Imported from `extract.ts` directly, NOT `consistency.ts` — the review pass's import graph
// (llm.ts) pulls in `env.ts`, which parses `process.env` at import time and throws without
// secrets. Same convention as run.test.ts importing from `assemble.ts`.
import { resolveConsistencyReview, applyConsistencyGate, CONSISTENCY_WARNING, urlsIn } from './extract.js'
import { ConsistencyReview } from './schema.js'

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
    expect(result).toEqual({ report: ORIGINAL, corrected: false, appliedEdits: [] })
  })

  it('returns the original when no review arrived (no tool call)', () => {
    expect(resolveConsistencyReview(ORIGINAL, null)).toEqual({ report: ORIGINAL, corrected: false, appliedEdits: [] })
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
    expect(swap).toEqual({ report: ORIGINAL, corrected: false, appliedEdits: [] })
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
    expect(result).toEqual({ report: ORIGINAL, corrected: false, appliedEdits: [] })
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
    expect(bloated).toEqual({ report: ORIGINAL, corrected: false, appliedEdits: [] })
  })

  it('falls back to the original when consistent is false but no edits came back', () => {
    const result = resolveConsistencyReview(ORIGINAL, { consistent: false })
    expect(result).toEqual({ report: ORIGINAL, corrected: false, appliedEdits: [] })
  })

  it('falls back to the original when an anchor is absent — a hallucinated span', () => {
    const result = resolveConsistencyReview(ORIGINAL, {
      consistent: false,
      edits: [{ find: 'This sentence does not appear anywhere in the report', replace: 'Whatever' }],
    })
    expect(result).toEqual({ report: ORIGINAL, corrected: false, appliedEdits: [] })
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
    expect(result).toEqual({ report: ORIGINAL + '\n\n' + ORIGINAL, corrected: false, appliedEdits: [] })
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
    expect(result).toEqual({ report: ORIGINAL, corrected: false, appliedEdits: [] })
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
    expect(result).toEqual({ report: ORIGINAL, corrected: false, appliedEdits: [] })
  })

  it('falls back to the original when the edit set is empty', () => {
    const result = resolveConsistencyReview(ORIGINAL, { consistent: false, edits: [] })
    expect(result).toEqual({ report: ORIGINAL, corrected: false, appliedEdits: [] })
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
  // ── Anchor bounds (issue #16 follow-up) ────────────────────────────────────
  //
  // Growth bounds cap how much a span may ADD; nothing bounded how much a span may COVER,
  // so a single edit whose find was the entire body passed every check and re-authored the
  // report wholesale. Both caps below measure against the ORIGINAL text.

  it('rejects a single edit whose find is the ENTIRE body — the whole-body anchor bypass', () => {
    // Reproduced at 49fd3e60: unique anchor, both URLs kept verbatim, growth within bounds —
    // and the report was nonetheless replaced wholesale with unrelated prose.
    const replace =
      'Wholesale rewritten body that agrees with itself. '.repeat(7) +
      ` (${SOURCE_URL}) (${OTHER_URL})`
    const result = resolveConsistencyReview(ORIGINAL, {
      consistent: false,
      edits: [{ find: ORIGINAL, replace }],
    })
    expect(result).toEqual({ report: ORIGINAL, corrected: false, appliedEdits: [] })
  })

  it('rejects chunked reassembly — N individually-small spans jointly covering the body', () => {
    // The 2-span companion to the whole-body anchor: each span under the per-span cap, but
    // Σfind over the set cap. Chunks are cut small enough to stay unique in ORIGINAL.
    const chunk = ORIGINAL.slice(0, Math.floor(ORIGINAL.length * 0.3))
    const rest = ORIGINAL.slice(Math.floor(ORIGINAL.length * 0.5), Math.floor(ORIGINAL.length * 0.8))
    const result = resolveConsistencyReview(ORIGINAL, {
      consistent: false,
      edits: [
        { find: chunk, replace: 'R'.repeat(chunk.length) },
        { find: rest, replace: 'R'.repeat(rest.length) },
      ],
    })
    expect(result).toEqual({ report: ORIGINAL, corrected: false, appliedEdits: [] })
  })

  it('still accepts a 75-char fix on a 2k-char body — the caps do not choke real edits', () => {
    const long =
      'The benchmark harness measured throughput across three runs. '.repeat(30) +
      'Patch 7.2 removed boot enchantments entirely, so the boot line ends at tier-2 upgrades.\n\n' +
      `See the official notes (${SOURCE_URL}) for the full removal list.\n\n` +
      `Plated Steelcaps into the Gargoyle Enchant remains the standard tank line (${OTHER_URL}).`
    expect(long.length).toBeGreaterThan(2000)
    const result = resolveConsistencyReview(long, {
      consistent: false,
      edits: [
        {
          find: 'Patch 7.2 removed boot enchantments entirely',
          replace: 'Patch 7.2 removed boot enchantments and their upgrade path',
        },
      ],
    })
    expect(result.corrected).toBe(true)
    expect(result.appliedEdits).toHaveLength(1)
    expect(result.appliedEdits[0]?.find).toBe('Patch 7.2 removed boot enchantments entirely')
  })

  it('carries the applied spans out on the resolution — an accepted edit is never silent', () => {
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
    expect(result.appliedEdits).toHaveLength(2)
    expect(result.appliedEdits[0]).toEqual({
      find: 'Plated Steelcaps into the Gargoyle Enchant remains the standard tank line',
      replace: 'The boot line ends at Plated Steelcaps — no enchant follows it in 7.2',
    })
  })

  // ── URL preservation: count, order, and span boundaries ──────────────────────
  //
  // The pre-fix check compared URL SETS (membership + size). On a body carrying the same
  // URL twice, dropping one occurrence left the set unchanged; re-pairing which URL sat in
  // which slot left set and size both unchanged — both returned corrected:true at b8fbddd3.
  // Fixtures are ~2k chars because on a short body the anchor-coverage cap refuses these
  // spans before the URL logic is reached; the hole needed a realistically sized report,
  // which is why it was live in production and invisible in the original short fixture.

  const URL_A = 'https://example.com/run-data'
  const URL_B = 'https://example.com/run-analysis'

  // ~2k body whose citation sentence carries URL_A TWICE and whose last line carries
  // URL_B — a count change on A and an A/B re-pairing are both invisible to a set check.
  // Leading prose is unique filler so anchors stay unambiguous.
  const LONG_BODY =
    'The benchmark harness measured throughput across three separate runs of the same suite. '.repeat(8) +
    'The first run established the baseline numbers for the whole comparison. '.repeat(8) +
    'The second and third runs confirmed the baseline held under sustained load. '.repeat(8) +
    `Full methodology is documented online (${URL_A}), with the raw data alongside it (${URL_A}).\n\n` +
    `The follow-up analysis is published separately (${URL_B}).`

  it('refuses a span that drops one of two occurrences of a URL — the set check was blind to this', () => {
    // Pre-fix: the surviving occurrence kept the set at {A, B} and this returned
    // corrected:true. Now the categorical rule refuses any span carrying a URL.
    expect(LONG_BODY.length).toBeGreaterThan(1900)
    const result = resolveConsistencyReview(LONG_BODY, {
      consistent: false,
      edits: [{ find: `, with the raw data alongside it (${URL_A})`, replace: '' }],
    })
    expect(result).toEqual({ report: LONG_BODY, corrected: false, appliedEdits: [] })
  })

  it('refuses a span that swaps which URL sits where — set and size unchanged, order changed', () => {
    // Pre-fix: [A, A, B] -> [B, B, A] keeps the set {A, B} and size 2 — accepted. Now
    // refused categorically: the span necessarily carries the URLs it re-pairs.
    const result = resolveConsistencyReview(LONG_BODY, {
      consistent: false,
      edits: [
        {
          find: `Full methodology is documented online (${URL_A}), with the raw data alongside it (${URL_A}).\n\nThe follow-up analysis is published separately (${URL_B}).`,
          replace: `Full methodology is documented online (${URL_B}), with the raw data alongside it (${URL_B}).\n\nThe follow-up analysis is published separately (${URL_A}).`,
        },
      ],
    })
    expect(result).toEqual({ report: LONG_BODY, corrected: false, appliedEdits: [] })
  })

  it('refuses a span whose find anchor carries a URL — categorical rule fires before application', () => {
    const result = resolveConsistencyReview(LONG_BODY, {
      consistent: false,
      edits: [
        {
          find: `Full methodology is documented online (${URL_A})`,
          replace: 'Full methodology is documented elsewhere',
        },
      ],
    })
    expect(result).toEqual({ report: LONG_BODY, corrected: false, appliedEdits: [] })
  })

  it('still accepts a prose edit adjacent to a URL — the categorical rule is not over-broad', () => {
    const result = resolveConsistencyReview(LONG_BODY, {
      consistent: false,
      edits: [
        {
          find: 'Full methodology is documented online',
          replace: 'Full methodology is documented elsewhere online',
        },
      ],
    })
    expect(result.corrected).toBe(true)
    expect(result.report).toContain(URL_A)
    expect(result.report).toContain(URL_B)
  })

  it('catches a span whose boundary splits a URL mid-host — no complete URL in the span text, so only the sequence check can refuse it', () => {
    // The span starts INSIDE the first URL, at its `//`: the find text carries no
    // scheme-complete URL, so the categorical rule lets it through — the exact residual
    // the ordered-sequence comparison exists for. The splice rewrites the URL's host, and
    // the byte-identical sequence check refuses the set. This is why that check is NOT
    // dead code once the categorical rule holds.
    const result = resolveConsistencyReview(LONG_BODY, {
      consistent: false,
      edits: [
        {
          find: '//example.com/run-data), with the raw data alongside it',
          replace: '//example.com/run-data-mirror), with the raw data alongside it',
        },
      ],
    })
    expect(result).toEqual({ report: LONG_BODY, corrected: false, appliedEdits: [] })
  })

  // ── Paren-aware URL extraction ─────────────────────────────────────────────
  //
  // URL_RE excluded every parenthesis, so Wikipedia-style balanced-paren paths were
  // recorded truncated: Foo_(bar) was extracted as Foo_. A span editing (bar)→(baz) INSIDE
  // such a URL carried no scheme-complete URL in either end, left the truncated
  // sequence [Foo_] unchanged on both sides, and was accepted — a live citation silently
  // rewritten. Verified at a68bf10b; the matcher now lets parens through and trims trailing
  // ')' while they outnumber '('.

  it('extracts a balanced-paren path whole — Foo_(bar) is one URL, not Foo_', () => {
    expect(urlsIn('see https://en.wikipedia.org/wiki/Foo_(bar) for details')).toEqual([
      'https://en.wikipedia.org/wiki/Foo_(bar)',
    ])
  })

  it('extracts nested balanced parens whole — a_(b_(c)) survives both levels', () => {
    expect(urlsIn('https://ex.example/a_(b_(c))')).toEqual(['https://ex.example/a_(b_(c))'])
  })

  it('does not swallow the trailing prose paren after a bare URL', () => {
    // "see https://x.example/a)" — the ')' is prose, the URL has none, so the trim peels it.
    expect(urlsIn('see https://x.example/a)')).toEqual(['https://x.example/a'])
  })

  it('stops a bare URL at whitespace like before — parens do not make the scan greedy across prose', () => {
    expect(urlsIn('(https://ex.example/r_(s)) end')).toEqual(['https://ex.example/r_(s)'])
    expect(urlsIn('plain https://ex.example/no-parens, then prose')).toEqual([
      'https://ex.example/no-parens,',
    ])
  })

  it('refuses a span editing (bar)→(baz) inside a Foo_(bar) URL — the hole this closes', () => {
    // The span text carries no scheme-complete URL (the URL's scheme sits outside the
    // span), so the categorical rule cannot fire — before the paren-aware matcher this
    // whole edit was invisible: truncated extraction recorded Foo_ on both sides and the
    // sequence comparison passed while the live citation changed. Now the full URL is
    // extracted on each side and the sequence check refuses the set.
    const PAREN_BODY =
      'The benchmark harness measured throughput across three separate runs of the same suite. '.repeat(8) +
      'The first run established the baseline numbers for the whole comparison. '.repeat(8) +
      'The second and third runs confirmed the baseline held under sustained load. '.repeat(8) +
      'The disambiguation page covers every revision of the mechanic (https://en.wikipedia.org/wiki/Foo_(bar)) in detail.\n\n' +
      `The follow-up analysis is published separately (${URL_B}).`
    expect(PAREN_BODY.length).toBeGreaterThan(1900)
    const result = resolveConsistencyReview(PAREN_BODY, {
      consistent: false,
      edits: [{ find: '(bar)', replace: '(baz)' }],
    })
    expect(result).toEqual({ report: PAREN_BODY, corrected: false, appliedEdits: [] })
  })

  it('refuses a bare (bar)-bearing span too — sequence comparison, not the categorical rule, is the layer that fires', () => {
    // Same fixture, but the span carries the whole truncated-to-the-eye citation paren
    // block: still no scheme-complete URL inside the span text, so the categorical rule
    // lets it through and the sequence check is what refuses. Assert the refusal, not
    // which layer fired — the two share one matcher by construction.
    const PAREN_BODY =
      'The benchmark harness measured throughput across three separate runs of the same suite. '.repeat(8) +
      'The first run established the baseline numbers for the whole comparison. '.repeat(8) +
      'The second and third runs confirmed the baseline held under sustained load. '.repeat(8) +
      'The disambiguation page covers every revision of the mechanic (https://en.wikipedia.org/wiki/Foo_(bar)) in detail.\n\n' +
      `The follow-up analysis is published separately (${URL_B}).`
    const result = resolveConsistencyReview(PAREN_BODY, {
      consistent: false,
      edits: [{ find: '(bar)) in detail', replace: '(baz)) in detail' }],
    })
    expect(result).toEqual({ report: PAREN_BODY, corrected: false, appliedEdits: [] })
  })
})

// ── Schema boundary (test gap 2) ──────────────────────────────────────────────
//
// The schema is the boundary a real `submit_review` tool call actually passes through
// (consistency.ts's extractReview safeParses against it); the resolver's own MAX_EDITS guard
// only defends against callers that bypass it. Pins the .max(20) so a schema loosening fails
// a test here and not in production.

describe('ConsistencyReview schema', () => {
  const validEdit = { find: 'a sentence', replace: 'another sentence' }

  it('accepts exactly 20 edits', () => {
    const parsed = ConsistencyReview.safeParse({ consistent: false, edits: Array(20).fill(validEdit) })
    expect(parsed.success).toBe(true)
  })

  it('rejects 21 edits', () => {
    const parsed = ConsistencyReview.safeParse({ consistent: false, edits: Array(21).fill(validEdit) })
    expect(parsed.success).toBe(false)
  })

  it('accepts edits omitted entirely and treats it the same as an empty array downstream', () => {
    const omitted = ConsistencyReview.safeParse({ consistent: false })
    expect(omitted.success).toBe(true)
    expect((omitted.data?.edits ?? []).length).toBe(0)
    // Same shape the resolver sees from an explicit empty array — resolved identically.
    expect(resolveConsistencyReview(ORIGINAL, omitted.data ?? null)).toEqual(
      resolveConsistencyReview(ORIGINAL, { consistent: false, edits: [] }),
    )
  })

  it('rejects an edit with an empty find', () => {
    const parsed = ConsistencyReview.safeParse({ consistent: false, edits: [{ find: '', replace: 'x' }] })
    expect(parsed.success).toBe(false)
  })
})

// ── applyConsistencyGate (test gap 3) ─────────────────────────────────────────
//
// The gate's merge/attribute logic, factored out of run.ts into env-free extract.ts per the
// run.test.ts convention (run.ts's import chain boots env.js, so its wiring is untestable
// directly). These pin the merge contract run.ts depends on: usage fold, warning append,
// edits count zeroed on a clean review.

describe('applyConsistencyGate', () => {
  const leadUsage = {
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    reasoningTokens: 10,
    cachedInputTokens: 20,
    durationMs: 500,
  }
  const reviewUsage = {
    inputTokens: 7,
    outputTokens: 3,
    totalTokens: 10,
    reasoningTokens: 1,
    cachedInputTokens: 2,
    durationMs: 25,
  }

  it('folds the review pass usage into the lead bucket', () => {
    const gate = applyConsistencyGate({
      review: { corrected: true, appliedEdits: [{ find: 'a', replace: 'b' }], usage: reviewUsage },
      leadUsage,
    })
    expect(gate.leadUsage).toEqual({
      inputTokens: 107,
      outputTokens: 53,
      totalTokens: 160,
      reasoningTokens: 11,
      cachedInputTokens: 22,
      durationMs: 525,
    })
  })

  it('reports corrected:true and the applied count when the pass rewrote the body', () => {
    const gate = applyConsistencyGate({
      review: { corrected: true, appliedEdits: [{ find: 'a', replace: 'b' }, { find: 'c', replace: 'd' }], usage: reviewUsage },
      leadUsage,
    })
    expect(gate.corrected).toBe(true)
    expect(gate.edits).toBe(2)
  })

  it('zeroes the edit count when the review found nothing — but usage still folds in', () => {
    const gate = applyConsistencyGate({
      review: { corrected: false, appliedEdits: [], usage: reviewUsage },
      leadUsage,
    })
    expect(gate.corrected).toBe(false)
    expect(gate.edits).toBe(0)
    expect(gate.leadUsage.inputTokens).toBe(107)
  })
})
