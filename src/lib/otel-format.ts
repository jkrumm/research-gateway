// Pure mapping helpers for shipping `log()` calls to OTel — dependency-free (no `env.js`,
// no OTel package import) so they're unit-testable without booting the env-parsing chain or
// starting an exporter. Same split as cost.ts (pure) / usage.ts (env-consuming): the actual
// wiring — LoggerProvider, the OTLP exporter, the emit call — lives in otel-logs.ts, which
// imports these two functions and re-exports them for convenience.

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
 *   failures there).
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
export function severityFor(event: string, fields: Record<string, unknown> = {}): LogSeverity {
  if (
    event.endsWith('.error') ||
    event.endsWith('.failed') ||
    event.includes('uncaughtException') ||
    event.includes('unhandledRejection')
  ) {
    return 'error'
  }
  if (Boolean(fields['error']) || event.endsWith('.rejected') || event.endsWith('.ungrounded')) {
    return 'warn'
  }
  return 'info'
}
