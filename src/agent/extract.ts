// Dependency-free by design (only `schema.js`, which has no `env.js` import) so these
// pure helpers can be unit-tested without booting the whole env/LLM import chain. Mirrors
// the convention documented at the top of `assemble.ts`.

import type { ConsistencyReview, SubmittedReport, WorkerDigest } from './schema.js'

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

// ── Consistency-review adjudication (issue #5) ────────────────────────────────
//
// Same home as the synthesis guard, for the same reason: synthesize.ts's sibling (the review
// pass in consistency.ts) pulls in `lib/llm.js`, so its import chain boots env.js — these
// pure helpers must stay testable without secrets.

export interface ConsistencyResolution {
  // The report text to carry forward — the text with the reviewer's spans applied when the
  // edit set was accepted, otherwise the original untouched.
  report: string
  // True only when the reviewer's edit set was accepted and applied. Drives the
  // `consistency.outcome` span attribute, the `research.consistency_gate` span, and the
  // report's own warning line.
  corrected: boolean
}

// Defensive cap on the reviewer's edit count. A consistency pass has no plausible use for
// more than a handful of spans — a body with twenty distinct self-contradictions is a
// synthesis failure, not something a review pass should be rewriting wholesale. The schema
// enforces the same bound; this guards the resolver against callers that bypass it.
const MAX_EDITS = 20

// Growth bound. A contradiction fix rewords a sentence, it does not write paragraphs: any
// single span more than doubling its own size, or the whole body growing by more than a
// quarter of its original length, is editorializing (or padding) and refuses the set. The
// old whole-body contract needed a hard floor because it replaced everything; spans make
// gross-size surgery unreachable, so this only has to bound the residual latitude.
const MAX_SPAN_GROWTH = 2
const MAX_TOTAL_GROWTH = 1.25

// Extracts every URL appearing anywhere in a report body (markdown links, bare URLs,
// autolinks), for the citation-preservation check below. Deliberately loose — it must not
// miss a URL the prose carried, because missing one makes an edit set that deleted it look
// citation-clean.
const URL_RE = /https?:\/\/[^\s<>()\[\]{}"'`]+/g

function urlsIn(text: string): Set<string> {
  return new Set(text.match(URL_RE) ?? [])
}

// Adjudicates the consistency reviewer's submission against the report it reviewed. The
// reviewer contributes find/replace SPANS, applied here by exact match — it never re-authors
// the body, so the whole-report swap a length floor cannot see is structurally impossible.
// The edit set is all-or-nothing: if ANY span fails to apply, NONE is applied and the
// original continues unchanged. Partial application could resolve one contradiction while
// introducing a fresh one, and the caller cannot tell which spans landed — so a set that
// cannot be applied cleanly in full is treated as a failed review, not a half-success.
//
// A span is refused when its `find` anchor is absent from the (working) text, occurs more
// than once (ambiguous — splicing could rewrite the wrong occurrence), is a no-op
// (`find === replace`), or when applying the whole set would change the set of URLs carried
// in the prose (citations and their references must survive the review untouched — the
// reviewer's license is resolving self-contradictions, not re-sourcing the report).
//
// Anything else — no tool call, malformed args, an echoed verdict, an over-large edit set —
// falls back to the original text: a flawed report that reaches the caller beats no report.
// This does not defend the grounding invariant itself — citations are untouched here and
// groundReport re-derives everything downstream regardless.
export function resolveConsistencyReview(
  original: string,
  review: ConsistencyReview | null,
): ConsistencyResolution {
  if (!review || review.consistent) return { report: original, corrected: false }

  const edits = review.edits ?? []
  if (edits.length === 0 || edits.length > MAX_EDITS) {
    return { report: original, corrected: false }
  }

  const sourceUrls = urlsIn(original)
  let working = original
  for (const edit of edits) {
    // The anchor must occur EXACTLY once in the CURRENT working text, not the original:
    // an earlier span's replacement may legitimately have consumed or created later
    // anchors. Sequential application against working text is the contract the prompt
    // describes. Spliced by hand rather than via String.replace so `$&`-style patterns in
    // a replacement are never interpreted — report prose can legitimately contain them.
    const first = working.indexOf(edit.find)
    if (first === -1 || working.indexOf(edit.find, first + 1) !== -1) {
      return { report: original, corrected: false }
    }
    if (edit.find === edit.replace) return { report: original, corrected: false }
    if (edit.replace.length > edit.find.length * MAX_SPAN_GROWTH) {
      return { report: original, corrected: false }
    }
    working = working.slice(0, first) + edit.replace + working.slice(first + edit.find.length)
  }

  if (working.length > original.length * MAX_TOTAL_GROWTH) {
    return { report: original, corrected: false }
  }

  // Citation preservation: the set of URLs in the prose must be identical after the edits.
  // A reviewer may not re-source the report — dropping a URL strips a citation reference,
  // adding one invents evidence the run never retrieved.
  const resultUrls = urlsIn(working)
  if (resultUrls.size !== sourceUrls.size) return { report: original, corrected: false }
  for (const url of sourceUrls) {
    if (!resultUrls.has(url)) return { report: original, corrected: false }
  }

  return { report: working, corrected: true }
}
