// Dependency-free by design (only `schema.js`, which has no `env.js` import) so these
// pure helpers can be unit-tested without booting the whole env/LLM import chain. Mirrors
// the convention documented at the top of `assemble.ts`.

import { MAX_EDITS } from './schema.js'
import type { ConsistencyEdit, ConsistencyReview, SubmittedReport, WorkerDigest } from './schema.js'
import type { UsageStats } from '../lib/usage.js'

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
  // The find/replace pairs that were applied, and how many, so an accepted edit is never
  // silent: the caller emits them on the research.consistency span and the consistency.done
  // log (both empty/0 whenever `corrected` is false).
  appliedEdits: ConsistencyEdit[]
  // True when the edit set was refused because it moved, split, deleted or invented a
  // citation-bearing token (marker, label, URL) rather than failing to apply — a distinct
  // outcome from a clean review or a clean correction, so traces can tell "the reviewer
  // tried to touch a citation" from "nothing needed changing".
  vetoed: boolean
}

// Defensive cap on the reviewer's edit count. A consistency pass has no plausible use for
// more than a handful of spans — a body with twenty distinct self-contradictions is a
// synthesis failure, not something a review pass should be rewriting wholesale. The schema
// enforces the same bound (MAX_EDITS is defined there and imported above); this guards the
// resolver against callers that bypass it.

// Growth bound. A contradiction fix rewords a sentence, it does not write paragraphs: any
// single span more than doubling its own size, or the whole body growing by more than a
// quarter of its original length, is editorializing (or padding) and refuses the set. The
// old whole-body contract needed a hard floor because it replaced everything; spans make
// gross-size surgery unreachable, so this only has to bound the residual latitude.
const MAX_SPAN_GROWTH = 2
const MAX_TOTAL_GROWTH = 1.25

// Anchor bound, measured against the ORIGINAL text — the growth bounds above cap how much
// a span may ADD, but nothing bounded how much a span may COVER, so a single edit whose
// `find` is the entire body passed every check and re-authored the report wholesale
// (measured at 49fd3e60: a 317-char body replaced end to end, `corrected: true`). A
// legitimate anchor is a contradiction's span plus enough surrounding text to be unique —
// never a meaningful fraction of the body. Two caps, both enforced:
//   per-span  `find.length <= min(1200, 0.25 × original length)` — closes the single-anchor
//             door; 1200 chars is generous headroom over any real contradiction, and the
//             25%-of-body term keeps the door closed on short bodies where 1200 alone
//             would re-open it (no absolute floor — a floor on short bodies re-opens the
//             hole, and over-rejection there degrades benignly to the original);
//   whole-set `Σ find.length <= 0.35 × original length` — closes the chunked-reassembly
//             door, where N individually-small spans jointly cover the body. 35% stays
//             clear of the sum four legitimate 25%-bound spans could theoretically reach
//             while still allowing several real fixes per pass.
const MAX_ANCHOR_CHARS = 1200
const MAX_ANCHOR_COVERAGE = 0.25
const MAX_SET_COVERAGE = 0.35

// Extracts every citation-bearing token appearing anywhere in a report body, in document
// order, with its [start, end) range, for the citation-preservation checks in
// resolveConsistencyReview. This is the ONE matcher behind both defenses — the categorical
// span-intersection refusal and the ordered sequence comparison — so a marker class added
// here is protected by both layers at once, and no second, looser pattern can re-open a
// closed hole.
//
// Token classes (every shape a markdown citation reference can take in report prose):
//   bare/inline URLs        — https?:// runs, paren-aware: balanced parens stay inside the
//                             token (Wikipedia's Foo_(bar)); trailing ')' is peeled while it
//                             outnumbers '(' so a prose paren after a URL is not swallowed;
//                             a trailing ',' rides along — deterministic on both sides of
//                             the comparison, and refusing punctuation reshaping is the safe
//                             direction;
//   autolinks               — <https://…>;
//   markdown destinations   — the url half of ](url) links;
//   reference definitions   — [label]: url lines;
//   footnote/reference uses — [^x] and [n] (digits) markers;
//   label uses              — [label] brackets that are not a definition colon and not one
//                             of the shapes above — census-style tags and wikilink-ish
//                             labels, which report prose legitimately carries.
//
// Ordered by start; nested/overlapping shapes cannot occur (a URL inside a label cannot
// contain ']' by construction — the label body excludes ']').
const URL_RE = /https?:\/\/[^\s<>\[\]{}"'`]+/g

export interface CitationToken {
  start: number
  end: number
  // The byte-for-byte token text. URLs are the trimmed match; label/marker tokens carry
  // their brackets so a swap of label contents is a different token.
  text: string
}

export function citationTokensIn(text: string): CitationToken[] {
  const out: CitationToken[] = []

  // URLs first — a URL can contain ']'? No ([^\[\]...] excludes it), but a bare URL inside
  // a ]( ) destination or a definition line is the SAME url token either way, and a URL
  // inside [label](url) sits outside the label token, so collecting every URL match first
  // and letting the bracket scans skip URL-covered spans keeps each URL exactly one token.
  const urlSpans: Array<{ start: number; end: number; text: string }> = []
  let m: RegExpExecArray | null
  while ((m = URL_RE.exec(text)) !== null) {
    let url = m[0]
    while (url.endsWith(')')) {
      const opens = (url.match(/\(/g) ?? []).length
      const closes = (url.match(/\)/g) ?? []).length
      if (closes <= opens) break
      url = url.slice(0, -1)
    }
    if (url) urlSpans.push({ start: m.index, end: m.index + url.length, text: url })
  }

  const urlAt = (start: number, end: number): boolean =>
    urlSpans.some((u) => start < u.end && u.start < end)

  // Markdown link destinations: ](url) — the url half only, the label half is a label
  // token below. Skipped when the destination is itself inside a URL span (cannot happen
  // for a scheme-complete URL, but the check costs nothing and keeps one-url-one-token).
  const DEST_RE = /\]\((https?:\/\/[^\s)]*)\)/g
  while ((m = DEST_RE.exec(text)) !== null) {
    const start = m.index + 2
    const end = start + m[1]!.length
    if (!urlAt(start, end)) out.push({ start, end, text: m[1]! })
  }

  // Reference definitions: [label]: url — label AND url are both protected (the label is
  // what a [label] use resolves to; moving the line or rewording its label re-points every
  // use of it).
  const DEF_RE = /\[([^\[\]]+)\]:[ \t]*(\S[^\s]*)/g
  while ((m = DEF_RE.exec(text)) !== null) {
    const label = { start: m.index, end: m.index + 1 + m[1]!.length + 1, text: `[${m[1]!}]` }
    const urlStart = m.index + m[0].indexOf(m[2]!, m[1]!.length + 2)
    const urlEnd = urlStart + m[2]!.length
    if (!urlAt(label.start, label.end)) out.push(label)
    if (!urlAt(urlStart, urlEnd)) out.push({ start: urlStart, end: urlEnd, text: m[2]! })
  }

  // Footnote / numeric reference uses: [^x] and [1]. The body excludes '[' so nested
  // markers cannot confuse the scan; inside a URL they cannot occur (URLs exclude '[').
  // Skips a bracket already emitted as a definition label — a definition's label is ALSO a
  // bracket match, so without this the definition line would carry the label token twice
  // (harmless for the veto, which only asks "any token here", but it would double-count
  // the token in the sequence comparison and refuse every clean report with a definition).
  const MARKER_RE = /\[\^?[^\[\]\s]+\]/g
  while ((m = MARKER_RE.exec(text)) !== null) {
    const start = m.index
    const end = m.index + m[0].length
    if (urlAt(start, end)) continue
    if (out.some((t) => t.start === start && t.end === end)) continue
    out.push({ start, end, text: m[0] })
  }

  // Remaining label uses: [label] not consumed above. Anything MARKER_RE already took is
  // excluded by shape (a marker is [^…]/[digits]; a label here is the rest) — but a label
  // token must not double-cover a marker, so re-scan and skip URL/def/marker overlaps by
  // position. A label body may not contain ']' or start a definition, and must not be
  // empty or whitespace-only.
  const LABEL_RE = /\[([^\[\]]+)\]/g
  while ((m = LABEL_RE.exec(text)) !== null) {
    const start = m.index
    const end = m.index + m[0].length
    if (urlAt(start, end)) continue
    // Definitions were handled above (their ':' follows the bracket); markers are a subset
    // of this pattern too — both are already in `out`, so skip those exact positions.
    const already = out.some((t) => t.start === start && t.end === end)
    if (already) continue
    out.push({ start, end, text: m[0] })
  }

  out.push(...urlSpans)
  return out.sort((a, b) => a.start - b.start || a.end - b.end)
}

// Whether a span string carries a citation-bearing token at all — the categorical rule.
// Delegates to the one extractor so the categorical rule and the sequence comparison share
// a single grammar; a second, looser pattern here would re-open exactly the holes the
// grammar closes. (Sharing the global regexes across calls is safe: every exec loop above
// runs to completion, which resets lastIndex — the hazard that bans .test() on them.)
function touchesCitation(text: string): boolean {
  return citationTokensIn(text).length > 0
}

// Ordered list of citation-token texts — the sequence the citation-preservation backstop
// compares byte for byte.
function citationSequence(text: string): string[] {
  return citationTokensIn(text).map((t) => t.text)
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
// (`find === replace`), is over-large for the body it is editing (see the anchor bounds
// above), or when either end of the span intersects a citation-bearing token
// (touchesCitation — categorical; see the token grammar above: prompt.ts already promises
// the reviewer that citations and their markdown references survive the review exactly as
// given; this enforces that promise in code, per the repo rule that citation guarantees
// never live in a prompt alone).
//
// Three defenses stand between an edit set and the report, each covering a hole the
// previous one leaves, and all three now run on ONE token grammar (citationTokensIn):
//   1. bounded local spans — the anchor/growth caps above keep every edit a sentence-scale
//      rewording, never a wholesale re-authoring;
//   2. no span intersects a citation token — the categorical refusal means a span can
//      neither carry a reference across, cut one out, nor straddle one at its boundary
//      (a boundary-split token sits inside the span's [start, end) range and is caught
//      even when the span text itself carries no complete marker);
//   3. citation-token sequence byte-identical in order and count — the element-wise
//      comparison below is the backstop for what 1 and 2 leave: a token created at a
//      splice seam (a replace ending in `https:` before prose `//host`) or split across
//      two cooperating spans whose texts are individually token-free.
//
// The accepted residual: claim-to-citation pairing inside a reworded span is deliberately
// undefended — a span may reword the prose that surrounds a citation, and prose is what
// carries the pairing, so which claim a reference supports can drift. Defending it would
// mean refusing nearly every legitimate edit; the reviewer's prompt-side rules are the
// defense of record there.
//
// Anything else — no tool call, malformed args, an echoed verdict, an over-large edit set —
// falls back to the original text: a flawed report that reaches the caller beats no report.
// This does not defend the grounding invariant itself — citations are untouched here and
// groundReport re-derives everything downstream regardless.
export function resolveConsistencyReview(
  original: string,
  review: ConsistencyReview | null,
): ConsistencyResolution {
  if (!review || review.consistent)
    return { report: original, corrected: false, appliedEdits: [], vetoed: false }

  const edits = review.edits ?? []
  if (edits.length === 0 || edits.length > MAX_EDITS) {
    return { report: original, corrected: false, appliedEdits: [], vetoed: false }
  }

  // Both anchor caps measure against the ORIGINAL, before any span applies — coverage is a
  // property of the text under review, not of the half-edited working copy.
  const maxAnchor = Math.min(MAX_ANCHOR_CHARS, MAX_ANCHOR_COVERAGE * original.length)
  const maxSet = MAX_SET_COVERAGE * original.length
  let setAnchorChars = 0

  // The citation-token SEQUENCE of the original text, for the backstop comparison below.
  const sourceTokens = citationTokensIn(original)

  let working = original
  const appliedEdits: ConsistencyEdit[] = []

  for (const edit of edits) {
    if (edit.find.length > maxAnchor) return { report: original, corrected: false, appliedEdits: [], vetoed: false }
    setAnchorChars += edit.find.length
    if (setAnchorChars > maxSet) return { report: original, corrected: false, appliedEdits: [], vetoed: false }

    // The anchor must occur EXACTLY once in the CURRENT working text, not the original:
    // an earlier span's replacement may legitimately have consumed or created later
    // anchors. Sequential application against working text is the contract the prompt
    // describes. Spliced by hand rather than via String.replace so `$&`-style patterns in
    // a replacement are never interpreted — report prose can legitimately contain them.
    const first = working.indexOf(edit.find)
    if (first === -1 || working.indexOf(edit.find, first + 1) !== -1) {
      return { report: original, corrected: false, appliedEdits: [], vetoed: false }
    }

    // Categorical citation refusal: a span whose find or replace intersects a
    // citation-bearing token is refused outright, whichever direction it would move the
    // count in. Range-based against the CURRENT working text, not a text scan of the span
    // alone — a span whose boundary slices a marker (find `census-2021]`, replace
    // `census-2011]`) carries no complete token in its own text, so only its position
    // gives it away. Runs after the uniqueness check so a set refused for ambiguity is
    // never misattributed to a citation veto. Repaired at the span boundary rather than
    // after application because the sequence comparison below sees only the net result
    // (measured at b8fbddd3).
    const anchorEnd = first + edit.find.length
    const workingTokens = citationTokensIn(working)
    const intersects = workingTokens.some((t) => first < t.end && t.start < anchorEnd)
    if (intersects || touchesCitation(edit.find) || touchesCitation(edit.replace)) {
      return { report: original, corrected: false, appliedEdits: [], vetoed: true }
    }

    if (edit.find === edit.replace)
      return { report: original, corrected: false, appliedEdits: [], vetoed: false }
    if (edit.replace.length > edit.find.length * MAX_SPAN_GROWTH) {
      return { report: original, corrected: false, appliedEdits: [], vetoed: false }
    }
    working = working.slice(0, first) + edit.replace + working.slice(first + edit.find.length)
    appliedEdits.push(edit)
  }

  if (working.length > original.length * MAX_TOTAL_GROWTH) {
    return { report: original, corrected: false, appliedEdits: [], vetoed: false }
  }

  // Citation preservation, backstop layer (defense 3 in the doc comment above): the
  // citation-token SEQUENCE in the prose must be byte-identical, in order and count, after
  // the edits. Element-wise against the ordered arrays — not Set membership, which discards
  // exactly the shapes the categorical span check cannot see (drop-one-occurrence, swap,
  // and any token born at a splice seam: a replace ending in `https:` ahead of prose
  // `//host` fabricates a URL token with no URL inside either span's own text).
  const resultTokens = citationSequence(working)
  if (
    resultTokens.length !== sourceTokens.length ||
    resultTokens.some((token, i) => token !== sourceTokens[i]?.text)
  ) {
    return { report: original, corrected: false, appliedEdits: [], vetoed: true }
  }

  return { report: working, corrected: true, appliedEdits, vetoed: false }
}

// ── Consistency-gate bookkeeping (issue #16 follow-up) ────────────────────────
//
// The gate-time bookkeeping run.ts does around the consistency pass — the lead-usage fold
// and the corrected/edits bookkeeping — factored out of run.ts so it is unit-testable here,
// env-free like everything else in this module (run.ts's own import chain boots env.js;
// run.test.ts's convention imports these helpers instead). Pure: takes the pieces, returns
// the pieces — no env, no span, no logger.
//
// The consistency WARNING itself is NOT merged here: the gate runs before groundReport, so
// grounded.warnings does not exist yet and appending the consistency line now would drop the
// evidence warnings at report assembly. run.ts merges CONSISTENCY_WARNING into
// grounded.warnings after grounding, exactly as it did before this helper existed.
//
// UsageStats comes in as a type-only import and the fold is inlined field-by-field, same
// as round.ts: lib/usage.js re-exports from a module that imports env.js at the top, and
// pulling that in would silently break this module's env-free premise.

// The warning run.ts appends to the public report when the review pass rewrote the body —
// so a caller learns the prose it is reading is a second draft. Lives beside the resolver
// so the text and the condition that triggers it cannot drift apart.
export const CONSISTENCY_WARNING =
  'An internal-consistency review found self-contradictions in the report prose and rewrote the affected passages; the citations were not changed by that pass.'

export interface ConsistencyGateResult {
  corrected: boolean
  // Applied span count — zeroed when corrected is false, so corrected:true with zero
  // details is never indistinguishable from a silent rewrite in a trace.
  edits: number
  // True when the review was refused for moving, splitting, deleting or inventing a
  // citation-bearing token — distinct from a clean review or a clean correction so a trace
  // can show the reviewer overstepped onto citations.
  vetoed: boolean
  // The lead bucket with the review pass's usage folded in.
  leadUsage: UsageStats
}

export function applyConsistencyGate(args: {
  // What the review pass returned (the awaited result of reviewConsistency). The report
  // text is not carried here — the resolver returns the original untouched on every
  // rejection path, so review.report is always the text to carry forward.
  review: Pick<ConsistencyResolution, 'corrected' | 'appliedEdits' | 'vetoed'> & { usage: UsageStats }
  // The lead bucket accumulated so far (plan + synthesis), before this pass.
  leadUsage: UsageStats
}): ConsistencyGateResult {
  const { review, leadUsage } = args
  const u = review.usage
  return {
    corrected: review.corrected,
    edits: review.corrected ? review.appliedEdits.length : 0,
    vetoed: review.vetoed,
    leadUsage: {
      inputTokens: leadUsage.inputTokens + u.inputTokens,
      outputTokens: leadUsage.outputTokens + u.outputTokens,
      totalTokens: leadUsage.totalTokens + u.totalTokens,
      reasoningTokens: leadUsage.reasoningTokens + u.reasoningTokens,
      cachedInputTokens: leadUsage.cachedInputTokens + u.cachedInputTokens,
      durationMs: leadUsage.durationMs + u.durationMs,
      reportedCostUsd: leadUsage.reportedCostUsd + u.reportedCostUsd,
      unreportedCalls: leadUsage.unreportedCalls + u.unreportedCalls,
    },
  }
}
