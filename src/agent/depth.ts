import type { Depth } from './schema.js'

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
  searchDepth: 'basic' | 'advanced'
  directive: string
}

// Timeouts are sized against MEASURED live throughput (2026-07-17): DeepSeek-V4-Pro
// ~40 tok/s, V4-Flash ~80 tok/s — roughly half the figures in modelpick's benchmark.
// Synthesis is the long pole: a report of N output tokens needs N/40 seconds on the
// lead, so shrinking these re-introduces the truncated-report failure they replaced.
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
    directive:
      'STANDARD pass — search, then read the 2-3 most relevant pages for your sub-question. Cross-verify across at least 2 independent sources.',
  },
  deep: {
    workers: 8,
    // Gap rounds are sequential wall-clock: round 1 carries the substance, later rounds
    // chase footnotes. Keep them lean so 3 rounds stay affordable in wall time.
    gapWorkers: 3,
    rounds: 3,
    workerMaxSteps: 9,
    maxContextTokens: 80_000,
    planTimeoutMs: 180_000,
    workerTimeoutMs: 420_000,
    synthesisTimeoutMs: 900_000,
    totalTimeoutMs: 3_000_000,
    searchDepth: 'advanced',
    directive:
      'DEEP pass — be thorough. Read full pages across distinct domains, not just snippets. Consult library docs for any libraries involved. Cross-verify every material claim across 3+ independent sources, and surface disagreements and version caveats explicitly.',
  },
}
