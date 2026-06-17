import { Elysia } from 'elysia'
import { z } from 'zod'

export const healthRoute = new Elysia().get('/health', () => ({ status: 'ok' as const }), {
  response: z.object({ status: z.literal('ok') }),
  detail: {
    tags: ['System'],
    summary: 'Liveness probe',
    description:
      'Returns `{ status: "ok" }` if the service process is up. No auth required. Used by Docker healthcheck and external uptime monitors.',
  },
})
