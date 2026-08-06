import { describe, it, expect } from 'bun:test'
// Imported from `cost.ts` directly, NOT `usage.ts` — `usage.ts` imports `env.ts` (for
// `reportUsage`'s ARGO_* gate), which parses `process.env` at import time and throws
// without secrets. `cost.ts` has no such chain, so `computeCost` is testable with zero
// env vars. `usage.ts` re-exports the same `computeCost` binding for compatibility.
import {
  computeCost,
  buildTavilyCreditRecord,
  buildSonarSearchRecord,
  buildRenderRecord,
  buildTavilyAccountRecord,
} from './cost.js'

describe('computeCost', () => {
  it('bills uncached input at the miss rate and cached input at the cache-read rate (deepseek-v4-pro)', () => {
    const { costUsd, costSource } = computeCost('deepseek-v4-pro', {
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 0,
    })
    expect(costSource).toBe('computed')
    expect(costUsd).toBeCloseTo(0.435, 6)

    const cached = computeCost('deepseek-v4-pro', {
      inputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
      outputTokens: 0,
    })
    expect(cached.costUsd).toBeCloseTo(0.0145, 6)
  })

  it('bills output tokens at the output rate (deepseek-v4-flash)', () => {
    const { costUsd } = computeCost('deepseek-v4-flash', {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 1_000_000,
    })
    expect(costUsd).toBeCloseTo(0.28, 6)
  })

  it('mixes uncached input, cached input, and output correctly for a normal call', () => {
    // 500k uncached input + 500k cached input + 200k output on deepseek-v4-pro
    const { costUsd } = computeCost('deepseek-v4-pro', {
      inputTokens: 1_000_000,
      cachedInputTokens: 500_000,
      outputTokens: 200_000,
    })
    const expected = (500_000 * 0.435 + 500_000 * 0.0145 + 200_000 * 0.87) / 1_000_000
    expect(costUsd).toBeCloseTo(expected, 6)
  })

  it('clamps the uncached term at >= 0 when cachedInputTokens exceeds inputTokens', () => {
    const { costUsd } = computeCost('deepseek-v4-pro', {
      inputTokens: 100,
      cachedInputTokens: 500,
      outputTokens: 0,
    })
    // uncached = max(0, 100 - 500) = 0, so only the cached term should bill
    expect(costUsd).toBeCloseTo((500 * 0.0145) / 1_000_000, 9)
  })

  it('returns costUsd: null, costSource: "none" for an unknown model', () => {
    const result = computeCost('some-unknown-model', {
      inputTokens: 1000,
      cachedInputTokens: 0,
      outputTokens: 1000,
    })
    expect(result).toEqual({ costUsd: null, costSource: 'none' })
  })

  it('normalizes provider-prefixed and dated model ids to the same rate table entry', () => {
    const bare = computeCost('deepseek-v4-pro', { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 0 })
    const prefixed = computeCost('iu/deepseek-v4-pro', {
      inputTokens: 1000,
      cachedInputTokens: 0,
      outputTokens: 0,
    })
    const dated = computeCost('deepseek-v4-pro-20260101', {
      inputTokens: 1000,
      cachedInputTokens: 0,
      outputTokens: 0,
    })
    expect(prefixed.costUsd).toBeCloseTo(bare.costUsd as number, 9)
    expect(dated.costUsd).toBeCloseTo(bare.costUsd as number, 9)
  })
})

describe('buildTavilyCreditRecord', () => {
  const args = { jobId: 'job-123', credits: 42, searchCalls: 3, extractCalls: 12 }

  it('scopes source_id as `${jobId}:tavily` so it never collides with the lead/worker rows', () => {
    const record = buildTavilyCreditRecord(args)
    expect(record.source_id).toBe('job-123:tavily')
    expect(record.sub_tool).toBe('tavily')
  })

  it('carries the credit count and both call counts in `raw`, never in a token field', () => {
    const record = buildTavilyCreditRecord(args)
    expect(record.raw).toEqual({ tavilyCredits: 42, tavilySearchCalls: 3, tavilyExtractCalls: 12 })
    expect(record.input_tokens).toBe(0)
    expect(record.output_tokens).toBe(0)
    expect(record.cache_read_tokens).toBe(0)
    expect(record.cache_write_tokens).toBe(0)
    expect(record.reasoning_tokens).toBe(0)
  })

  it('carries extractCalls even when credits is 0 — the normal case for single-URL extracts', () => {
    const record = buildTavilyCreditRecord({ jobId: 'job-123', credits: 0, searchCalls: 0, extractCalls: 5 })
    expect(record.raw).toEqual({ tavilyCredits: 0, tavilySearchCalls: 0, tavilyExtractCalls: 5 })
  })

  it('leaves cost_usd unset — no verified USD-per-credit rate exists to compute it honestly', () => {
    const record = buildTavilyCreditRecord(args)
    expect(record.cost_usd).toBeNull()
    expect(record.cost_source).toBe('none')
  })

  it('leaves model/model_norm unset — a Tavily call is not a model call', () => {
    const record = buildTavilyCreditRecord(args)
    expect(record.model).toBeNull()
    expect(record.model_norm).toBeNull()
  })

  it('defaults outcome to "ok" and honors an explicit "error"', () => {
    expect(buildTavilyCreditRecord({ ...args, credits: 0 }).outcome).toBe('ok')
    expect(buildTavilyCreditRecord({ ...args, credits: 0, outcome: 'error' }).outcome).toBe('error')
  })
})

describe('buildRenderRecord', () => {
  const args = { jobId: 'job-123', renders: 8, failures: 2, totalMs: 45_231 }

  it('scopes source_id as `${jobId}:render` so it never collides with the other four records', () => {
    const record = buildRenderRecord(args)
    expect(record.source_id).toBe('job-123:render')
    expect(record.sub_tool).toBe('lightpanda')
  })

  it('carries renders/failures/totalMs in `raw`, and mirrors totalMs into duration_ms', () => {
    const record = buildRenderRecord(args)
    expect(record.raw).toEqual({ renders: 8, failures: 2, totalMs: 45_231 })
    expect(record.duration_ms).toBe(45_231)
  })

  it('leaves cost_usd unset — lightpanda is self-hosted, so there is no marginal cost to report', () => {
    const record = buildRenderRecord(args)
    expect(record.cost_usd).toBeNull()
    expect(record.cost_source).toBe('none')
  })

  it('leaves model/model_norm unset — a render is not a model call', () => {
    const record = buildRenderRecord(args)
    expect(record.model).toBeNull()
    expect(record.model_norm).toBeNull()
  })

  it('zeroes every token field', () => {
    const record = buildRenderRecord(args)
    expect(record.input_tokens).toBe(0)
    expect(record.output_tokens).toBe(0)
    expect(record.cache_read_tokens).toBe(0)
    expect(record.cache_write_tokens).toBe(0)
    expect(record.reasoning_tokens).toBe(0)
  })

  it('defaults outcome to "ok" and honors an explicit "error"', () => {
    expect(buildRenderRecord(args).outcome).toBe('ok')
    expect(buildRenderRecord({ ...args, outcome: 'error' }).outcome).toBe('error')
  })
})

describe('buildSonarSearchRecord', () => {
  const args = {
    jobId: 'job-123',
    model: 'sonar',
    costUsd: 0.04812,
    inputTokens: 102,
    outputTokens: 96,
    searchCalls: 6,
    searchQueries: 6,
  }

  it('scopes source_id as `${jobId}:sonar` so it never collides with the tavily or lead/worker rows', () => {
    const record = buildSonarSearchRecord(args)
    expect(record.source_id).toBe('job-123:sonar')
    expect(record.sub_tool).toBe('sonar')
    expect(record.source_id).not.toBe(
      buildTavilyCreditRecord({ jobId: 'job-123', credits: 1, searchCalls: 1, extractCalls: 0 }).source_id,
    )
  })

  it('carries the vendor-reported USD verbatim and marks its provenance as "reported"', () => {
    const record = buildSonarSearchRecord(args)
    expect(record.cost_usd).toBe(0.04812)
    expect(record.cost_source).toBe('reported')
  })

  it('reports real token counts — a Sonar call IS a model call, unlike a Tavily credit', () => {
    const record = buildSonarSearchRecord(args)
    expect(record.model).toBe('sonar')
    expect(record.model_norm).toBe('sonar')
    expect(record.input_tokens).toBe(102)
    expect(record.output_tokens).toBe(96)
  })

  it('does NOT let computeCost price this row — token math under-reports it by orders of magnitude', () => {
    // The cost is almost entirely Perplexity's per-request search fee, which no token rate
    // reconstructs. `sonar` is deliberately absent from the RATES table for this reason.
    const fromTokens = computeCost('sonar', {
      inputTokens: args.inputTokens,
      cachedInputTokens: 0,
      outputTokens: args.outputTokens,
    })
    expect(fromTokens).toEqual({ costUsd: null, costSource: 'none' })
    expect(buildSonarSearchRecord(args).cost_usd).toBeGreaterThan(0)
  })

  it('carries call and query counts in `raw`, never in a token field', () => {
    const record = buildSonarSearchRecord(args)
    expect(record.raw).toEqual({ searchCalls: 6, searchQueries: 6 })
    expect(record.cache_read_tokens).toBe(0)
    expect(record.cache_write_tokens).toBe(0)
    expect(record.reasoning_tokens).toBe(0)
  })

  it('defaults outcome to "ok" and honors an explicit "error"', () => {
    expect(buildSonarSearchRecord(args).outcome).toBe('ok')
    expect(buildSonarSearchRecord({ ...args, outcome: 'error' }).outcome).toBe('error')
  })
})

describe('buildTavilyAccountRecord', () => {
  // Measured shape, MEASURED live against GET https://api.tavily.com/usage on 2026-08-06.
  const args = {
    planUsage: 1145,
    planLimit: 1000,
    paygoUsage: 144,
    paygoLimit: 3000,
    keyUsage: 1145,
    keyLimit: 5000,
    searchUsage: 1065,
    extractUsage: 80,
    currentPlan: 'Researcher',
  }

  it('uses a FIXED, unscoped source_id — an account gauge, not a per-job counter', () => {
    const record = buildTavilyAccountRecord(args)
    expect(record.source_id).toBe('tavily-account')
    expect(record.sub_tool).toBe('tavily-account')
  })

  it('carries every reported number in `raw`, never in a token or duration field', () => {
    const record = buildTavilyAccountRecord(args)
    expect(record.raw).toEqual(args)
    expect(record.input_tokens).toBe(0)
    expect(record.output_tokens).toBe(0)
    expect(record.cache_read_tokens).toBe(0)
    expect(record.cache_write_tokens).toBe(0)
    expect(record.reasoning_tokens).toBe(0)
    expect(record.duration_ms).toBeNull()
  })

  it('leaves cost_usd unset — no verified USD-per-credit rate exists to compute it honestly', () => {
    const record = buildTavilyAccountRecord(args)
    expect(record.cost_usd).toBeNull()
    expect(record.cost_source).toBe('none')
  })

  it('leaves model/model_norm unset — an account-usage read is not a model call', () => {
    const record = buildTavilyAccountRecord(args)
    expect(record.model).toBeNull()
    expect(record.model_norm).toBeNull()
  })

  it('always reports outcome "ok" — there is no per-call success/failure to distinguish', () => {
    expect(buildTavilyAccountRecord(args).outcome).toBe('ok')
  })
})
