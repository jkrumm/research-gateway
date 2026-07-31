// Dependency-free by design (only `schema.js`, which has no `env.js` import) so these
// pure helpers can be unit-tested without booting the whole env/LLM import chain. Mirrors
// the convention documented at the top of `assemble.ts`.

import type { SubmittedReport, WorkerDigest } from './schema.js'

// Collapse extraction padding (huge whitespace runs Readability/Tavily leave behind in
// table cells) without destroying document structure. This exact sequence was measured
// against a real failing page (mariadb.org/about/) to give a 54% size reduction while
// keeping table headers/values legible as readable runs.
// Normalized pages land ~46k chars / ~11.5k tokens (measured); worker maxContextTokens
// budgets are 40k-80k (see depth.ts), so 80k chars (~20k tokens) is affordable worst-case
// and covers whole pages instead of severing them mid-answer.
export const TEXT_CAP = 80_000

export function normalizeText(text: string): string {
  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Truncate to `cap` and, when truncation happens, append an honest, actionable notice
// with the real numbers involved. A bare `[truncated]` marker is indistinguishable from
// an unreachable source to a worker — this notice makes it explicit that only the
// remainder past `cap` is missing, not the whole page.
export function capText(text: string, cap: number): string {
  if (text.length <= cap) return text
  return (
    text.slice(0, cap) +
    `\n\n[truncated: showing the first ${cap} of ${text.length} characters of this page. The remainder was not included — if the information you need is not above, it may be further down this page.]`
  )
}

// ── Synthesis output guard ────────────────────────────────────────────────────
//
// Lives here (not in synthesize.ts) so it is unit-testable without booting the env/LLM
// import chain: synthesize.ts pulls in `lib/llm.js`, which reads `env.js` at import time
// and throws in an environment with no secrets — exactly the CI environment `bun test`
// runs in. `schema.js` has no such dependency, so this stays pure.

// A forced toolChoice on DeepSeek sometimes emits the schema literally instead of filling
// it in. Reject anything that looks like a schema echo rather than a real report.
export function isValidReport(report: SubmittedReport, digests: WorkerDigest[]): boolean {
  const text = report.report.trim()
  if (text.length < 200) return false
  if (text.toLowerCase() === 'string') return false
  const hasFindings = digests.some((d) => d.findings.length > 0)
  if (report.citations.length === 0 && hasFindings) return false
  return true
}

// A second, distinct failure mode on the same forced tool call: the model fills every
// schema field correctly (including `citations`/`sources`) AND ALSO serializes the whole
// submission as a JSON string into `report.report` — so the caller receives raw JSON
// where markdown belongs. `isValidReport` alone does not catch this: a double-encoded
// report is well over the length floor and carries real citations, so it reads as valid.
//
// Detection is deliberately conservative: it requires the WHOLE trimmed `report.report`
// string to parse as JSON, AND the parsed value to look like a submission (a `report`
// string alongside a `citations` or `sources` array) — not "starts with a brace" or
// "contains a fence". A legitimate markdown report that merely quotes a `{` or embeds a
// ```json code block fails `JSON.parse` on the whole string (there is prose around the
// brace) and is returned untouched.
export function unwrapDoubleEncodedReport(reportText: string): string | null {
  const trimmed = reportText.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null

  const obj = parsed as Record<string, unknown>
  const inner = obj['report']
  if (typeof inner !== 'string') return null
  const innerTrimmed = inner.trim()
  if (innerTrimmed.length === 0) return null

  const looksLikeSubmission = Array.isArray(obj['citations']) || Array.isArray(obj['sources'])
  if (!looksLikeSubmission) return null

  return innerTrimmed
}

// Unwraps a double-encoded report, keeping the OUTER `citations`/`sources`/`unverified`
// rather than the inner (parsed-from-string) copies. The outer fields already passed the
// tool call's own Zod validation against `SubmittedReport` — they are structured,
// type-checked data. The inner JSON blob is, at this point, still untyped free text lifted
// out of a string field; re-parsing IT into citation objects would mean trusting a second,
// unvalidated encoding of the same claims for no benefit, since the observed failure mode
// duplicates them exactly. Only the inner report TEXT is used — that is the one field
// genuinely missing from the outer submission.
//
// This does not need to defend the grounding invariant itself (no citation URL may also
// appear in `unverified`) — `groundReport` (ground.ts) re-derives citations/unverified
// from the retrieval ledger downstream of synthesis regardless of which path produced this
// object, so that invariant holds unconditionally.
export function salvageDoubleEncodedReport(report: SubmittedReport): SubmittedReport | null {
  const inner = unwrapDoubleEncodedReport(report.report)
  if (inner === null) return null
  return { ...report, report: inner }
}

export interface SynthesisResolution {
  report: SubmittedReport | null
  salvaged: boolean
}

// The single entry point for the synthesis output guard: adjudicates both known forced-
// toolChoice failure modes on one tool call.
//
// Detection of double-encoding runs UNCONDITIONALLY, ahead of `isValidReport` — that is
// what closes the gap, since a double-encoded report otherwise passes `isValidReport` on
// its own. Salvage is preferred over rejection: synthesis is the last and most expensive
// step of a job (minutes of worker fan-out), so discarding a submission over one redundant
// layer of JSON is a worse outcome for the caller than unwrapping it. Only when unwrapping
// does not yield a valid report does this fall through to the pre-existing rejection path,
// unchanged — so a normal clean report, and a genuine schema-echo, behave exactly as
// before.
export function resolveSynthesisReport(report: SubmittedReport, digests: WorkerDigest[]): SynthesisResolution {
  const salvaged = salvageDoubleEncodedReport(report)
  if (salvaged && isValidReport(salvaged, digests)) {
    return { report: salvaged, salvaged: true }
  }
  return { report: isValidReport(report, digests) ? report : null, salvaged: false }
}
