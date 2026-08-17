// Owns ALL OTel wiring for this service — the LoggerProvider, the OTLP exporter, and the
// emit/flush calls. `log.ts` imports only `emitOtelLog`/`flushOtelLogs` from here, never an
// OTel package directly, so the rest of the codebase stays free of the SDK's surface area.
//
// Ported from argo's reference implementation (apps/api/src/telemetry.ts) — LOGS half only,
// no tracing/spans: this service gets a LoggerProvider + BatchLogRecordProcessor +
// OTLPLogExporter, console output stays exactly as `log.ts` already writes it, and this file
// adds the OTLP side on top.
//
// Measured 2026-08-17: `docker logs` on this container held 513 lines / a single
// `research.start` across 72h, because the json-file log driver (10m x 3, container-local)
// had already rotated the rest away — a deep job runs ~28min, so even one job's logs don't
// reliably survive a redeploy. ClickStack/HyperDX already runs on the VPS and research-gateway
// is already on `monitoring-net`; this just gives it something to export to.
import { logs, SeverityNumber } from '@opentelemetry/api-logs'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs'
import pkg from '../../package.json' with { type: 'json' }
import { env } from '../env.js'
import { toLogAttributes, severityFor, type LogSeverity } from './otel-format.js'

// Re-exported so a caller only ever needs one import path for the log-export surface — same
// convention as usage.ts re-exporting `computeCost` from cost.ts.
export { toLogAttributes, severityFor } from './otel-format.js'

const SEVERITY_NUMBER: Record<LogSeverity, SeverityNumber> = {
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
}
const SEVERITY_TEXT: Record<LogSeverity, string> = { info: 'INFO', warn: 'WARN', error: 'ERROR' }

// Constructed only when there's somewhere to send records — unset OTEL_EXPORTER_OTLP_ENDPOINT
// (the case for local dev and every test, per env.ts) leaves both null and every call below a
// no-op. This is also what keeps this module importable in tests without a live collector:
// nothing here throws on construction, but nothing runs the network side either.
let loggerProvider: LoggerProvider | null = null
let logger: ReturnType<typeof logs.getLogger> | null = null

if (env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  const resource = resourceFromAttributes({
    'service.name': env.OTEL_SERVICE_NAME,
    'service.version': pkg.version,
    'deployment.environment': env.NODE_ENV,
  })
  loggerProvider = new LoggerProvider({
    resource,
    processors: [
      new BatchLogRecordProcessor(
        new OTLPLogExporter({ url: `${env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/logs` }),
      ),
    ],
  })
  logs.setGlobalLoggerProvider(loggerProvider)
  logger = logs.getLogger(env.OTEL_SERVICE_NAME, pkg.version)
}

/**
 * Ships one `log()` call to ClickStack over OTLP, in addition to the console line `log.ts`
 * already writes. `body` is the event name — so `research.done` is the greppable body text in
 * HyperDX, not buried in attributes — and the fields travel as attributes via
 * `toLogAttributes`.
 *
 * No-op when the endpoint is unset. Never throws and never blocks: `logger.emit` only queues
 * the record (the batch processor exports asynchronously on its own schedule), and the try/
 * catch means a broken or unreachable collector degrades telemetry, not the research job the
 * log line is describing.
 */
export function emitOtelLog(event: string, fields: Record<string, unknown>): void {
  if (!logger) return
  try {
    const severity = severityFor(event, fields)
    logger.emit({
      severityNumber: SEVERITY_NUMBER[severity],
      severityText: SEVERITY_TEXT[severity],
      body: event,
      attributes: toLogAttributes(fields),
    })
  } catch (err) {
    console.warn('[otel-logs] failed to emit log record:', err)
  }
}

/**
 * Force-flushes pending log records past the batch processor's normal export interval —
 * called from index.ts's SIGTERM/SIGINT handler so the last records of a deploy aren't lost
 * the way container logs already are (see the header comment above). No-op when the endpoint
 * is unset; never throws.
 */
export async function flushOtelLogs(): Promise<void> {
  if (!loggerProvider) return
  try {
    await loggerProvider.forceFlush()
  } catch (err) {
    console.warn('[otel-logs] failed to flush log records:', err)
  }
}
