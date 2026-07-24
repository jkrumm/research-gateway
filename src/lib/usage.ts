import type { LanguageModelUsage } from 'ai'
import { env } from '../env.js'
import { computeCost, normalizeModel } from './cost.js'

// Re-exported for compatibility — callers importing `computeCost` from `usage.ts` keep
// working; the implementation lives in `cost.ts` because it has no `env.js` import and
// so can be unit-tested without booting the env-parsing chain.
export { computeCost } from './cost.js'

// Flat token/timing accumulator shared by plan/worker/synthesis calls and the job total.
export interface UsageStats {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  reasoningTokens: number
  cachedInputTokens: number
  durationMs: number
}

export function emptyUsage(): UsageStats {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    durationMs: 0,
  }
}

export function toUsageStats(usage: LanguageModelUsage, durationMs: number): UsageStats {
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    totalTokens: usage.totalTokens ?? 0,
    reasoningTokens: usage.outputTokenDetails?.reasoningTokens ?? 0,
    cachedInputTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
    durationMs,
  }
}

export function addUsage(target: UsageStats, addend: UsageStats): UsageStats {
  return {
    inputTokens: target.inputTokens + addend.inputTokens,
    outputTokens: target.outputTokens + addend.outputTokens,
    totalTokens: target.totalTokens + addend.totalTokens,
    reasoningTokens: target.reasoningTokens + addend.reasoningTokens,
    cachedInputTokens: target.cachedInputTokens + addend.cachedInputTokens,
    durationMs: target.durationMs + addend.durationMs,
  }
}

export async function reportUsage(args: {
  jobId: string
  model: string
  subTool: 'lead' | 'worker'
  inputTokens: number
  outputTokens: number
  totalTokens: number
  reasoningTokens: number
  cachedInputTokens: number
  durationMs: number
  /**
   * Defaults to 'ok'. Reporting only successes leaves `outcome` permanently 'ok',
   * which reads as a service that has never failed rather than one that isn't
   * measured. A failed job re-reports its last snapshot as 'error' — same
   * source_id, so argo's upsert flips the existing row instead of adding one.
   */
  outcome?: 'ok' | 'error'
}): Promise<void> {
  if (!env.ARGO_USAGE_URL || !env.ARGO_API_SECRET) return

  try {
    const modelNorm = normalizeModel(args.model)
    const { costUsd, costSource } = computeCost(args.model, {
      inputTokens: args.inputTokens,
      cachedInputTokens: args.cachedInputTokens,
      outputTokens: args.outputTokens,
    })
    const now = new Date().toISOString()

    const record = {
      source: 'research-gateway',
      // argo upserts on (source, source_id, machine). A job emits one record per model
      // bucket, so source_id must be scoped or the second would overwrite the first.
      source_id: `${args.jobId}:${args.subTool}`,
      grain: 'session',
      ts: now,
      ingested_at: now,
      model: args.model,
      model_norm: modelNorm,
      // argo derives `workspace` from `project` only for path-driven sources
      // (claude-code, litellm) and leaves it NULL otherwise — and its dashboard
      // filters workspace with an `IN (...)` list, which never matches NULL. Left
      // unset, this service vanished from every chart the moment the Private/Work
      // filter was touched, despite being the second-largest cost source.
      project: 'research-gateway',
      workspace: 'private',
      sub_tool: args.subTool,
      machine: 'vps',
      billing: 'iu',
      outcome: args.outcome ?? 'ok',
      input_tokens: args.inputTokens,
      output_tokens: args.outputTokens,
      cache_read_tokens: args.cachedInputTokens,
      cache_write_tokens: 0,
      reasoning_tokens: args.reasoningTokens ?? 0,
      duration_ms: args.durationMs,
      cost_usd: costUsd,
      cost_source: costSource,
      raw: null,
    }

    const res = await fetch(env.ARGO_USAGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.ARGO_API_SECRET}`,
      },
      body: JSON.stringify({ records: [record] }),
    })

    // fetch only rejects on network failure, so an auth or schema rejection from
    // argo would otherwise drop the record in total silence.
    if (!res.ok) {
      console.warn(`[usage] argo push rejected: ${res.status} ${res.statusText}`)
    }
  } catch (err) {
    // Telemetry failure must never fail a research job
    console.warn('[usage] failed to report usage:', err)
  }
}
