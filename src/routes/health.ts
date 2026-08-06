import { Elysia } from 'elysia'
import { z } from 'zod'
import { env } from '../env.js'
import { fetchTavilyUsage } from '../lib/tavily-account.js'

export const healthRoute = new Elysia()
  .get('/health', () => ({ status: 'ok' as const }), {
    response: z.object({ status: z.literal('ok') }),
    detail: {
      tags: ['System'],
      summary: 'Liveness probe',
      description:
        'Returns `{ status: "ok" }` if the service process is up. No auth required. Used by Docker healthcheck and external uptime monitors.',
    },
  })
  // DELIBERATELY a separate path from `/health`, not a field on it.
  //
  // `/health` is what the Docker healthcheck and rollhook's rollout gate read. The renderer
  // is an OPTIONAL step — when the sidecar is down the fetch chain degrades to Tavily
  // Extract and research still works. Folding renderer state into `/health` would
  // invert that: a broken renderer would fail the container healthcheck and block deploys of
  // a gateway that is otherwise fine, which is the opposite of the design.
  //
  // So this endpoint reports renderer state and NOTHING gates on it except an uptime monitor
  // that is allowed to go red on its own.
  .get(
    '/health/render',
    async () => {
      if (!env.LIGHTPANDA_URL) {
        // Not configured is not broken — the chain is designed to run without it. Say so in
        // a way a keyword monitor can distinguish from an outage.
        return { renderer: 'disabled' as const, active: null, queued: null, error: null }
      }
      const base = env.LIGHTPANDA_URL.replace(/\/+$/, '')
      try {
        const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5_000) })
        if (!res.ok) {
          return { renderer: 'down' as const, active: null, queued: null, error: `sidecar HTTP ${res.status}` }
        }
        const body = (await res.json()) as { active?: number; queued?: number }
        return {
          renderer: 'ok' as const,
          active: body.active ?? null,
          queued: body.queued ?? null,
          error: null,
        }
      } catch (err) {
        return { renderer: 'down' as const, active: null, queued: null, error: String(err) }
      }
    },
    {
      response: z.object({
        renderer: z.enum(['ok', 'down', 'disabled']),
        active: z.number().nullable().describe('Renders currently running in the sidecar'),
        queued: z.number().nullable().describe('Renders waiting for a slot'),
        error: z.string().nullable(),
      }),
      detail: {
        tags: ['System'],
        summary: 'JavaScript-renderer probe',
        description:
          'Reports whether the Lightpanda sidecar is reachable, and its current slot usage. No auth required. NOTHING gates on this — the renderer is an optional step in the fetch chain, so a `down` here means degraded page-fetch quality, not a broken service. Monitor it with a keyword check on `"renderer":"ok"`.',
      },
    },
  )
  // Same posture as `/health/render` above: public, and nothing gates on it — this is a
  // visibility probe, not a readiness check. It exists to close the gap HANDOVER.md flagged
  // as "nothing reads GET /usage": the Tavily account crossed silently from its Researcher
  // plan into pay-as-you-go (measured 2026-08-06: plan_usage 1145 against plan_limit 1000).
  // This is the live way to check that state without shelling into the container or grepping
  // logs — `reportTavilyAccountUsage` (lib/tavily-account.ts) pushes the same numbers to argo
  // on a 10-min throttle, but this endpoint answers on demand.
  .get(
    '/health/tavily',
    async () => {
      const down = (error: string) => ({
        tavily: 'down' as const,
        currentPlan: null,
        planUsage: null,
        planLimit: null,
        paygoUsage: null,
        paygoLimit: null,
        overPlan: null,
        planRemaining: null,
        error,
      })

      try {
        // Reuses tavily-account.ts's reader rather than re-fetching and re-parsing the same
        // external contract here — two hand-written parses of one wire shape drift silently
        // when a field is renamed, and this probe exists precisely to catch drift.
        const body = await fetchTavilyUsage()
        if (!body?.account) return down('Tavily /usage unreadable (non-2xx, network, or no account field)')

        const { plan_usage: planUsage, plan_limit: planLimit } = body.account
        // Deliberately NOT `?? 0`. Coalescing a missing field to zero would collapse "Tavily
        // reports no usage" and "Tavily renamed the field" into the same answer — and the
        // second would render as `overPlan: false`, i.e. healthy, which is the exact silent
        // drift this endpoint was added to surface.
        if (typeof planUsage !== 'number' || typeof planLimit !== 'number') {
          return down('Tavily /usage is missing plan_usage/plan_limit — response shape changed')
        }

        return {
          tavily: 'ok' as const,
          currentPlan: body.account.current_plan ?? null,
          planUsage,
          planLimit,
          paygoUsage: body.account.paygo_usage ?? null,
          paygoLimit: body.account.paygo_limit ?? null,
          overPlan: planUsage > planLimit,
          planRemaining: planLimit - planUsage,
          error: null,
        }
      } catch (err) {
        return down(String(err))
      }
    },
    {
      response: z.object({
        tavily: z.enum(['ok', 'down']),
        currentPlan: z.string().nullable(),
        planUsage: z.number().nullable(),
        planLimit: z.number().nullable(),
        paygoUsage: z.number().nullable(),
        paygoLimit: z.number().nullable(),
        overPlan: z.boolean().nullable().describe('True once planUsage has exceeded planLimit'),
        planRemaining: z.number().nullable().describe('planLimit - planUsage; negative once over plan'),
        error: z.string().nullable(),
      }),
      detail: {
        tags: ['System'],
        summary: 'Tavily account-usage probe',
        description:
          'Reports live Tavily account usage via `GET https://api.tavily.com/usage`: plan usage/limit, pay-as-you-go usage/limit, and derived `overPlan`/`planRemaining`. No auth required, matching /health/render. NOTHING gates on this — it is a visibility probe.',
      },
    },
  )
