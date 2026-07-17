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
