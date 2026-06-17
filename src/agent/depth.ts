import type { Depth } from './schema.js'

export interface DepthProfile {
  maxSteps: number
  maxTokens: number
  timeoutMs: number
  searchDepth: 'basic' | 'advanced'
  directive: string
}

export const profiles: Record<Depth, DepthProfile> = {
  quick: {
    maxSteps: 6,
    maxTokens: 60_000,
    timeoutMs: 180_000,
    searchDepth: 'basic',
    directive:
      'QUICK pass — favor speed and minimal credits. One basic web search; answer from the answer + result snippets. Fetch at most one page, only if snippets are insufficient. 1-2 sources acceptable.',
  },
  standard: {
    maxSteps: 14,
    maxTokens: 150_000,
    timeoutMs: 480_000,
    searchDepth: 'basic',
    directive:
      'STANDARD pass — one basic search, then read the 2-3 most relevant URLs. Cross-verify across at least 2 independent sources.',
  },
  deep: {
    maxSteps: 28,
    maxTokens: 350_000,
    timeoutMs: 900_000,
    searchDepth: 'advanced',
    directive:
      'DEEP pass — be thorough. Advanced search depth and more results; read 4-6 URLs across distinct domains; consult library docs for any libraries involved. Cross-verify across 3+ independent sources and call out disagreements and version caveats.',
  },
}
