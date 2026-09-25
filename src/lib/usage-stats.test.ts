import { describe, it, expect } from 'bun:test'
import type { LanguageModelUsage } from 'ai'
// `usage.ts` imports `env.ts`, which parses `process.env` at import time and throws without
// secrets — the opposite of the zero-env convention `usage.test.ts` relies on (it imports only
// from `cost.ts`). toUsageStats/addUsage/emptyUsage live in usage.ts itself, so the same
// placeholder-then-dynamic-import pattern as `otel.test.ts` applies here: fill the required
// vars with placeholders FIRST, then load the module through a dynamic import (a static one
// would be hoisted above these assignments).
process.env['API_SECRET'] ??= 'test-secret'
process.env['IU_BASE_URL'] ??= 'https://iu.example/v1'
process.env['IU_API_KEY'] ??= 'test-key'
process.env['TAVILY_API_KEY'] ??= 'test-key'

const { toUsageStats, addUsage, emptyUsage, chooseCost } = await import('./usage.js')

function fakeUsage(overrides: Partial<LanguageModelUsage> = {}): LanguageModelUsage {
  return {
    inputTokens: 100,
    inputTokenDetails: { noCacheTokens: 80, cacheReadTokens: 20, cacheWriteTokens: undefined },
    outputTokens: 50,
    outputTokenDetails: { textTokens: 40, reasoningTokens: 10 },
    totalTokens: 150,
    ...overrides,
  }
}

describe('toUsageStats', () => {
  it('reads a numeric raw.cost into reportedCostUsd and leaves unreportedCalls at 0', () => {
    const stats = toUsageStats(fakeUsage({ raw: { cost: 0.0000174 } }), 1234)
    expect(stats.reportedCostUsd).toBe(0.0000174)
    expect(stats.unreportedCalls).toBe(0)
    expect(stats.inputTokens).toBe(100)
    expect(stats.cachedInputTokens).toBe(20)
    expect(stats.reasoningTokens).toBe(10)
    expect(stats.durationMs).toBe(1234)
  })

  it('counts an unreported call when raw is absent entirely (GPT/Gemini ids never carry cost)', () => {
    const stats = toUsageStats(fakeUsage(), 0)
    expect(stats.reportedCostUsd).toBe(0)
    expect(stats.unreportedCalls).toBe(1)
  })

  it('counts an unreported call when raw exists but carries no numeric cost', () => {
    const nonNumeric = toUsageStats(fakeUsage({ raw: { cost: 'n/a' } }), 0)
    expect(nonNumeric.reportedCostUsd).toBe(0)
    expect(nonNumeric.unreportedCalls).toBe(1)

    const missing = toUsageStats(fakeUsage({ raw: { model: 'deepseek-v4.1-flash' } }), 0)
    expect(missing.reportedCostUsd).toBe(0)
    expect(missing.unreportedCalls).toBe(1)
  })
})

describe('addUsage', () => {
  it('sums reportedCostUsd and unreportedCalls alongside every other field', () => {
    const a = { ...emptyUsage(), inputTokens: 10, reportedCostUsd: 0.01, unreportedCalls: 0 }
    const b = { ...emptyUsage(), inputTokens: 5, reportedCostUsd: 0, unreportedCalls: 1 }
    const sum = addUsage(a, b)
    expect(sum.inputTokens).toBe(15)
    expect(sum.reportedCostUsd).toBeCloseTo(0.01, 10)
    expect(sum.unreportedCalls).toBe(1)
  })
})

// End-to-end: a real generateText result folded through toUsageStats, then priced through
// chooseCost — the same two-step path run.ts and buildLlmUsageRecord both take.
describe('chooseCost, fed from toUsageStats', () => {
  it('prices a fully-reported bucket from reportedCostUsd, not the rate table', () => {
    const stats = toUsageStats(fakeUsage({ raw: { cost: 0.05 } }), 0)
    expect(chooseCost('deepseek-v4.1-flash', stats)).toEqual({ costUsd: 0.05, costSource: 'reported' })
  })

  it('falls back to the rate table once any call in the bucket went unreported', () => {
    const reported = toUsageStats(
      fakeUsage({
        raw: { cost: 0.05 },
        inputTokens: 1_000_000,
        outputTokens: 0,
        inputTokenDetails: { noCacheTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: undefined },
      }),
      0,
    )
    const unreported = toUsageStats(
      fakeUsage({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: undefined },
        outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
      }),
      0,
    )
    const combined = addUsage(reported, unreported)
    const result = chooseCost('deepseek-v4.1-flash', combined)
    expect(result.costSource).toBe('computed')
    // 1,000,000 uncached input tokens at the RATES fallback (0.30/1M) — see cost.ts.
    expect(result.costUsd).toBeCloseTo(0.3, 6)
  })

  it('falls back to the (zero-priced) rate table for a role that made no calls at all', () => {
    expect(chooseCost('deepseek-v4.1-flash', emptyUsage())).toEqual({ costUsd: 0, costSource: 'computed' })
  })
})
