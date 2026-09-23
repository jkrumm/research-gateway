// Pure mapping helpers for shipping `log()` calls to OTel — dependency-free (no `env.js`,
// no OTel package import) so they're unit-testable without booting the env-parsing chain or
// starting an exporter. Same split as cost.ts (pure) / usage.ts (env-consuming): the actual
// wiring — the SDK-free OTLP/HTTP JSON exporter (batched queues over plain `fetch`, no
// OpenTelemetry packages) and the emit call — lives in otel.ts, which imports these two
// functions and re-exports them for convenience.

export type LogAttributeValue = string | number | boolean

/**
 * Turns arbitrary `log()` fields into OTel-legal log-record attributes, which accept only
 * strings/numbers/booleans (and arrays of those) — an object field would otherwise be
 * silently dropped or rejected by the exporter. Non-scalar values (objects, arrays, and
 * `null`, since `typeof null === 'object'` makes it fall into the same bucket) are
 * `JSON.stringify`'d instead of dropped, so nothing a log call passes vanishes silently.
 * `undefined` fields ARE dropped: an OTel attribute has no "unset" value distinct from
 * simply being absent, so keeping the key with a stringified `"undefined"` would misrepresent
 * it as a real value.
 */
export function toLogAttributes(fields: Record<string, unknown>): Record<string, LogAttributeValue> {
  const attrs: Record<string, LogAttributeValue> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      attrs[key] = value
      continue
    }
    attrs[key] = JSON.stringify(value)
  }
  return attrs
}

export type LogSeverity = 'info' | 'warn' | 'error'

/**
 * Mechanical severity classification from the event name and its fields — checked against
 * the ~34 `log('event.name', …)` call sites in this repo (`grep -rn "log('" src`) rather than
 * invented:
 *
 *   ERROR — the event name ends in `.error` (job.error, mcp.error) or `.failed`
 *   (synthesis.failed, worker.failed), or contains `uncaughtException` /
 *   `unhandledRejection` (the two process-level handlers in index.ts, already logged as loud
 *   failures there), or is one of ERROR_EVENTS: the memory watchdog (process.memory_pressure
 *   — the only in-process warning a cgroup OOM kill leaves, since SIGKILL runs no handler),
 *   the loop-watch (process.loop_lag — the only in-process warning of a starved event loop,
 *   the shape behind the 2026-09-20 reaped-on-read on a LIVE process), a lost lease
 *   (job.lease_lost — this process's write to a job it thought it owned was fenced, because
 *   another replica already adopted it; see job-store.ts), and the crash-loop guard
 *   (job.crash_loop_guard — a job that has now failed to complete `MAX_JOB_ATTEMPTS` times
 *   in a row is given up on rather than resurrected again). Neither `job.reaped` nor
 *   `job.reaped_on_read` exist any more: `getJob` is read-only and a stale lease is CLAIMED
 *   and resumed (job.resumed) by the adoption loop, never reaped on a caller's poll or at
 *   boot — see job-store.ts/job-db.ts. NOT process.exit /
 *   process.beforeExit: those handlers run after the OTel flush has already happened (see
 *   flushThenExit in index.ts — "console only"), so a severity there reaches no exporter,
 *   and a routine deploy's `process.exit code 0` would read as an error on the console for
 *   nothing. The exits that do flush are process.signal and process.uncaughtException.
 *   process.drained is ERROR conditionally, by field rather than by name (unlike ERROR_EVENTS
 *   below): a clean drain (remaining: 0) is the routine, expected shape of every deploy and
 *   must not page anyone, but remaining > 0 means the shutdown deadline elapsed with jobs
 *   still running — those are about to be lost exactly like a reap, so they get the same
 *   severity.
 *
 *   WARN — the fields carry a truthy `error` key even when the event name doesn't say so
 *   (tool.fetchPage's per-attempt failure logs, tool.searchWeb's retry-exhausted log,
 *   worker.failed's own `error` field, job.rejected/job.reaped's), or the event ends in
 *   `.rejected` (synthesis.rejected, job.rejected) or `.ungrounded` (worker.ungrounded) — a
 *   result that came back but should not be trusted, not a hard failure.
 *
 *   INFO — everything else: the request/job/plan/round/tool-call lifecycle events that make
 *   up the bulk of the ~34 names and carry no failure signal at all.
 */
const ERROR_EVENTS = new Set([
  'process.memory_pressure',
  'process.loop_lag',
  'job.lease_lost',
  'job.crash_loop_guard',
])

export function severityFor(event: string, fields: Record<string, unknown> = {}): LogSeverity {
  if (
    ERROR_EVENTS.has(event) ||
    event.endsWith('.error') ||
    event.endsWith('.failed') ||
    event.includes('uncaughtException') ||
    event.includes('unhandledRejection') ||
    (event === 'process.drained' && typeof fields['remaining'] === 'number' && fields['remaining'] > 0)
  ) {
    return 'error'
  }
  if (Boolean(fields['error']) || event.endsWith('.rejected') || event.endsWith('.ungrounded')) {
    return 'warn'
  }
  return 'info'
}
