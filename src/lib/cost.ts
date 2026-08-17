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
//
// `cost_source` is a free-form string on argo's side (verified against its OpenAPI schema),
// so 'reported' below is a legal value and not a silently-rejected record. It exists to keep
// three provenances distinct on the dashboard: 'computed' (our rate table), 'reported' (the
// vendor priced the call itself), 'none' (unpriced).
interface SearchUsageRecordBase {
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
  cost_source: 'computed' | 'reported' | 'none'
}

export interface TavilyCreditUsageRecord extends SearchUsageRecordBase {
  raw: { tavilyCredits: number; tavilySearchCalls: number; tavilyExtractCalls: number }
}

export interface SonarSearchUsageRecord extends SearchUsageRecordBase {
  raw: { searchCalls: number; searchQueries: number }
}

export interface RenderUsageRecord extends SearchUsageRecordBase {
  raw: { renders: number; failures: number; totalMs: number }
}

export interface YtdlpUsageRecord extends SearchUsageRecordBase {
  raw: { calls: number; failures: number; totalMs: number }
}

export interface ArchiveUsageRecord extends SearchUsageRecordBase {
  raw: { rescues: number; failures: number; totalMs: number; oldestSnapshotDays: number | null }
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
// Inventing one would misrepresent spend on argo's cost dashboards. It also could not be
// computed even with a rate table: `tavilyExtractCalls` is what such a rate would have to
// multiply, since extract's own per-call `usage.credits` is structurally unreadable (see
// tools.ts's meterTavily comment for the measured 1/2/5-URL numbers behind that claim).
export function buildTavilyCreditRecord(args: {
  jobId: string
  credits: number
  searchCalls: number
  extractCalls: number
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
    raw: {
      tavilyCredits: args.credits,
      tavilySearchCalls: args.searchCalls,
      tavilyExtractCalls: args.extractCalls,
    },
  }
}

// The Sonar counterpart, and the reason the search backend moved: unlike Tavily, Perplexity
// returns `usage.cost.total_cost` in USD on every call, so this row carries a real cost
// instead of an uncosted credit count. `cost_source: 'reported'` marks it as the vendor's
// own number — strictly better provenance than the DeepSeek rows, whose cost this repo
// computes from a rate table that can drift.
//
// Tokens are reported honestly rather than zeroed the way the Tavily record zeroes them: a
// Sonar call IS a model call and does spend a handful of tokens. They are tiny (the answer
// is capped at the 16-token floor and thrown away — see agent/sonar.ts), so the per-call
// cost is almost entirely Perplexity's per-request search fee, which no token math would
// reconstruct. That is exactly why `cost_usd` must come from the vendor and not from
// computeCost: pricing this row off its token counts would under-report it by ~100x.
export function buildSonarSearchRecord(args: {
  jobId: string
  model: string
  costUsd: number
  inputTokens: number
  outputTokens: number
  searchCalls: number
  searchQueries: number
  outcome?: 'ok' | 'error'
}): SonarSearchUsageRecord {
  return {
    source: 'research-gateway',
    // Scoped like the `:tavily` row so a job running both backends (Sonar primary, Tavily
    // fallback) reports two distinct rows rather than one overwriting the other.
    source_id: `${args.jobId}:sonar`,
    grain: 'session',
    model: args.model,
    model_norm: normalizeModel(args.model),
    project: 'research-gateway',
    workspace: 'private',
    sub_tool: 'sonar',
    machine: 'vps',
    billing: 'iu',
    outcome: args.outcome ?? 'ok',
    input_tokens: args.inputTokens,
    output_tokens: args.outputTokens,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    duration_ms: null,
    cost_usd: args.costUsd,
    cost_source: 'reported',
    raw: { searchCalls: args.searchCalls, searchQueries: args.searchQueries },
  }
}

export interface TavilyAccountUsageRecord extends SearchUsageRecordBase {
  raw: {
    planUsage: number
    planLimit: number
    paygoUsage: number
    paygoLimit: number
    keyUsage: number
    keyLimit: number
    searchUsage: number
    extractUsage: number
    currentPlan: string
  }
}

// Sixth telemetry record, and the only ACCOUNT-level one — every builder above is scoped to
// one job (`source_id: ${jobId}:...`), but `GET /usage` reports Tavily's whole-account state,
// which has no job to attach to and would just report the same numbers under a different job
// id on every poll if it copied that pattern. `source_id: 'tavily-account'` is a fixed,
// unscoped key instead: argo's upsert on (source, source_id, machine) means this always
// overwrites the SAME row rather than growing a new one — a gauge, not a per-job counter. This
// closes the gap HANDOVER.md flagged as "nothing reads GET /usage", which is how the account
// crossed from its Researcher plan into pay-as-you-go silently (measured 2026-08-06:
// plan_usage 1145 against plan_limit 1000, paygo_usage 144).
//
// `cost_usd`/`cost_source` follow the Tavily credit record's reasoning immediately above: no
// verified USD-per-credit rate exists anywhere in this repo, so nothing here is guessed.
// Every number Tavily reports travels in `raw`, same as the other Tavily/render records —
// none of it is token or duration data, so none of it belongs in those fields.
export function buildTavilyAccountRecord(args: {
  planUsage: number
  planLimit: number
  paygoUsage: number
  paygoLimit: number
  keyUsage: number
  keyLimit: number
  searchUsage: number
  extractUsage: number
  currentPlan: string
}): TavilyAccountUsageRecord {
  return {
    source: 'research-gateway',
    source_id: 'tavily-account',
    grain: 'session',
    model: null,
    model_norm: null,
    project: 'research-gateway',
    workspace: 'private',
    sub_tool: 'tavily-account',
    machine: 'vps',
    billing: 'iu',
    outcome: 'ok',
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    duration_ms: null,
    cost_usd: null,
    cost_source: 'none',
    raw: { ...args },
  }
}

// Fifth per-job record: lightpanda renders were previously visible only in container logs,
// which don't survive a redeploy. `cost_usd: null` / `cost_source: 'none'` here for a
// different reason than the Tavily record's — this isn't a missing rate table, it's that
// lightpanda is a self-hosted sidecar (see fetch-chain.ts), so there is no marginal per-render
// vendor cost to report at all. `duration_ms` carries the job's total render time; `raw`
// carries the counts a future capacity/latency read would need.
export function buildRenderRecord(args: {
  jobId: string
  renders: number
  failures: number
  totalMs: number
  outcome?: 'ok' | 'error'
}): RenderUsageRecord {
  return {
    source: 'research-gateway',
    source_id: `${args.jobId}:render`,
    grain: 'session',
    model: null,
    model_norm: null,
    project: 'research-gateway',
    workspace: 'private',
    sub_tool: 'lightpanda',
    machine: 'vps',
    billing: 'iu',
    outcome: args.outcome ?? 'ok',
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    duration_ms: args.totalMs,
    cost_usd: null,
    cost_source: 'none',
    raw: { renders: args.renders, failures: args.failures, totalMs: args.totalMs },
  }
}

// Sixth per-job record, alongside `lead`/`worker`/`tavily`/`sonar`/`render` — yt-dlp calls
// (both the transcript step and findVideos search) were previously visible only in container
// logs. `cost_usd: null` / `cost_source: 'none'` for the same reason as the render record:
// yt-dlp is a binary bundled into this image (see the Dockerfile), not a vendor call — it is
// free, that is the entire point of replacing Tavily Extract with it, and there is no
// marginal per-call cost to report.
export function buildYtdlpRecord(args: {
  jobId: string
  calls: number
  failures: number
  totalMs: number
  outcome?: 'ok' | 'error'
}): YtdlpUsageRecord {
  return {
    source: 'research-gateway',
    source_id: `${args.jobId}:ytdlp`,
    grain: 'session',
    model: null,
    model_norm: null,
    project: 'research-gateway',
    workspace: 'private',
    sub_tool: 'ytdlp',
    machine: 'vps',
    billing: 'iu',
    outcome: args.outcome ?? 'ok',
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    duration_ms: args.totalMs,
    cost_usd: null,
    cost_source: 'none',
    raw: { calls: args.calls, failures: args.failures, totalMs: args.totalMs },
  }
}

// Seventh per-job record, alongside `lead`/`worker`/`tavily`/`sonar`/`render`/`ytdlp` — Wayback
// rescues (fetch-chain.ts's `tryWayback`) were previously visible only in container logs, gone
// on redeploy. `cost_usd: null` / `cost_source: 'none'` for the same reason as render/ytdlp:
// the Internet Archive is a free public service, not a metered vendor call — there is no
// marginal cost to report. `oldestSnapshotDays` carries the MAXIMUM snapshot age seen in the
// job, not a sum (see tools.ts's meterArchive for why summing ages is meaningless) — it is the
// signal that says how stale the rescued content actually was, which is what would decide
// whether a future site adapter is worth writing for the host that forced the rescue.
export function buildArchiveRecord(args: {
  jobId: string
  rescues: number
  failures: number
  totalMs: number
  /** Null when no rescue in the job carried a parseable snapshot date — see tools.ts. */
  oldestSnapshotDays: number | null
  outcome?: 'ok' | 'error'
}): ArchiveUsageRecord {
  return {
    source: 'research-gateway',
    source_id: `${args.jobId}:archive`,
    grain: 'session',
    model: null,
    model_norm: null,
    project: 'research-gateway',
    workspace: 'private',
    sub_tool: 'wayback',
    machine: 'vps',
    billing: 'iu',
    outcome: args.outcome ?? 'ok',
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    duration_ms: args.totalMs,
    cost_usd: null,
    cost_source: 'none',
    raw: {
      rescues: args.rescues,
      failures: args.failures,
      totalMs: args.totalMs,
      oldestSnapshotDays: args.oldestSnapshotDays,
    },
  }
}
