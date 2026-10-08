import type { SubmittedReport, SubQuestion, WorkerDigest } from './schema.js'

// Dependency-free by design (only `schema.js`, which has no `env.js` import) so these two
// pure helpers can be unit-tested without booting the whole env/llm import chain.

// Deterministic fallback — assembled in code, no LLM call. This is what makes a cited
// report reachable even when synthesis fails or times out — the single property that
// makes a `citations: 0` result unreachable when digests carry findings. Must be total:
// given `[]` it returns empty strings/arrays rather than throwing; the caller already
// guards on `allDigests.length > 0`, but this function must not itself be a trap.
export function assembleReport(digests: WorkerDigest[]): SubmittedReport {
  const sections = digests.map((d) => ({ heading: headingFor(d.subQuestion), body: stripNarration(d.summary) }))
  const body = sections.map((s) => `## ${s.heading}\n\n${s.body}`).join('\n\n')
  return {
    report: [bottomLine(sections), body].filter(Boolean).join('\n\n'),
    citations: digests.flatMap((d) =>
      d.findings.map((f) => ({ claim: f.claim, url: f.url, confidence: f.confidence })),
    ),
    sources: [...new Set(digests.flatMap((d) => d.sourcesRead))],
    unverified: digests.flatMap((d) => d.blockedSources),
  }
}

// A worker summary is written as the worker's own account, so it carries process narration
// ("I searched…", "Let me check…") that means nothing to a reader of the fallback report.
// Drop first-person sentences; if that would leave nothing, keep the original rather than
// emit an empty section.
const NARRATION = /^(?:I(?:'m|'ve|'ll|'d)?|Let me|Let's|Based on my)\s/

export function stripNarration(summary: string): string {
  const kept = summary
    .split('\n')
    .map((line) =>
      line
        .split(/(?<=[.!?])\s+/)
        .filter((sentence) => !NARRATION.test(sentence.trim()))
        .join(' '),
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return kept.length > 0 ? kept : summary.trim()
}

// Deterministic top summary: the first sentence of each section's body, so the reader gets the
// per-sub-question answers before the detail. Capped per line; a section with no usable
// sentence (a bare list, a table) is left out rather than quoted mid-structure.
const MAX_BOTTOM_LINE_CHARS = 280

function bottomLine(sections: ReadonlyArray<{ heading: string; body: string }>): string {
  const lines = sections.flatMap(({ heading, body }) => {
    const first = body
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !/^[#|>`-]/.test(l) && !/^\d+\./.test(l) && !NARRATION.test(l))
    if (!first) return []
    const sentence = first.split(/(?<=[.!?])\s+/, 1)[0] ?? first
    const clipped =
      sentence.length > MAX_BOTTOM_LINE_CHARS ? `${sentence.slice(0, MAX_BOTTOM_LINE_CHARS - 1).trimEnd()}…` : sentence
    return [`- **${heading}** — ${clipped}`]
  })
  return lines.length > 0 ? `## Bottom line\n\n${lines.join('\n')}` : ''
}

// A worker's `subQuestion` is the full research prompt, not a title: "(a) how does X work;
// (b) what does Y cost; (c) …" can run to 400+ characters, and used verbatim as an H2 it
// produces an unreadable table of contents in the assembled (fallback) report. Reduce it to
// its first clause — up to the first ':', '(' or '?' — and cap it, since that clause is the
// part naming the topic. Pure and total: an empty or delimiter-first question falls back to
// the trimmed original, and the cap never yields a bare ellipsis.
const MAX_HEADING_CHARS = 80

export function headingFor(subQuestion: string): string {
  const trimmed = subQuestion.trim()
  const clause = trimmed.split(/[:?(]/, 1)[0]?.trim() ?? ''
  const base = clause.length > 0 ? clause : trimmed
  return base.length > MAX_HEADING_CHARS ? `${base.slice(0, MAX_HEADING_CHARS - 1).trimEnd()}…` : base
}

// Gap-filling rounds (deep only): dedup a round's openGaps against every sub-question
// already researched — case-insensitively, and against the FULL history, not just the
// last round — so the loop provably converges instead of re-asking the same gap forever.
export function nextRoundQuestions(
  digests: WorkerDigest[],
  askedLower: Set<string>,
  maxQuestions: number,
): SubQuestion[] {
  const gaps: string[] = []
  const seenLower = new Set<string>()
  for (const digest of digests) {
    for (const gap of digest.openGaps) {
      const gapLower = gap.trim().toLowerCase()
      if (!gapLower || askedLower.has(gapLower) || seenLower.has(gapLower)) continue
      seenLower.add(gapLower)
      gaps.push(gap)
    }
  }
  return gaps.slice(0, maxQuestions).map((question, i) => ({ id: `gap-${i + 1}`, question }))
}
