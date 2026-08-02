import type { Depth } from './schema.js'
import type { SonarContextSize } from './sonar.js'

export interface DepthProfile {
  workers: number
  gapWorkers: number // workers per gap-filling round; round 1 uses `workers`
  rounds: number // max gap-filling rounds (>=1)
  workerMaxSteps: number
  maxContextTokens: number // context-size guard for a worker loop
  planTimeoutMs: number
  workerTimeoutMs: number
  synthesisTimeoutMs: number
  totalTimeoutMs: number
  searchDepth: 'basic' | 'advanced' // Tavily
  searchContextSize: SonarContextSize // Sonar — the same knob, priced per request
  // How many search hits a worker is handed. This is the fan-out dial, and it is the
  // expensive one: every extra candidate is a page a worker may decide to fetch, so it
  // drives worker tokens and wall-clock far more than it drives search spend (which is a
  // flat per-request fee either way). Sonar returns 17-20 regardless; this trims them.
  //
  // Measured 2026-08-02, first live `standard` job on Sonar: handing workers all 20 hits
  // produced a genuinely better report (50 citations / 35 pages vs ~15 citations before)
  // but took 545s and $0.16 against a ~100s / $0.009-0.028 baseline. `standard` taking 9
  // minutes collapses the gap to `deep`, so the tiers get their fan-out back here.
  maxSearchResults: number
  // Hard per-worker search budget, enforced in the tool rather than asked for in the
  // prompt. The worker prompt has said "1-3 searches should be enough" and "re-searching
  // with reworded queries is the least effective thing you can do" for a while; measured
  // 2026-08-02, a deep job issued 74 searches across 11 workers — ~6.7 each. The prompt
  // does not hold, in exactly the way the retrieval ledger exists because citation
  // instructions did not hold. Search was 65% of that job's $0.57.
  //
  // Exhausting the budget returns the same tool-visible error shape a failed search
  // returns, which the worker prompt already teaches a response to ("do NOT retry it in a
  // loop — work with the sources you already have"). No new behaviour to teach.
  maxSearches: number
  directive: string
}

// Timeouts are sized against MEASURED live throughput (2026-07-17): DeepSeek-V4-Pro
// ~40 tok/s, V4-Flash ~80 tok/s — roughly half the figures in modelpick's benchmark.
// Synthesis is the long pole: a report of N output tokens needs N/40 seconds on the
// lead, so shrinking these re-introduces the truncated-report failure they replaced.
//
// The lead now runs Flash too (see env.ts), which roughly halves the tokens-per-second
// cost of synthesis and so leaves MORE headroom inside these same ceilings. That is why
// tuning for wall-clock cuts a gap round rather than a timeout: rounds are work we chose
// to do, timeouts are the margin that keeps a long report from being truncated mid-write.
export const profiles: Record<Depth, DepthProfile> = {
  quick: {
    workers: 1,
    gapWorkers: 0,
    rounds: 1,
    workerMaxSteps: 5,
    maxContextTokens: 40_000,
    planTimeoutMs: 0,
    workerTimeoutMs: 180_000,
    synthesisTimeoutMs: 300_000,
    totalTimeoutMs: 600_000,
    searchDepth: 'basic',
    // `low` at EVERY depth, deliberately. Sonar prices context size per request — $0.005
    // (low) / $0.008 (medium) / $0.012 (high) — and the intuition that a deep pass should
    // buy the expensive tier is wrong here. Measured across two queries at all three
    // tiers: the result COUNT is identical (17/17/17 and 20/20/20) and the URL set is
    // identical to within one hit. What the higher tiers buy is longer snippets (2613 →
    // 3555 chars), and snippets are triage only — the ledger caps a snippet-backed claim
    // at `medium` confidence no matter what, so paying 2.4x for text we may not cite as
    // evidence is waste. Raise this only if worker triage visibly picks worse pages.
    searchContextSize: 'low',
    maxSearchResults: 5,
    // One worker, 5 steps — a second search is already the wrong call here.
    maxSearches: 2,
    directive:
      'QUICK pass — answer directly and precisely. One focused search, read the most relevant page if the snippets are insufficient, then submit.',
  },
  standard: {
    workers: 4,
    gapWorkers: 0,
    rounds: 1,
    workerMaxSteps: 7,
    maxContextTokens: 60_000,
    planTimeoutMs: 120_000,
    workerTimeoutMs: 300_000,
    synthesisTimeoutMs: 600_000,
    totalTimeoutMs: 1_500_000,
    searchDepth: 'basic',
    searchContextSize: 'low',
    // 12, not 8. A/B on one query showed the dial is much more sensitive than "trim the
    // candidate list": at 20 hits a standard job ran 545s/$0.1595/50 citations, at 8 it ran
    // 247s/$0.0307/15. Fewer candidates means fewer fetches, which means workers reach
    // `submit_digest` sooner — the whole loop shortens, and Sonar calls fell 12 → 3. At 8
    // this tier sits too close to `quick`; 12 is the deliberate middle, chosen so standard
    // is visibly more than quick without competing with deep.
    maxSearchResults: 12,
    // 4, and it was measured rather than guessed — including one round trip through being
    // wrong. Correlations over 15 runs said searching buys little: pages-read predicts
    // citations at r=+0.78, searches-issued only +0.52, and yield decays with volume (3.8
    // pages per search on the query that searched least, 1.7 on the one that searched most).
    // That argued for 3. A 14-run A/B at 3 refuted it: cost fell 13.6% but citations fell
    // 9.0% and did so on 5 of 5 queries — individually inside the noise, but a 5/5 sign
    // agreement is not (p ~ 0.06 under a coin flip). One query lost 17.9% of its citations
    // while its cost went UP 6.3%.
    //
    // So it is a trade, not a saving, and it is the wrong way round for this service: search
    // is billed to the IU work key while report quality is the whole product. Spend the
    // cheap resource. Revisit only if IU spend ever becomes the binding constraint.
    maxSearches: 4,
    directive:
      'STANDARD pass — search, then read the 2-3 most relevant pages for your sub-question. Cross-verify across at least 2 independent sources.',
  },
  deep: {
    workers: 8,
    // Gap rounds are sequential wall-clock: round 1 carries the substance, later rounds
    // chase footnotes. Two rounds, not three — a measured deep run took 17-28 minutes,
    // and the third round is the least valuable slice of that (it chases what two rounds
    // of eight-then-three workers already missed) while costing a full sequential round
    // of worker timeout plus its Tavily credits. Raise it back if coverage visibly suffers.
    gapWorkers: 3,
    rounds: 2,
    workerMaxSteps: 9,
    maxContextTokens: 80_000,
    planTimeoutMs: 180_000,
    workerTimeoutMs: 420_000,
    synthesisTimeoutMs: 900_000,
    totalTimeoutMs: 3_000_000,
    searchDepth: 'advanced',
    searchContextSize: 'low',
    // Deep keeps the full width — it has the step budget to actually read what it finds,
    // and breadth of independent domains is the whole point of the tier.
    maxSearchResults: 20,
    // Generous against the prompt's own "1-3", and still well under the ~6.7/worker
    // measured before this existed.
    maxSearches: 6,
    directive:
      'DEEP pass — be thorough. Read full pages across distinct domains, not just snippets. Consult library docs for any libraries involved. Cross-verify every material claim across 3+ independent sources, and surface disagreements and version caveats explicitly.',
  },
}
