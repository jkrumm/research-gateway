// Dependency-free by design (no `env.js` import) so `computeCost` can be unit-tested
// without booting the env-parsing chain.

export function normalizeModel(raw: string): string {
  let m = raw.toLowerCase().trim()
  if (m.includes('/')) m = m.split('/').pop() ?? m
  return m.replace(/-eu$/, '').replace(/-\d{8}$/, '')
}

// DeepSeek rates USD per 1M tokens — matches argo's ai-usage.ts DEEPSEEK_RATES.
// cachedInput is the cache-read rate; the endpoint bills a cache hit far below a miss.
const RATES: Record<string, { input: number; cachedInput: number; output: number }> = {
  'deepseek-v4-flash': { input: 0.14, cachedInput: 0.0028, output: 0.28 },
  'deepseek-v4-pro': { input: 0.435, cachedInput: 0.0145, output: 0.87 },
}

export function computeCost(
  model: string,
  args: { inputTokens: number; cachedInputTokens: number; outputTokens: number },
): { costUsd: number | null; costSource: 'computed' | 'none' } {
  const modelNorm = normalizeModel(model)
  const rates = RATES[modelNorm]
  if (!rates) return { costUsd: null, costSource: 'none' }

  const uncachedInputTokens = Math.max(0, args.inputTokens - args.cachedInputTokens)
  const costUsd =
    (uncachedInputTokens * rates.input +
      args.cachedInputTokens * rates.cachedInput +
      args.outputTokens * rates.output) /
    1_000_000
  return { costUsd, costSource: 'computed' }
}

// Shape of an argo `usage_record` row, built here (not usage.ts) for the same reason as
// computeCost: no env.js import, so the builder is unit-testable with zero env vars.
export interface TavilyCreditUsageRecord {
  source: string
  source_id: string
  grain: string
  model: string | null
  model_norm: string | null
  project: string
  workspace: string
  sub_tool: string
  machine: string
  billing: string
  outcome: 'ok' | 'error'
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
  duration_ms: number | null
  cost_usd: number | null
  cost_source: 'computed' | 'none'
  raw: { tavilyCredits: number }
}

// Tavily bills by API credit, not by token — jamming a credit count into `input_tokens`/
// `output_tokens` would misrepresent it as LLM usage on argo's token dashboards. This
// builds a deliberately separate, non-token record instead: `model`/`model_norm` stay
// null (a Tavily call isn't a model call), and the credit count travels in `raw` — the
// one field argo's schema reserves for source-specific data it doesn't otherwise model.
//
// `cost_usd` is left unset rather than guessed: unlike the DeepSeek token RATES above
// (matched against argo's own ai-usage.ts table), no verified USD-per-credit rate for
// Tavily exists anywhere in this repo, and Tavily's per-credit price varies by plan tier.
// Inventing one would misrepresent spend on argo's cost dashboards.
export function buildTavilyCreditRecord(args: {
  jobId: string
  credits: number
  outcome?: 'ok' | 'error'
}): TavilyCreditUsageRecord {
  return {
    source: 'research-gateway',
    // argo upserts on (source, source_id, machine); scoped so this never collides with
    // the same job's `:lead`/`:worker` rows.
    source_id: `${args.jobId}:tavily`,
    grain: 'session',
    model: null,
    model_norm: null,
    project: 'research-gateway',
    workspace: 'private',
    sub_tool: 'tavily',
    machine: 'vps',
    billing: 'iu',
    outcome: args.outcome ?? 'ok',
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    duration_ms: null,
    cost_usd: null,
    cost_source: 'none',
    raw: { tavilyCredits: args.credits },
  }
}
