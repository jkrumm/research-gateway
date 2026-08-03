import { Elysia } from 'elysia'
import { z } from 'zod'
import { openapi } from '@elysiajs/openapi'
import { env } from './env.js'
import { authGuard } from './lib/auth-guard.js'
import { healthRoute } from './routes/health.js'
import { researchRoutes } from './routes/research.js'
import { mcpRoutes } from './routes/mcp.js'
import { probeRoutes } from './routes/probe.js'
import { log } from './lib/log.js'

// ── Process-level diagnostics ────────────────────────────────────────────────
// On 2026-07-31 the container exited with code 0, mid-flight, during a deep job,
// leaving NO log line. `RestartCount=1`, `OOMKilled=false`, peak memory 254M of a
// 512M limit, no host event, no other container affected — and every application
// path was already guarded (reportUsage cannot reject, withSlot is safe,
// startResearchJob catches everything). The exit is still unexplained. At the time,
// the job store was in-memory, so that restart took every in-flight job with it —
// the job store now persists to sqlite (lib/job-db.ts) with heartbeat-based reaping
// (lib/job-store.ts), so a restart like this one no longer silently drops a job: a
// `done` job's result survives, and one caught mid-run comes back as a terminal
// `error` once its heartbeat goes stale, not a vanished 404.
//
// Rather than guess at the exit's cause, make the next occurrence self-describing.
process.on('exit', (code) => {
  log('process.exit', { code })
})
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    // A deploy or `docker stop` lands here — that must be distinguishable from a
    // mystery exit, which is exactly what could not be told apart on 2026-07-31.
    log('process.signal', { signal })
    process.exit(0)
  })
}
process.on('uncaughtException', (err) => {
  // Fail LOUD and non-zero: an unknown-state process serving research is worse than
  // a restart, and exit code 1 distinguishes this from a clean shutdown.
  log('process.uncaughtException', { error: String(err), stack: err.stack?.slice(0, 2_000) })
  process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  // Deliberately NOT fatal. These originate in fire-and-forget background jobs whose
  // own try/catch already contains the damage; killing the server would discard every
  // OTHER in-flight job to punish one. Logged loudly so it cannot hide.
  log('process.unhandledRejection', { reason: String(reason) })
})

// Elysia's error `code` is either a named framework error ('VALIDATION' | 'NOT_FOUND' |
// 'PARSE' | 'INVALID_COOKIE_SIGNATURE' | 'INVALID_FILE_TYPE' | 'INTERNAL_SERVER_ERROR' |
// 'UNKNOWN') or, for a handler-thrown `status(code, body)` (e.g. the 401 in auth-guard.ts),
// the numeric HTTP status itself. Maps both to a status number in [400, 500) — an expected
// client error — or null for anything that should still log loudly.
function clientErrorStatus(code: unknown): number | null {
  if (typeof code === 'number') return code >= 400 && code < 500 ? code : null
  switch (code) {
    case 'VALIDATION':
    case 'INVALID_FILE_TYPE':
      return 422
    case 'NOT_FOUND':
      return 404
    case 'PARSE':
    case 'INVALID_COOKIE_SIGNATURE':
      return 400
    default:
      return null // 'UNKNOWN' | 'INTERNAL_SERVER_ERROR' — genuine server-side failure
  }
}

export const app = new Elysia()
  .use(
    openapi({
      mapJsonSchema: { zod: z.toJSONSchema },
      documentation: {
        info: {
          title: 'research-gateway',
          version: '0.1.0',
          description:
            'Agentic research gateway. Accepts a query, runs a multi-step tool-calling loop (Tavily search + page fetch + library docs), and returns a cited markdown report. All routes except `GET /` and `GET /health` require `Authorization: Bearer <API_SECRET>`.',
        },
        components: {
          securitySchemes: {
            BearerAuth: { type: 'http', scheme: 'bearer' },
          },
        },
        tags: [
          {
            name: 'Research',
            description: 'Submit and poll agentic research jobs.',
          },
          {
            name: 'System',
            description: 'Discovery and health endpoints.',
          },
        ],
      },
    }),
  )
  .onError(({ code, error }) => {
    const clientStatus = clientErrorStatus(code)
    if (clientStatus !== null) {
      // Expected client error (e.g. every unauthenticated probe of this internet-facing,
      // tailnet-gated service throws a 401 here) — quiet structured log, not `console.error`,
      // so probe noise doesn't drown a genuine 5xx.
      log('request.client_error', { status: clientStatus, code })
      return
    }
    console.error('[error]', error)
  })
  .get(
    '/',
    () => ({
      name: 'research-gateway',
      version: '0.1.0',
      docs: {
        scalar: '/openapi',
        json: '/openapi/json',
      },
      auth: {
        scheme: 'Bearer',
        header: 'Authorization: Bearer <API_SECRET>',
        public: ['GET /', 'GET /health', 'GET /health/render'],
      },
      endpoints: {
        submit: 'POST /research',
        poll: 'GET /research/:jobId',
      },
      mcp: {
        endpoint: '/mcp',
        transport: 'streamable-http',
        tools: ['research', 'job_wait', 'job_status'],
      },
    }),
    {
      response: z.object({
        name: z.string(),
        version: z.string(),
        docs: z.object({
          scalar: z.string().describe('Interactive OpenAPI UI'),
          json: z.string().describe('Raw OpenAPI JSON spec'),
        }),
        auth: z.object({
          scheme: z.string(),
          header: z.string(),
          public: z.array(z.string()),
        }),
        endpoints: z.object({
          submit: z.string(),
          poll: z.string(),
        }),
        mcp: z.object({
          endpoint: z.string(),
          transport: z.string(),
          tools: z.array(z.string()),
        }),
      }),
      detail: {
        tags: ['System'],
        summary: 'API discovery — start here',
        description:
          'Public root endpoint. Returns the service name, version, where to find the OpenAPI spec, auth scheme, and the main research endpoints.',
      },
    },
  )
  .use(healthRoute)
  .use(authGuard)
  .use(mcpRoutes)
  .use(researchRoutes)
  .use(probeRoutes)
  .listen({ port: env.PORT, idleTimeout: 255 })

export type App = typeof app

// eslint-disable-next-line no-console
console.log(`research-gateway running on port ${env.PORT}`)
