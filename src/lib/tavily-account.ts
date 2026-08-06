// Thin env-touching wrapper around `GET https://api.tavily.com/usage` — the account-level
// read HANDOVER.md flagged as completely unread ("nothing reads GET /usage"), which is how
// the account crossed silently from its Researcher plan into pay-as-you-go (measured
// 2026-08-06: plan_usage 1145 against plan_limit 1000, paygo_usage 144).
//
// All the pure shape-mapping (the argo record) lives in `cost.ts` (`buildTavilyAccountRecord`)
// so THAT stays unit-testable without booting the env-parsing chain. This file owns only what
// genuinely needs `env.js` — the bearer key — plus the call-rate throttle.
//
// Every response field is read defensively (`?? 0` / `?? 'unknown'`) because this is telemetry
// riding on the back of real work, not billing logic: a shape drift on Tavily's side must
// degrade this call silently, never throw it into the caller — `meterTavily`'s flush in
// tools.ts, which must never be delayed or fail because an account-usage read went wrong.

import { env } from '../env.js'
import { buildTavilyAccountRecord } from './cost.js'
import { postUsageRecord } from './usage.js'

const TIMEOUT_MS = 10_000

// At most one call every 10 minutes. `reportTavilyAccountUsage` is called from every
// `meterTavily` flush (tools.ts) — one per job's Tavily activity going quiet for 3s — so
// without a throttle this would still be one GET per job. The account total does not move
// meaningfully faster than this window, so a module-scope timestamp is enough; no need for a
// scheduler.
const THROTTLE_MS = 10 * 60_000

let lastReportedAt = 0

export interface TavilyUsageResponse {
  key?: {
    usage?: number
    limit?: number
  }
  account?: {
    current_plan?: string
    plan_usage?: number
    plan_limit?: number
    paygo_usage?: number
    paygo_limit?: number
    search_usage?: number
    extract_usage?: number
  }
}

/**
 * The single place that knows Tavily's `/usage` wire shape. Exported so `/health/tavily` reads
 * the account through THIS function rather than hand-rolling a second fetch-and-parse of the
 * same external contract — two independent parses drift silently when a field is renamed.
 *
 * Returns null on any failure (non-2xx, network, malformed body, missing `account`); it never
 * throws, because both callers are things that must not fail over telemetry.
 */
export async function fetchTavilyUsage(): Promise<TavilyUsageResponse | null> {
  try {
    const res = await fetch('https://api.tavily.com/usage', {
      headers: { authorization: `Bearer ${env.TAVILY_API_KEY}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) return null

    const body = (await res.json()) as TavilyUsageResponse
    // `account` missing means a malformed or unexpected response — treat it as a failed read
    // rather than a real account of all zeros, which would misrepresent the account as unused.
    if (!body.account) return null
    return body
  } catch {
    return null
  }
}

export async function reportTavilyAccountUsage(): Promise<void> {
  const now = Date.now()
  if (now - lastReportedAt < THROTTLE_MS) return
  lastReportedAt = now

  try {
    const body = await fetchTavilyUsage()
    if (!body?.account) return

    const record = buildTavilyAccountRecord({
      planUsage: body.account.plan_usage ?? 0,
      planLimit: body.account.plan_limit ?? 0,
      paygoUsage: body.account.paygo_usage ?? 0,
      paygoLimit: body.account.paygo_limit ?? 0,
      keyUsage: body.key?.usage ?? 0,
      keyLimit: body.key?.limit ?? 0,
      searchUsage: body.account.search_usage ?? 0,
      extractUsage: body.account.extract_usage ?? 0,
      currentPlan: body.account.current_plan ?? 'unknown',
    })
    const ts = new Date().toISOString()
    await postUsageRecord({ ...record, ts, ingested_at: ts })
  } catch {
    // Never throw — an account-usage read must never fail whatever it was piggybacked onto.
  }
}
