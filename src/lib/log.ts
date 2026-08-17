import { emitOtelLog } from './otel-logs.js'

type Fields = Record<string, unknown>

// Console output stays byte-for-byte what it already was — fetch-bench.ts, dozzle, and every
// doc-quoted log line in this repo depend on this exact shape. `emitOtelLog` is additive: it
// no-ops when OTEL_EXPORTER_OTLP_ENDPOINT is unset and never throws (see otel-logs.ts), so
// wiring it in here is safe by construction — no second try/catch needed at this call site.
export function log(event: string, fields: Fields = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }))
  emitOtelLog(event, fields)
}
