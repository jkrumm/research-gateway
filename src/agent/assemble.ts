import type { SubmittedReport, SubQuestion, WorkerDigest } from './schema.js'

// Dependency-free by design (only `schema.js`, which has no `env.js` import) so these two
// pure helpers can be unit-tested without booting the whole env/llm import chain.

// Deterministic fallback — assembled in code, no LLM call. This is what makes a cited
// report reachable even when synthesis fails or times out — the single property that
// makes a `citations: 0` result unreachable when digests carry findings. Must be total:
// given `[]` it returns empty strings/arrays rather than throwing; the caller already
// guards on `allDigests.length > 0`, but this function must not itself be a trap.
export function assembleReport(digests: WorkerDigest[]): SubmittedReport {
  return {
    report: digests.map((d) => `## ${headingFor(d.subQuestion)}\n\n${d.summary}`).join('\n\n'),
    citations: digests.flatMap((d) =>
      d.findings.map((f) => ({ claim: f.claim, url: f.url, confidence: f.confidence })),
    ),
    sources: [...new Set(digests.flatMap((d) => d.sourcesRead))],
    unverified: digests.flatMap((d) => d.blockedSources),
  }
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
