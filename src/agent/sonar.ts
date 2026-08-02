import { env } from '../env.js'
import { log } from '../lib/log.js'
import {
  ANSWER_TOKEN_FLOOR,
  parseSonarResponse,
  type SonarContextSize,
  type SonarSearchOutcome,
} from './sonar-parse.js'

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
//      through its LiteLLM tier, `search_results` goes empty — which `parseSonarResponse`
//      turns into a throw so the caller's Tavily fallback engages, rather than handing a
//      worker an empty result set that reads as "the web has nothing".
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
//
// Also deliberately NOT used: `search_context_size` above `low`. It buys longer snippets,
// not more or different sources — see the measurement in depth.ts.

export type { SonarContextSize, SonarResult, SonarUsage, SonarSearchOutcome } from './sonar-parse.js'
export { parseSonarResponse } from './sonar-parse.js'

// Upper bound on how long a 429 may park a worker step. Perplexity's `Retry-After` is
// advisory and can be tens of seconds; a worker has a step budget to protect, so past this
// it is cheaper to fall back to Tavily than to wait.
const MAX_RETRY_AFTER_MS = 5_000

function retryAfterMs(res: Response): number {
  const header = res.headers.get('retry-after')
  if (!header) return 1_000 // 429 with no hint — one short breath, then one retry
  const seconds = Number(header)
  if (!Number.isFinite(seconds) || seconds < 0) return 1_000
  return Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS)
}

export async function sonarSearch(args: {
  query: string
  contextSize: SonarContextSize
  maxResults: number
  timeoutMs?: number
}): Promise<SonarSearchOutcome> {
  const request = (): Promise<Response> =>
    fetch(`${env.IU_BASE_URL}/chat/completions`, {
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

  let res = await request()

  // Perplexity is 50 RPM at tier 0 and this runs on IU's SHARED account, so a 429 is not
  // necessarily our fan-out's fault and is very likely transient. Retry once rather than
  // failing straight through to Tavily: the fallback works, but it silently moves spend
  // onto the personal key, which is the thing this whole migration exists to avoid.
  if (res.status === 429) {
    const waitMs = retryAfterMs(res)
    log('tool.sonarRetry', { status: 429, waitMs, retryAfter: res.headers.get('retry-after') })
    await new Promise((resolve) => setTimeout(resolve, waitMs))
    res = await request()
  }

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

  return parseSonarResponse(json, args.maxResults)
}
