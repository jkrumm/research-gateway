import type { Finding, Grounding, ResearchReport, SubmittedReport, WorkerDigest } from './schema.js'
import { normalizeUrl } from './ledger.js'
import type { RetrievalLedger, RetrievalTier } from './ledger.js'

// Grounding — the code-side gate between what a model CLAIMS it verified and what the run
// actually retrieved. Applied twice: at the worker boundary (findings, before they can
// contaminate the synthesis prompt) and at the job boundary (citations, before they reach
// the caller). See ledger.ts for why.
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
  // The one tier that can carry a POSITIVE absence claim: the origin itself answered
  // 404/410. Anything else a page contains is evidence about that page, not proof the
  // resource is gone (issue #3: a sparse Wayback CDX listing is a retrieved page, and a
  // thin one proves nothing about the live resource).
  missing: 'high',
}

// Absence claims — "X does not exist", "X is unavailable", "X is down" — are the one kind
// of claim where a successfully retrieved page can be WORSE than no page: the 2026-08-06
// deep run (docs/field-notes.md) shipped two false `high` negatives, each citing a page it
// really did retrieve (a sparse Wayback CDX listing, a revision timestamp) and reasoning
// from that page's emptiness to a claim about the world. This is a lexical gate, kept in
// code on purpose: prompt-only citation rules did not hold twice before the ledger existed.
//
// Deliberately narrow on the verb side: negation + support|include|have|work|… read every
// feature-negation sentence ("does not support async iteration") as absence and demoted
// correct facts. Only existence/reachability verbs qualify, past-tense removal phrasings
// ("was removed from npm") get their own branch, and copula-negated state keeps the
// contractions ("isn't available") the literal "not X" branch misses. Over-matching is the
// safe direction — the gate only ever CAPS confidence — but a miss lets a false negative
// ride at `high`, which is exactly the issue #3 failure.
const ABSENCE_RE =
  /\b(?:does\s+not|doesn't|do\s+not|don't|did\s+not|didn't|is\s+not|isn't|are\s+not|aren't|was\s+not|wasn't|cannot|can't|no\s+longer|never)\s+(?:exists?|hosts?|serves?|resolves?|responds?|appears?|be)\b|\b(?:was|were)\s+(?:removed|shut\s+down|retired|deprecated)\b|\b(?:no|not\s+any)\s+(?:such\s+)?(?:page|site|host|server|resource|record|snapshot|listing|entry|release|tag|package|module|file|repo(?:sitory)?|data\s+source|endpoint)s?\b|\bnot\s+(?:found|available|accessible|reachable|live|online|public|hosted)\b|\b(?:isn't|aren't|wasn't|weren't|no\s+longer)\s+(?:available|accessible|reachable|hosted|live|online|offline)\b|\b(?:unavailable|offline|nonexistent|non-existent|doesn't\s+exist|does\s+not\s+exist|decommissioned|geo-?restricted)\b/i

export function isAbsenceClaim(claim: string): boolean {
  return ABSENCE_RE.test(claim)
}

const RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 }

function capConfidence(asserted: Confidence, ceiling: Confidence): Confidence {
  return RANK[asserted] > RANK[ceiling] ? ceiling : asserted
}

export interface GroundedClaims {
  kept: Finding[]
  dropped: Array<{ topic: string; url: string | null; reason: string }>
  // Indices into `kept` of the claims whose confidence this gate lowered — held as
  // positions, not a count, so the job boundary can union them with the subject-degrade
  // pass's indices and never double-count a claim that was capped here and degraded there.
  capped: ReadonlySet<number>
}

// The single rule both boundaries share.
//
// - retrieved → citable, confidence capped at `high` (i.e. unchanged) — except an
//   absence claim (see ABSENCE_RE), which caps at `medium`: a retrieved page proves what
//   the page says, not that the thing it failed to show does not exist
// - missing   → citable, up to `high`: the origin answered 404/410, the one code-verifiable
//   basis for a negative claim (response-kind.ts)
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
  const capped = new Set<number>()

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
      // Issue #3: the failure mode is not the dropped citation — the existing gate already
      // handles that — but the claim text riding next to a DIFFERENT, retrieved citation.
      // An absence claim whose supporting page could not be fetched must not survive as a
      // positive assertion somewhere else in the report.
      const why = ledger.failureReason(claim.url) ?? 'fetch failed'
      dropped.push({
        topic: claim.claim,
        url: claim.url,
        reason: isAbsenceClaim(claim.claim)
          ? `Citation dropped: the page could not be retrieved (${why}), and a fetch failure never proves absence — restate as unverifiable, not as a fact about the resource.`
          : `Citation dropped: the page could not be retrieved (${why}), so this claim rests on no source.`,
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

    // The origin itself answered 404/410. That answer IS evidence — but only of absence.
    // An absence claim may cite it at `high` (the one code-verifiable basis for a negative,
    // response-kind.ts); any positive claim about a resource that does not exist is dropped.
    if (tier === 'missing') {
      if (isAbsenceClaim(claim.claim)) {
        kept.push({ ...claim, confidence: capConfidence(claim.confidence, CEILING.missing) })
      } else {
        dropped.push({
          topic: claim.claim,
          url: claim.url,
          reason: 'Citation dropped: the origin answered 404/410 for this URL, so the resource does not exist and cannot support a claim about its content.',
        })
      }
      continue
    }

    // Absence claims rest on the strongest retrieval available to them. A page that WAS
    // read may genuinely establish absence (a 404 probe logged in prose, a registry's own
    // "not found" payload), so it stays citable — but a negative assertion is exactly what
    // a thin or second-hand page must not carry at `high`.
    let ceiling: Confidence = CEILING[tier]
    if (isAbsenceClaim(claim.claim)) ceiling = 'medium'

    const cappedClaim = capConfidence(claim.confidence, ceiling)
    if (cappedClaim !== claim.confidence) capped.add(kept.length)
    kept.push({ ...claim, confidence: cappedClaim })
  }

  return { kept, dropped, capped }
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

// ── Issue #4: a claim sourced from an `unverified` document must degrade with it ─────
//
// The URL rules above only catch a claim that cites the blocked URL ITSELF. The 2026-08-06
// deep run shipped "this wiki module is stale" at `high` confidence while the same report's
// `unverified` block said the module was "too large to fetch — 121 KB" — the claim cited a
// sibling host's revision timestamp, so every gate passed. Detection therefore has to be
// textual: a citation whose claim names the subject of an `unverified` entry cannot rest on
// evidence this run never had, whatever URL it points at.
//
// The heuristic is deliberately conservative: a claim matches a subject when it shares
// enough distinctive tokens (≥3 chars, not in NON_DISTINCTIVE) with the entry's topic or URL
// path. One shared token is how every claim in an Immich report mentions Immich.
//
// "Enough" scales with the subject. It used to be a flat ≥2, written for short topics
// ("Module:Items wiki page"). The current model writes long, ENUMERATING `unverified` topics
// with `url: null` — e.g. "Cross-project citation-grounding mechanics … for GPT Researcher,
// STORM, smolagents, Jina, dzhng, Together and Tongyi" (30 distinctive tokens) — and any claim
// naming two of the enumerated projects matched. A flat floor cannot tell a subject from a
// list of subjects; a coverage ratio can. The threshold is `max(2, ceil(subject.size / 3))`,
// so a short subject behaves exactly as before (≥2 shared) and a 30-token enumeration needs
// ~10. Measured 2026-09-23..25: 148/182, 30/37 and 16/38 citations capped in three live jobs,
// every one correctly retrieved (docs/architecture-review-2026-09.md §2b).
//
// The action is a cap to `low`, not a drop — a wrong cap makes a report cautious, a wrong
// drop loses a possibly-correct claim (the 2026-07-31 npm regression in miniature). Misses
// stay possible — a prose claim citing nothing is invisible to any citation-side rule —
// which is why the synthesis prompt carries the auxiliary rule against them. A cap alone is
// not lost evidence: it keeps its warning line and no longer flips `status` (see
// `degradedRun`).

const NON_DISTINCTIVE = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'official', 'page', 'site',
  'docs', 'documentation', 'http', 'https', 'www', 'com', 'org', 'net',
])

function distinctiveTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !NON_DISTINCTIVE.has(t)),
  )
}

// Subject of an unverified entry: its topic plus the URL PATH. The host is stripped — it
// locates the document, the path usually names it: `/Module:Items` is the subject,
// `immich.app` is not.
function subjectTokens(entry: { topic: string; url: string | null }): Set<string> {
  const path = entry.url?.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*\/?/, '') ?? ''
  return distinctiveTokens(`${entry.topic} ${path}`)
}

// ── 2026-09-25: the cap has to find the DOCUMENT, not the vocabulary ─────────────────
//
// The coverage ratio above still capped 61 of 88 retrieved citations in one deep Wild Rift
// job (and 8-23 in four others) because the subjects there are SHORT — "Bilibili build/rune
// guide videos for Patch 7.3" — and made of the report's own domain vocabulary: any claim
// saying "build" and "patch" covered it. And a subject with a URL capped claims that merely
// shared its topic words while citing a different, retrieved page — "Luden's Echo" claims
// from Riot's patch notes, capped by an unread Liquipedia page about Luden's Echo. Three
// rules, measured against the five 2026-09-25 jobs (61→5, 19→6, 9→1, 8→0, 22→11), with
// every remaining cap one that names the unread document or cites a mirror of it:
//
// 1. Vocabulary is not a subject. A token found in ≥20% of the report's claims and
//    unverified subjects (at least 3 of them) is the report's domain, not a document's name,
//    and does not count toward a match. Tiny reports (every unit fixture) have no such token.
// 2. A subject WITH a URL is a document. A claim rests on it only when (a) its cited URL is
//    another copy of that document — the path's distinctive tokens all reappear in it (a
//    mirror, `r.jina.ai/<url>`, an `?action=raw` variant: issue #4's own incident), or (b) it
//    cites the same host or names the site, AND names part of the document's path its own
//    cited page does not cover. A retrieved page on the same host about a different subject
//    is its own evidence (the WildRiftFire Hecarim guide is not the unread Rakan guide).
// 3. A subject WITHOUT a URL is a topic, not a document, so it needs a majority of its
//    distinctive tokens, not a third.
type Subject = { tokens: Set<string>; url: string | null }

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

// The site's own name as prose writes it: `riftgg` for www.riftgg.app, `liquipedia` for
// liquipedia.net. Approximate (no public-suffix list) — it only ever ADDS a way to match.
function siteLabel(url: string): string {
  const labels = hostOf(url).split('.')
  return labels.length >= 2 ? (labels[labels.length - 2] ?? '') : ''
}

function pathTokens(url: string): Set<string> {
  return distinctiveTokens(url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*\/?/, ''))
}

function countShared(subject: ReadonlySet<string>, words: ReadonlySet<string>): number {
  let shared = 0
  for (const token of subject) if (words.has(token)) shared++
  return shared
}

function restsOn(claim: Finding, words: ReadonlySet<string>, subject: Subject, isVocabulary: (t: string) => boolean): boolean {
  const tokens = new Set([...subject.tokens].filter((t) => !isVocabulary(t)))
  if (tokens.size < 2) return false
  const shared = countShared(tokens, words)
  if (!subject.url) return shared >= Math.max(2, Math.ceil(tokens.size / 2))
  if (shared < Math.max(2, Math.ceil(tokens.size / 3))) return false

  const docPath = new Set([...pathTokens(subject.url)].filter((t) => !isVocabulary(t)))
  const citedPath = pathTokens(claim.url)
  const citedTokens = distinctiveTokens(claim.url)
  const isCopy =
    docPath.size > 0 &&
    normalizeUrl(claim.url) !== normalizeUrl(subject.url) &&
    [...docPath].every((t) => citedTokens.has(t))
  if (isCopy) return true
  const label = siteLabel(subject.url)
  const anchored = hostOf(claim.url) === hostOf(subject.url) || (label.length >= 3 && words.has(label))
  return anchored && [...docPath].some((t) => words.has(t) && !citedPath.has(t))
}

export function degradeClaimsOnUnverifiedSources(
  claims: readonly Finding[],
  unverified: ReadonlyArray<{ topic: string; url: string | null }>,
): { kept: Finding[]; degraded: ReadonlySet<number> } {
  const subjects: Subject[] = unverified.map((entry) => ({ tokens: subjectTokens(entry), url: entry.url }))
  if (subjects.every((s) => s.tokens.size < 2)) return { kept: [...claims], degraded: new Set() }

  const claimWords = claims.map((claim) => distinctiveTokens(claim.claim))
  const documentFrequency = new Map<string, number>()
  for (const doc of [...claimWords, ...subjects.map((s) => s.tokens)]) {
    for (const token of doc) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1)
  }
  const vocabularyAt = Math.max(3, Math.ceil((claims.length + subjects.length) * 0.2))
  const isVocabulary = (token: string): boolean => (documentFrequency.get(token) ?? 0) >= vocabularyAt

  const degraded = new Set<number>()
  const kept = claims.map((claim, index) => {
    if (claim.confidence === 'low') return claim
    const words = claimWords[index] ?? new Set<string>()
    if (!subjects.some((subject) => restsOn(claim, words, subject, isVocabulary))) return claim
    degraded.add(index)
    return { ...claim, confidence: 'low' as const }
  })
  return { kept, degraded }
}

function dedupeUnverified(
  entries: ReadonlyArray<{ topic: string; url: string | null; reason: string }>,
): Array<{ topic: string; url: string | null; reason: string }> {
  const seen = new Set<string>()
  const out: Array<{ topic: string; url: string | null; reason: string }> = []
  for (const entry of entries) {
    const key = `${entry.url ?? ''}\u0000${entry.topic.trim().toLowerCase()}`
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
  if (grounding.pagesRetrieved === 0 && grounding.pagesMissing > 0) {
    // A 404-only run is not a loss of evidence: the origin's answer IS the evidence, and an
    // absence claim citing it is grounded at `high`. Say so, rather than banner-contradicting it.
    parts.push(
      `${grounding.pagesMissing} URL(s) definitively answered 404/410 — negative claims citing them are grounded, but nothing was retrieved to support positive claims`,
    )
  } else if (grounding.pagesRetrieved === 0) {
    parts.push('no source page could be retrieved at all')
  } else if (grounding.pagesFailed > grounding.pagesRetrieved) {
    parts.push(`${grounding.pagesFailed} page fetches failed against only ${grounding.pagesRetrieved} that succeeded`)
  }
  if (grounding.confidenceCapped > 0) {
    parts.push(
      `${grounding.confidenceCapped} citation(s) had their confidence lowered to match the evidence actually retrieved`,
    )
  }
  return `> **Partial result — evidence was lost during this run.** ${parts.join('; ')}. Anything below that is not backed by an entry in \`citations\` is unconfirmed; see \`unverified\` for what could not be checked.\n\n`
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

  const { kept: citedClaims, dropped, capped } = groundClaims(submitted.citations, ledger, ineligible)
  // Issue #4, second gate: a kept citation can still ASSERT facts about a document the run
  // could not read, via a different URL. Confidence degrades; the claim and its citation
  // stay, so a wrong subject match costs caution, not evidence. The same ledger-vindication
  // rule as `ineligible` applies: an entry whose URL the run actually read records an
  // unverified TOPIC, not an unread source, so it must not degrade citations.
  const degradeSubjects = submitted.unverified.filter(
    (e) => !e.url || ledger.tierOf(e.url) !== 'retrieved',
  )
  const { kept, degraded } = degradeClaimsOnUnverifiedSources(citedClaims, degradeSubjects)
  const snap = ledger.snapshot()

  // Both passes index into the same `kept` array: `capped` holds positions into
  // `groundClaims`'s kept list, which IS the input `degradeClaimsOnUnverifiedSources`
  // maps 1:1 over. A claim capped by the URL gate AND degraded here therefore appears in
  // both index sets and the union counts it ONCE — the count describes citations touched,
  // not passes over them.
  const confidenceCapped = new Set([...capped, ...degraded]).size

  const grounding: Grounding = {
    pagesRetrieved: snap.retrieved.length,
    pagesMissing: snap.missing.length,
    pagesFailed: snap.failed.length,
    citationsKept: kept.length,
    citationsDropped: dropped.length,
    confidenceCapped,
    citationsDegraded: degraded.size,
  }

  // Keep the invariant total: a URL that survived into `citations` must not also sit in
  // `unverified` claiming to be an unusable source. Where the ledger vindicated the page,
  // the entry is kept (its TOPIC may genuinely be unverified) but detached from the URL, so
  // the transparency note survives without contradicting the citation next to it.
  const cited = new Set(kept.map((c) => normalizeUrl(c.url)))
  const unverified = dedupeUnverified([...submitted.unverified, ...dropped]).map((entry) => {
    if (!entry.url || !cited.has(normalizeUrl(entry.url))) return entry
    // Say what the ledger actually holds: "retrieved" was asserted for snippet- and 404-tier
    // pages too, which read as a contradiction next to a medium-capped citation.
    const held = ledger.tierOf(entry.url) === 'retrieved' ? 'WAS retrieved' : 'was seen (search snippet or origin answer)'
    return {
      ...entry,
      url: null,
      reason: `${entry.reason} (The page itself ${held} elsewhere in this run and backs citations — this entry records an unverified topic, not an unusable source.)`,
    }
  })

  // A `partial` report is one where evidence was demonstrably LOST — a citation dropped for
  // lack of a retrieved source, nothing retrievable at all, or failures outnumbering the
  // pages that were read. A subject-degraded citation is a confidence cap, not lost evidence:
  // it keeps its citation, its `low` cap and its warning line and still counts in
  // `confidenceCapped` / `citationsDegraded`, but it must not flip `status` or banner a run
  // whose evidence is intact — which is exactly what the 2026-09-23..25 over-firing did
  // (docs/architecture-review-2026-09.md §2b).
  const degradedRun =
    grounding.citationsDropped > 0 ||
    (grounding.pagesRetrieved === 0 && grounding.pagesMissing === 0) ||
    grounding.pagesFailed > grounding.pagesRetrieved

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
  if (degraded.size > 0) {
    warnings.push(
      `${degraded.size} citation(s) were capped at low confidence because they appear to assert facts about a source this run listed as unverifiable — the claim text matched the subject of an \`unverified\` entry.`,
    )
  }
  if (grounding.pagesRetrieved === 0 && grounding.pagesMissing > 0) {
    warnings.push(
      `${grounding.pagesMissing} URL(s) answered 404/410 — absence claims citing them are definitive, nothing else was retrieved.`,
    )
  }
  if (grounding.pagesRetrieved === 0 && grounding.pagesMissing === 0) {
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
    report: degradedRun ? banner(grounding) + submitted.report : submitted.report,
    citations: kept,
    sources,
    unverified,
    status: degradedRun ? 'partial' : 'ok',
    warnings,
    grounding,
  }
}
