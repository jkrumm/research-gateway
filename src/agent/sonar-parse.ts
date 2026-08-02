import { z } from 'zod'

// The pure half of the Sonar client: response types, the wire schema, and the mapper.
// Dependency-free by design (no `env.js`, no `log.js`) so it is unit-testable without
// booting the env-parsing chain — same convention as `ledger.ts`, `extract.ts`, `cost.ts`.
// The IO half — the request, the 429 retry, the error shapes IU wraps around provider
// errors — lives in `sonar.ts`, along with the rationale for the whole approach.

export type SonarContextSize = 'low' | 'medium' | 'high'

// Sonar rejects the request outright below this — `{"error":{"message":"max_tokens must be
// at least 16", ...}}`, HTTP 400. So this is a hard floor imposed by the API, not a tuned
// value: it is the smallest answer we are allowed to pay for and immediately discard.
// Generation is what makes a Sonar call slow, so keeping it at the floor is also what keeps
// a search at ~2s instead of the 3-10s a full answer costs.
export const ANSWER_TOKEN_FLOOR = 16

const SonarResponse = z.object({
  search_results: z
    .array(
      z.object({
        title: z.string().nullish(),
        url: z.string(),
        snippet: z.string().nullish(),
        date: z.string().nullish(),
        last_updated: z.string().nullish(),
      }),
    )
    .nullish(),
  usage: z
    .object({
      prompt_tokens: z.number().nullish(),
      completion_tokens: z.number().nullish(),
      num_search_queries: z.number().nullish(),
      cost: z.object({ total_cost: z.number().nullish() }).nullish(),
    })
    .nullish(),
})

export interface SonarResult {
  title: string
  url: string
  snippet: string
  /** `date` or, failing that, `last_updated` — every probed result carried at least one. */
  published: string | null
}

export interface SonarUsage {
  costUsd: number
  inputTokens: number
  outputTokens: number
  searchQueries: number
}

export interface SonarSearchOutcome {
  results: SonarResult[]
  usage: SonarUsage
}

// Pure mapper, split from the IO below so the shapes Perplexity actually returns (null
// dates, empty snippets, duplicate URLs) are unit-testable without a network round trip.
export function parseSonarResponse(json: unknown, maxResults: number): SonarSearchOutcome {
  const parsed = SonarResponse.parse(json)
  const raw = parsed.search_results ?? []

  // Same URL twice in one response is possible and would inflate the ledger's snippet
  // tier with duplicates; first occurrence wins (Perplexity returns them ranked).
  const seen = new Set<string>()
  const results: SonarResult[] = []
  for (const r of raw) {
    if (results.length >= maxResults) break
    if (seen.has(r.url)) continue
    seen.add(r.url)
    results.push({
      title: r.title ?? '',
      url: r.url,
      snippet: r.snippet ?? '',
      published: r.date ?? r.last_updated ?? null,
    })
  }

  const usage: SonarUsage = {
    // Billed for the whole response, NOT for the slice we kept — trimming to maxResults is
    // a context decision, not a billing one, and reporting the trimmed figure would
    // under-report real spend.
    costUsd: parsed.usage?.cost?.total_cost ?? 0,
    inputTokens: parsed.usage?.prompt_tokens ?? 0,
    outputTokens: parsed.usage?.completion_tokens ?? 0,
    // Present on sonar-deep-research; absent on plain `sonar`, where one call is one search.
    searchQueries: parsed.usage?.num_search_queries ?? 1,
  }

  // A 200 with no results is the signature of the passthrough assumption breaking (point 1
  // in the header) — treated as a failure so the caller's Tavily fallback engages instead
  // of the worker being handed an empty result set that looks like "the web has nothing".
  if (results.length === 0) {
    throw new Error('sonar returned no search_results')
  }

  return { results, usage }
}
