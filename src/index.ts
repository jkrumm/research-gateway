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
import { flushOtel } from './lib/otel.js'
import { startMemoryWatch } from './lib/memory-watch.js'
import { beginDraining, jobCounts, waitForDrain, setMemoryPressure } from './lib/job-store.js'

// ── Process-level diagnostics ────────────────────────────────────────────────
// On 2026-07-31 the container exited with code 0, mid-flight, during a deep job,
// leaving NO log line. `RestartCount=1`, `OOMKilled=false`, peak memory 254M of a
// 512M limit, no host event, no other container affected — and every application
// path was already guarded (reportUsage cannot reject, withSlot is safe,
// startResearchJob catches everything). At the time, the job store was in-memory, so
// that restart took every in-flight job with it — the job store now persists to sqlite
// (lib/job-db.ts) with heartbeat-based reaping (lib/job-store.ts), so a restart like
// this one no longer silently drops a job: a `done` job's result survives, and one
// caught mid-run comes back as a terminal `error` once its heartbeat goes stale, not
// a vanished 404.
//
// 2026-09-04 07:37 UTC, the same shape again — "exit 0, no process.* line", 15 jobs
// reaped at boot — and this time the VPS kernel journal had the answer: the memory
// cgroup OOM killer SIGKILLed bun at exactly the 1 GiB `mem_limit`. SIGKILL runs no
// handler, so NONE of the hooks below can ever describe that exit; and `docker inspect`
// on the restarted container reports `ExitCode: 0` / `OOMKilled: false` because both
// fields describe the CURRENT run — which is how a kernel kill read as a mystery
// exit twice. The honest record of an OOM lives in the host journal
// (`journalctl -k | grep oom`), and the only in-process warning is the approach:
// lib/memory-watch.ts samples the cgroup's own `memory.current` against its limit every
// 5 s and logs at error level when it crosses 85%. The hooks below still cover every exit
// that IS in-process.
process.on('exit', (code) => {
  // Console only — the process is gone before the OTel batch could post.
  log('process.exit', { code })
})
process.on('beforeExit', (code) => {
  // A server's event loop draining is a bug (the listener is what keeps it alive), not a
  // shutdown — this is the "Bun went idle" hypothesis, made self-describing if it ever fires.
  log('process.beforeExit', { code })
})
// Force-flush pending OTel log records and spans before exiting — the exporter's normal
// 2s interval would otherwise lose the last records of exactly the event that is ending the
// process. No-op when OTEL_EXPORTER_OTLP_ENDPOINT is unset; never rejects.
//
// Racing a 2s deadline is load-bearing, not defensive dressing: the flush's own fetch
// timeout is 5s and Docker SIGKILLs at the default 10s grace period, so an unreachable
// collector would turn every deploy into a hard kill — the exact scenario this feature
// exists to survive. Whichever finishes first, the process exits.
function flushThenExit(code: number): void {
  const flushDeadline = new Promise<void>((resolve) => setTimeout(resolve, 2_000))
  void Promise.race([flushOtel(), flushDeadline]).finally(() => process.exit(code))
}
// Guards drainThenExit against re-entry: a second SIGTERM while already draining must not
// restart the wait from scratch (it would just extend an already-decided shutdown), but it
// SHOULD short-circuit straight to flushThenExit — an operator sending a second signal is
// explicitly asking to skip the wait, the same as `docker stop -t 0`.
let shuttingDown = false

// Long enough for an in-flight MCP response to reach the socket after the job that produced it
// released its slot, short enough that it is invisible next to the drain itself.
const RESPONSE_FLUSH_MS = 2_000

// SIGTERM/SIGINT used to call flushThenExit(0) directly — every job running or queued died
// mid-flight, which is exactly what a 2026-09-04 rolling deploy did to 11 of them. This now
// stops admitting new work (`beginDraining`, read by `admission()` in job-store.ts) and gives
// jobs already running up to SHUTDOWN_DRAIN_MS to finish before falling through to the same
// flush-and-exit as before.
async function drainThenExit(code: number): Promise<void> {
  if (shuttingDown) {
    flushThenExit(code)
    return
  }
  shuttingDown = true

  // Captured BEFORE beginDraining rejects the wait queue — after that, `queued` reads 0
  // regardless of how many jobs were actually waiting when the signal arrived.
  const { running, queued } = jobCounts()
  // `drainMs` on the line, not just in env.ts: the drain is only real while it stays below the
  // compose `stop_grace_period`, and that file lives in ANOTHER repo (vps). If the two ever
  // drift apart, this is the log line that says so, instead of the drift only surfacing as a
  // deploy that silently killed jobs again. `hint` for the local case — Ctrl+C during
  // `bun run dev` with a job running would otherwise look like a hang.
  log('process.draining', {
    running,
    queued,
    drainMs: env.SHUTDOWN_DRAIN_MS,
    hint: 'send the signal again to exit immediately',
  })
  beginDraining()

  const { remaining, waitedMs } = await waitForDrain(env.SHUTDOWN_DRAIN_MS)
  // Error severity when remaining > 0 (see otel-format.ts ERROR_EVENTS) — those are jobs
  // still running when the deadline elapsed, about to be lost exactly like a reap.
  log('process.drained', { remaining, waitedMs })

  // `waitForDrain` watches the job SLOT, which frees the moment the agent loop returns — before
  // the MCP `job_wait` holding that job's result has written its response back. Exiting on that
  // instant would sever an open SSE stream at exactly the moment the drain exists to protect,
  // handing the caller a broken connection for a job that actually succeeded. Not data loss
  // (the result is in sqlite, `GET /research/:jobId` still has it), but it defeats "one
  // job_wait call is the whole interaction". A short settle window is enough — this is a flush,
  // not a second drain.
  await new Promise<void>((resolve) => setTimeout(resolve, RESPONSE_FLUSH_MS))
  flushThenExit(code)
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    // A deploy or `docker stop` lands here — that must be distinguishable from a
    // mystery exit, which is exactly what could not be told apart on 2026-07-31.
    log('process.signal', { signal })
    void drainThenExit(0)
  })
}
process.on('uncaughtException', (err) => {
  // Fail LOUD and non-zero: an unknown-state process serving research is worse than
  // a restart, and exit code 1 distinguishes this from a clean shutdown.
  //
  // Flushed on the way out for the same reason the signal path is, only more so: this line
  // and every span that ended in the last <2s are the only record of a crash, and exiting
  // immediately would drop them — the 2026-07-31 no-log-line failure mode above, again.
  log('process.uncaughtException', { reason: String(err), stack: err.stack?.slice(0, 2_000) })
  flushThenExit(1)
})
process.on('unhandledRejection', (reason) => {
  // Deliberately NOT fatal. These originate in fire-and-forget background jobs whose
  // own try/catch already contains the damage; killing the server would discard every
  // OTHER in-flight job to punish one. Logged loudly so it cannot hide.
  const stack = reason instanceof Error ? reason.stack?.slice(0, 2_000) : undefined
  log('process.unhandledRejection', { reason: String(reason), stack })
})
startMemoryWatch(setMemoryPressure)
// The drain window is only real while the compose `stop_grace_period` (vps repo) stays above
// it, and those two numbers live in two repos. If they ever drift the wrong way, Docker
// SIGKILLs before `drainThenExit` gets to log anything — the identical silent shape this file
// was instrumented to eliminate. Logging it at BOOT means the value is on the record before a
// shutdown needs it.
log('process.boot', { drainMs: env.SHUTDOWN_DRAIN_MS, pid: process.pid })

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
            'Agentic research gateway. Accepts a query, runs a multi-step tool-calling loop (web search + page fetch + source-of-truth lookups), and returns a cited markdown report. Every route except the public ones listed by `GET /` (discovery, `/health*`, `/openapi*`) requires `Authorization: Bearer <API_SECRET>`.',
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
        // Everything mounted before `authGuard` below — keep this list and that order in sync.
        public: [
          'GET /',
          'GET /health',
          'GET /health/render',
          'GET /health/tavily',
          'GET /health/ytdlp',
          'GET /openapi',
          'GET /openapi/json',
        ],
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
