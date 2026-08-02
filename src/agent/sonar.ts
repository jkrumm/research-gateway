import { z } from 'zod'
import { env } from '../env.js'

// Perplexity Sonar as a pure SEARCH backend, called over the same IU unified endpoint the
// DeepSeek lead/workers run on — so web search is billed to the work key rather than the
// personal Tavily plan.
//
// Two facts about this endpoint are load-bearing and were established by probing it live
// (2026-08-02), not from documentation:
//
//   1. IU exposes the Sonar models as `owned_by: "Perplexity direct"` — a real passthrough,
//      NOT a LiteLLM-normalized route. That matters because `citations` and `search_results`
//      sit OUTSIDE the OpenAI-standard `choices` array, and normalizing gateways drop them
//      (LiteLLM #5313/#13777, Portkey's strict-compliance mode, API7). Here they arrive
//      intact, which is the only reason this file can exist. If IU ever re-routes Sonar
//      through its LiteLLM tier, `search_results` goes empty and `searchWeb` silently
//      returns nothing — hence the explicit empty-result error below rather than a shrug.
//   2. `usage.cost` carries Perplexity's OWN per-call USD breakdown. That is why the
//      telemetry for this tool reports `cost_source: 'reported'` while Tavily's stays
//      'none' (see cost.ts) — this number is the vendor's, not our guess at a rate card.
//
// Deliberately NOT used: the synthesized answer in `choices[].message.content`. Sonar is an
// answer engine and it does hallucinate under confidence (fabricated stock prices, Deep
// Research citing sources it later admits it cannot find). Letting that prose into a worker's
// context would launder Perplexity's assertions into our report attached to URLs we never
// retrieved — precisely what the retrieval ledger exists to prevent. We take the URLs and
// the snippets and throw the answer away.

export type SonarContextSize = 'low' | 'medium' | 'high'

// Sonar rejects the request outright below this — `{"error":{"message":"max_tokens must be
// at least 16", ...}}`, HTTP 400. So this is a hard floor imposed by the API, not a tuned
// value: it is the smallest answer we are allowed to pay for and immediately discard.
// Generation is what makes a Sonar call slow, so keeping it at the floor is also what keeps
// a search at ~2s instead of the 3-10s a full answer costs.
const ANSWER_TOKEN_FLOOR = 16

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

export async function sonarSearch(args: {
  query: string
  contextSize: SonarContextSize
  timeoutMs?: number
}): Promise<SonarSearchOutcome> {
  const res = await fetch(`${env.IU_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.IU_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.SONAR_MODEL,
      messages: [{ role: 'user', content: args.query }],
      max_tokens: ANSWER_TOKEN_FLOOR,
      web_search_options: { search_context_size: args.contextSize },
    }),
    signal: AbortSignal.timeout(args.timeoutMs ?? 30_000),
  })

  // Read as text first: IU does not return clean JSON on upstream errors — it prefixes the
  // provider's body, e.g. `[Perplexity direct StatusCode: BadRequest] {"error":{...}}`.
  // JSON.parse on that throws a decoder error that says nothing about what went wrong.
  const body = await res.text()
  if (!res.ok) {
    throw new Error(`sonar HTTP ${res.status}: ${body.slice(0, 300)}`)
  }

  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    throw new Error(`sonar returned non-JSON: ${body.slice(0, 200)}`)
  }

  const parsed = SonarResponse.parse(json)
  const raw = parsed.search_results ?? []

  // Same URL twice in one response is possible and would inflate the ledger's snippet
  // tier with duplicates; first occurrence wins (Perplexity returns them ranked).
  const seen = new Set<string>()
  const results: SonarResult[] = []
  for (const r of raw) {
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
    costUsd: parsed.usage?.cost?.total_cost ?? 0,
    inputTokens: parsed.usage?.prompt_tokens ?? 0,
    outputTokens: parsed.usage?.completion_tokens ?? 0,
    // Present on sonar-deep-research; absent on plain `sonar`, where one call is one search.
    searchQueries: parsed.usage?.num_search_queries ?? 1,
  }

  // A 200 with no results is the signature of the passthrough assumption breaking (point 1
  // above) — treated as a failure so the caller's Tavily fallback engages instead of the
  // worker being handed an empty result set that looks like "the web has nothing".
  if (results.length === 0) {
    throw new Error('sonar returned no search_results')
  }

  return { results, usage }
}
