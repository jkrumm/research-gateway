import { env } from '../env.js'

function normalizeModel(raw: string): string {
  let m = raw.toLowerCase().trim()
  if (m.includes('/')) m = m.split('/').pop() ?? m
  return m.replace(/-eu$/, '').replace(/-\d{8}$/, '')
}

// DeepSeek rates USD per 1M tokens — matches argo's ai-usage.ts DEEPSEEK_RATES
const RATES: Record<string, { input: number; output: number }> = {
  'deepseek-v4-flash': { input: 0.14, output: 0.28 },
  'deepseek-v4-pro': { input: 0.435, output: 0.87 },
}

export function computeCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): { costUsd: number | null; costSource: 'computed' | 'none' } {
  const modelNorm = normalizeModel(model)
  const rates = RATES[modelNorm]
  if (!rates) return { costUsd: null, costSource: 'none' }
  return {
    costUsd: (inputTokens * rates.input + outputTokens * rates.output) / 1_000_000,
    costSource: 'computed',
  }
}

export async function reportUsage(args: {
  jobId: string
  model: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  reasoningTokens: number
  durationMs: number
}): Promise<void> {
  if (!env.ARGO_USAGE_URL || !env.ARGO_API_SECRET) return

  try {
    const modelNorm = normalizeModel(args.model)
    const { costUsd, costSource } = computeCost(args.model, args.inputTokens, args.outputTokens)
    const now = new Date().toISOString()

    const record = {
      source: 'research-gateway',
      source_id: args.jobId,
      grain: 'session',
      ts: now,
      ingested_at: now,
      model: args.model,
      model_norm: modelNorm,
      project: null,
      workspace: null,
      sub_tool: null,
      machine: 'vps',
      billing: 'iu',
      outcome: 'ok',
      input_tokens: args.inputTokens,
      output_tokens: args.outputTokens,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: args.reasoningTokens ?? 0,
      duration_ms: args.durationMs,
      cost_usd: costUsd,
      cost_source: costSource,
      raw: null,
    }

    await fetch(env.ARGO_USAGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.ARGO_API_SECRET}`,
      },
      body: JSON.stringify({ records: [record] }),
    })
  } catch (err) {
    // Telemetry failure must never fail a research job
    console.warn('[usage] failed to report usage:', err)
  }
}
