import { emitOtelLog } from './otel.js'

type Fields = Record<string, unknown>

// Console output stays byte-for-byte what it already was — fetch-bench.ts, dozzle, and every
// doc-quoted log line in this repo depend on this exact shape. `emitOtelLog` is additive: it
// no-ops when OTEL_EXPORTER_OTLP_ENDPOINT is unset and never throws (see otel.ts), so wiring
// it in here is safe by construction — no second try/catch needed at this call site. When the
// call happens inside a span, the OTLP record is also stamped with the active trace/span id,
// so the line is reachable from its trace; the console line is unaffected either way.
export function log(event: string, fields: Fields = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }))
  emitOtelLog(event, fields)
}
