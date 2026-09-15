import type { Finding, Grounding, ResearchReport, SubmittedReport, WorkerDigest } from './schema.js'
import { normalizeUrl } from './ledger.js'
import type { RetrievalLedger, RetrievalTier } from './ledger.js'

// Grounding — the code-side gate between what a model CLAIMS it verified and what the run
// actually retrieved. Applied twice: at the worker boundary (findings, before they can
// contaminate the synthesis prompt) and at the job boundary (citations and the report
// body, before they reach the caller). See ledger.ts for why.
//
// Dependency-free by design (schema.js + ledger.js are both type/pure) so it is
// unit-testable without booting the env/LLM import chain.

type Confidence = Finding['confidence']

// Retrieval sets the CEILING; the model still sets the value beneath it. A model may
// judge a claim it read in full to be shaky and say `low` — that is information and is
// kept. It may not judge a claim it never retrieved to be `high`.
const CEILING: Record<Exclude<RetrievalTier, 'unseen' | 'failed'>, Confidence> = {
  retrieved: 'high',
  // A search snippet is ~1000 characters of provider-summarised page text. It is real
  // evidence, but it is not the page — it cannot carry a `high` assertion.
  snippet: 'medium',
}

const RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 }

function capConfidence(asserted: Confidence, ceiling: Confidence): Confidence {
  return RANK[asserted] > RANK[ceiling] ? ceiling : asserted
}

export interface GroundedClaims {
  kept: Finding[]
  dropped: Array<{ topic: string; url: string | null; reason: string }>
  cappedCount: number
}

// The single rule both boundaries share.
//
// - retrieved → citable, confidence capped at `high` (i.e. unchanged)
// - snippet   → citable, confidence capped at `medium`
// - failed    → NOT citable: the run tried to verify this page and could not
// - unseen    → NOT citable: no tool in this run ever returned this URL
//
// `ineligible` additionally hard-bans URLs the model itself listed as unverifiable, so a
// URL can never appear in both `unverified[]` and `citations[]` of the same response —
// the exact contradiction that made issue #1 dangerous.
export function groundClaims(
  claims: readonly Finding[],
  ledger: RetrievalLedger,
  ineligible: ReadonlySet<string> = new Set(),
): GroundedClaims {
  const kept: Finding[] = []
  const dropped: GroundedClaims['dropped'] = []
  let cappedCount = 0

  for (const claim of claims) {
    const tier = ledger.tierOf(claim.url)

    if (ineligible.has(claim.url)) {
      dropped.push({
        topic: claim.claim,
        url: claim.url,
        reason: 'Citation dropped: this run reported the same URL as unverifiable, so it cannot support a claim.',
      })
      continue
    }

    if (tier === 'failed') {
      const why = ledger.failureReason(claim.url) ?? 'fetch failed'
      dropped.push({
        topic: claim.claim,
        url: claim.url,
        reason: `Citation dropped: the page could not be retrieved (${why}), so this claim rests on no source.`,
      })
      continue
    }

    if (tier === 'unseen') {
      dropped.push({
        topic: claim.claim,
        url: claim.url,
        reason: 'Citation dropped: this URL was never retrieved in this run, so the claim is unsupported by evidence gathered here.',
      })
      continue
    }

    const capped = capConfidence(claim.confidence, CEILING[tier])
    if (capped !== claim.confidence) cappedCount++
    kept.push({ ...claim, confidence: capped })
  }

  return { kept, dropped, cappedCount }
}

// Worker boundary. Fabricated findings are stripped here rather than at the end, so the
// synthesis prompt never sees them — which keeps the invented claim out of the report
// PROSE too, not just out of the citation list.
export function groundDigest(digest: WorkerDigest, ledger: RetrievalLedger): WorkerDigest {
  const { kept, dropped } = groundClaims(digest.findings, ledger)

  // A digest whose every finding was ungrounded is a summary written from priors. Say so
  // in the summary itself: that text flows into the synthesis prompt and, via the
  // deterministic fallback in assemble.ts, straight into the caller's report.
  const lostEverything = digest.findings.length > 0 && kept.length === 0
  const summary = lostEverything
    ? `> **Unverified:** no source backing this section could be retrieved. Treat the following as unconfirmed.\n\n${digest.summary}`
    : digest.summary

  return {
    ...digest,
    summary,
    findings: kept,
    // Actually-read URLs, not the model's account of them.
    sourcesRead: ledger.retrievedUrls(),
    blockedSources: [...digest.blockedSources, ...dropped],
  }
}

function dedupeUnverified(
  entries: ReadonlyArray<{ topic: string; url: string | null; reason: string }>,
): Array<{ topic: string; url: string | null; reason: string }> {
  const seen = new Set<string>()
  const out: Array<{ topic: string; url: string | null; reason: string }> = []
  for (const entry of entries) {
    const key = `${entry.url ?? ''} ${entry.topic.trim().toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(entry)
  }
  return out
}

// A `partial` report is one where evidence was demonstrably lost. Prepending the banner to
// the markdown matters as much as the `status` field: a consuming agent that reads only the
// prose (every text-only MCP client does) must still see that the run degraded.
function banner(grounding: Grounding): string {
  const parts: string[] = []
  if (grounding.citationsDropped > 0) {
    parts.push(
      `${grounding.citationsDropped} claim(s) were dropped because the pages backing them could not be retrieved`,
    )
  }
  if (grounding.pagesRetrieved === 0) parts.push('no source page could be retrieved at all')
  else if (grounding.pagesFailed > grounding.pagesRetrieved) {
    parts.push(`${grounding.pagesFailed} page fetches failed against only ${grounding.pagesRetrieved} that succeeded`)
  }
  return `> **Partial result — evidence was lost during this run.** ${parts.join('; ')}. Anything below that is not backed by an entry in \`citations\` is unconfirmed; see \`unverified\` for what could not be checked.\n\n`
}

// Issue #7: the citation gate does not reach the report PROSE. A synthesizer can still name
// a blocked source in the body — a raw URL, a markdown link target, or a bare host — while
// listing it under `unverified`, and the structured gate has no say over that text. The
// 2026-08-06 Nunu/Blitz.gg run shipped exactly this shape (docs/field-notes.md). Prompt-only
// citation rules failed twice before the ledger existed; the body gets the same treatment
// as the citation list: enforced in code.
//
// Annotates rather than deletes: removing sentences would silently drop claims the caller
// paid for, so each disowned reference gets the run's own reason for distrusting it,
// inserted as a blockquote on top of the body (the partial-result banner, if any, is
// prepended after this and lands above the notes).
function hostOf(raw: string): string | null {
  try {
    return new URL(raw).host.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
}

function referencesBody(body: string, url: string): boolean {
  const literal = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // The URL itself, bare or as a markdown link target; both scheme-ful and scheme-less
  // forms, but never the tail of a longer token (`notblocked.example` must not match).
  const pathPart = literal.replace(/^https?:\/\//, '')
  const urlPattern = new RegExp(`(^|[^\\w/])(?:https?://)?${pathPart}`, 'i')
  // A bare-host mention ("per nunu.gg the ..."), only when the URL is host-parseable and
  // the host is a whole token — `sub.blocked.example` must not match `blocked.example`.
  const host = hostOf(url)
  const hostPattern = host
    ? new RegExp(`(^|[^\\w.-])${host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w.-])`, 'i')
    : null
  return urlPattern.test(body) || (hostPattern?.test(body) ?? false)
}

function scrubBody(
  body: string,
  unverified: ReadonlyArray<{ topic: string; url: string | null; reason: string }>,
): string {
  let notes = ''
  const seen = new Set<string>()
  for (const entry of unverified) {
    if (!entry.url || seen.has(entry.url)) continue
    seen.add(entry.url)
    if (!referencesBody(body, entry.url)) continue
    notes += `> **Unverified in prose:** this report references ${entry.url}, which this run could NOT verify (${entry.reason}). Treat that reference as unconfirmed — see \`unverified\`.\n\n`
  }
  return notes + body
}

// Job boundary. Takes the model's submission and returns the public report, with every
// citation checked against the ledger and every count derived in code.
// Returns everything except `cost`: grounding is about evidence, and this function has no
// visibility into what the run spent. run.ts owns that and completes the report.
export function groundReport(
  submitted: SubmittedReport,
  ledger: RetrievalLedger,
): Omit<ResearchReport, 'cost'> {
  // The model's own unverified list makes those URLs ineligible as citation sources —
  // independent of the ledger, so a failure mode the tools never observed still counts.
  //
  // EXCEPT where the ledger shows the page was retrieved anyway. One worker's fetchPage on
  // an npm page was rate-limited while another obtained the same page through packageInfo:
  // the model dutifully logged the failed attempt, and that bookkeeping then deleted three
  // correct, fully-grounded citations. A failed ATTEMPT is not a failure to obtain the
  // content. Hard evidence that the page was read outranks the model's account of its work
  // — in this direction only, since the model can never talk a page INTO being retrieved.
  const ineligible = new Set(
    submitted.unverified
      .map((u) => u.url)
      .filter((url): url is string => typeof url === 'string' && url.length > 0)
      .filter((url) => ledger.tierOf(url) !== 'retrieved'),
  )

  const { kept, dropped, cappedCount } = groundClaims(submitted.citations, ledger, ineligible)
  const snap = ledger.snapshot()

  const grounding: Grounding = {
    pagesRetrieved: snap.retrieved.length,
    pagesFailed: snap.failed.length,
    citationsKept: kept.length,
    citationsDropped: dropped.length,
    confidenceCapped: cappedCount,
  }

  // Keep the invariant total: a URL that survived into `citations` must not also sit in
  // `unverified` claiming to be an unusable source. Where the ledger vindicated the page,
  // the entry is kept (its TOPIC may genuinely be unverified) but detached from the URL, so
  // the transparency note survives without contradicting the citation next to it.
  const cited = new Set(kept.map((c) => normalizeUrl(c.url)))
  const unverified = dedupeUnverified([...submitted.unverified, ...dropped]).map((entry) => {
    if (!entry.url || !cited.has(normalizeUrl(entry.url))) return entry
    return {
      ...entry,
      url: null,
      reason: `${entry.reason} (The page itself WAS retrieved elsewhere in this run and does support citations — this entry records an unverified topic, not an unusable source.)`,
    }
  })

  const degraded =
    grounding.citationsDropped > 0 ||
    grounding.pagesRetrieved === 0 ||
    grounding.pagesFailed > grounding.pagesRetrieved

  // The prose is scrubbed against the FINAL unverified set: an entry whose URL was
  // vindicated by the ledger is detached above precisely so it can support citations —
  // flagging mentions of it in the body would contradict the citation next to it.
  const reportBody = scrubBody(submitted.report, unverified)

  const warnings: string[] = []
  if (grounding.citationsDropped > 0) {
    warnings.push(
      `${grounding.citationsDropped} citation(s) were removed: their URLs were never retrieved in this run or their fetch failed.`,
    )
  }
  if (grounding.confidenceCapped > 0) {
    warnings.push(
      `${grounding.confidenceCapped} citation(s) had their confidence lowered to match the evidence actually retrieved.`,
    )
  }
  if (grounding.pagesRetrieved === 0) {
    warnings.push('No source page was successfully retrieved — this report rests on search snippets at best.')
  }
  if (grounding.pagesFailed > 0) {
    warnings.push(`${grounding.pagesFailed} page fetch(es) failed during this run.`)
  }

  // Sources are the pages actually read — never the model's account of them. Falls back to
  // the submitted list only when the ledger is empty (a run that produced no fetch at all).
  const sources = snap.retrieved.length > 0 ? snap.retrieved : submitted.sources

  return {
    ...submitted,
    report: degraded ? banner(grounding) + reportBody : reportBody,
    citations: kept,
    sources,
    unverified,
    status: degraded ? 'partial' : 'ok',
    warnings,
    grounding,
  }
}
