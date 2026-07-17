import { describe, it, expect } from 'bun:test'
// Imported from `cost.ts` directly, NOT `usage.ts` — `usage.ts` imports `env.ts` (for
// `reportUsage`'s ARGO_* gate), which parses `process.env` at import time and throws
// without secrets. `cost.ts` has no such chain, so `computeCost` is testable with zero
// env vars. `usage.ts` re-exports the same `computeCost` binding for compatibility.
import { computeCost } from './cost.js'

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
