import { Elysia } from 'elysia'
import { z } from 'zod'
import { env } from '../env.js'

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
  // is an OPTIONAL step — when the sidecar is down the fetch chain degrades to Jina and
  // Tavily Extract and research still works. Folding renderer state into `/health` would
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
