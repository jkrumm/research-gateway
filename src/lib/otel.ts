import { AsyncLocalStorage } from 'node:async_hooks'
import pkg from '../../package.json' with { type: 'json' }
import { env } from '../env.js'
import { toLogAttributes, severityFor, type LogSeverity } from './otel-format.js'

// Owns ALL OTel wiring for this service — traces AND logs, exported as OTLP/HTTP JSON over
// plain `fetch`, no OpenTelemetry SDK. `log.ts` imports only `emitOtelLog` from here and
// index.ts only `flushOtel`, so the rest of the codebase never touches an exporter directly.
//
// SDK-free is the deliberate choice over adding `@opentelemetry/sdk-trace-node` to the
// LoggerProvider setup this file replaces: it REMOVES four dependencies instead of adding
// two, and `sdk-trace-node` pulls in `@opentelemetry/context-async-hooks`, whose Bun support
// is not certified (Bun's `async_hooks` are partial) — the one piece that has to be correct
// for parent/child propagation across the worker fan-out. The hand-rolled version below is
// ported from audio-gateway (`src/otel.ts`), which has been running in production against
// THE SAME ClickStack collector (`http://clickstack:4319`), proving that receiver accepts
// OTLP/HTTP JSON on that port.
//
// Not used, on purpose: the AI SDK's own `@ai-sdk/otel` telemetry. In ai@7 it records prompts
// and outputs by default, which would ship entire research prompts and reports into spans.
//
// Disabled — a total no-op on the network path — unless OTEL_EXPORTER_OTLP_ENDPOINT is set
// (unset is the default: local dev and every test). Span/log record CONSTRUCTION always
// happens: it is cheap bookkeeping, and it is what makes this module testable without a live
// collector; only the queue-and-fetch step is gated.
//
// The trace id of a job is DERIVED from its job id (the UUID `job-store.ts` hands out, dashes
// stripped to 32 hex) — see `traceIdFromJobId` — so a trace joins its usage_record/Argo rows
// and its `jobId` log fields on a value that already exists, with no correlation column.
//
// Measured 2026-08-17, the reason any of this exists: `docker logs` on this container held
// 513 lines / a single `research.start` across 72h, because the json-file log driver
// (10m x 3, container-local) had already rotated the rest away — a deep job runs ~28min, so
// even one job's logs don't reliably survive a redeploy.

// Re-exported so a caller only ever needs one import path for the telemetry surface — same
// convention as usage.ts re-exporting `computeCost` from cost.ts.
export { toLogAttributes, severityFor } from './otel-format.js'

const ENDPOINT = env.OTEL_EXPORTER_OTLP_ENDPOINT
const ENABLED = Boolean(ENDPOINT)

// ── Attribute values ─────────────────────────────────────────────────────────

type AttrValue = string | number | boolean
export type SpanAttributes = Record<string, AttrValue | null | undefined>

type OtlpValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean }

function toOtlpValue(v: AttrValue): OtlpValue {
  if (typeof v === 'boolean') return { boolValue: v }
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v }
  }
  return { stringValue: v }
}

/** Drop null/undefined; stringify anything that isn't already string/number/boolean. */
function normalizeAttrValue(raw: unknown): AttrValue | undefined {
  if (raw === null || raw === undefined) return undefined
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') return raw
  try {
    return JSON.stringify(raw)
  } catch {
    return String(raw)
  }
}

type OtlpAttribute = { key: string; value: OtlpValue }

function toOtlpAttributes(attrs: Record<string, unknown>): OtlpAttribute[] {
  const out: OtlpAttribute[] = []
  for (const [key, raw] of Object.entries(attrs)) {
    const value = normalizeAttrValue(raw)
    if (value === undefined) continue
    out.push({ key, value: toOtlpValue(value) })
  }
  return out
}

/**
 * Parse the standard `OTEL_RESOURCE_ATTRIBUTES` env var (`key=value,key=value`, per the OTel
 * resource SDK spec) so the compose file can override any resource default below without a
 * code change. Malformed pairs (no `=`) are skipped. Exported and pure (it reads no env
 * itself) so it can be exercised directly.
 */
export function parseResourceAttributesEnv(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf('=')
    if (idx === -1) continue
    const key = pair.slice(0, idx).trim()
    const value = pair.slice(idx + 1).trim()
    if (key) out[key] = value
  }
  return out
}

// The same three attributes the LoggerProvider's `resourceFromAttributes` carried before, now
// on both signals. No `host.name`: this service runs on exactly one host (the VPS) and has no
// `machine` config to fill it from — `OTEL_RESOURCE_ATTRIBUTES` is the escape hatch if that
// ever stops being true.
const RESOURCE = {
  attributes: toOtlpAttributes({
    'service.name': env.OTEL_SERVICE_NAME,
    'service.version': pkg.version,
    'deployment.environment': env.NODE_ENV,
    ...parseResourceAttributesEnv(process.env['OTEL_RESOURCE_ATTRIBUTES'] ?? ''),
  }),
}

// ── IDs ──────────────────────────────────────────────────────────────────────

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Derive a 32-hex OTel trace id from a job UUID (dashes stripped) — the join key between a
 * job's `usage_record` rows, its `jobId` log field, and this trace. Falls back to a fresh
 * random trace id when `jobId` isn't UUID-shaped, which covers the synthetic ids this repo
 * uses off the job path (`'-'` in the probe routes and the bench scripts).
 */
export function traceIdFromJobId(jobId: string): string {
  const hex = jobId.replace(/-/g, '').toLowerCase()
  return /^[0-9a-f]{32}$/.test(hex) ? hex : toHex(crypto.getRandomValues(new Uint8Array(16)))
}

function newTraceId(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(16)))
}

function newSpanId(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(8)))
}

function nowNanos(): bigint {
  return BigInt(Date.now()) * 1_000_000n
}

// ── Span kind / status codes (OTLP proto enums) ──────────────────────────────

export type SpanKind = 'internal' | 'server' | 'client'
const KIND_CODE: Record<SpanKind, number> = { internal: 1, server: 2, client: 3 }

export type StatusCode = 'unset' | 'ok' | 'error'
const STATUS_CODE: Record<StatusCode, number> = { unset: 0, ok: 1, error: 2 }

// ── Span ─────────────────────────────────────────────────────────────────────

export interface Span {
  readonly traceId: string
  readonly spanId: string
  setAttributes(attrs: SpanAttributes): void
  setStatus(code: StatusCode, message?: string): void
  recordException(err: unknown): void
  addEvent(name: string, attrs?: SpanAttributes): void
  end(attrs?: SpanAttributes): void
}

interface SpanEventData {
  name: string
  timeUnixNano: string
  attributes: SpanAttributes
}

interface InternalSpanData {
  traceId: string
  spanId: string
  parentSpanId: string | undefined
  name: string
  kind: SpanKind
  startTimeUnixNano: bigint
  attributes: SpanAttributes
  statusCode: StatusCode
  statusMessage: string | undefined
  events: SpanEventData[]
  ended: boolean
}

const currentSpan = new AsyncLocalStorage<InternalSpanData>()

const NOOP_SPAN: Span = {
  traceId: '',
  spanId: '',
  setAttributes() {},
  setStatus() {},
  recordException() {},
  addEvent() {},
  end() {},
}

function createSpanData(
  name: string,
  kind: SpanKind,
  attrs?: SpanAttributes,
  explicitTraceId?: string,
): InternalSpanData {
  const parent = currentSpan.getStore()
  return {
    traceId: explicitTraceId ?? parent?.traceId ?? newTraceId(),
    spanId: newSpanId(),
    parentSpanId: parent?.spanId,
    name,
    kind,
    startTimeUnixNano: nowNanos(),
    attributes: { ...attrs },
    statusCode: 'unset',
    statusMessage: undefined,
    events: [],
    ended: false,
  }
}

function toPublicSpan(data: InternalSpanData): Span {
  return {
    traceId: data.traceId,
    spanId: data.spanId,
    setAttributes(attrs: SpanAttributes): void {
      Object.assign(data.attributes, attrs)
    },
    setStatus(code: StatusCode, message?: string): void {
      data.statusCode = code
      if (message) data.statusMessage = message
    },
    recordException(err: unknown): void {
      const message = err instanceof Error ? err.message : String(err)
      data.events.push({
        name: 'exception',
        timeUnixNano: nowNanos().toString(),
        attributes: {
          'exception.type': err instanceof Error ? err.name : 'Error',
          'exception.message': message,
          ...(err instanceof Error && err.stack
            ? { 'exception.stacktrace': err.stack.slice(0, 2_000) }
            : {}),
        },
      })
    },
    addEvent(name: string, attrs?: SpanAttributes): void {
      data.events.push({ name, timeUnixNano: nowNanos().toString(), attributes: { ...attrs } })
    },
    end(attrs?: SpanAttributes): void {
      if (data.ended) return
      if (attrs) Object.assign(data.attributes, attrs)
      data.ended = true
      exportSpan(data)
    },
  }
}

/** Start a span. Parent is whatever span is active on the AsyncLocalStorage; a root has none. */
export function startSpan(name: string, attrs?: SpanAttributes, kind: SpanKind = 'internal'): Span {
  return toPublicSpan(createSpanData(name, kind, attrs))
}

/** The currently active span (via `withSpan`/`withRootSpan`), or a no-op span if none. */
export function getActiveSpan(): Span {
  const data = currentSpan.getStore()
  return data ? toPublicSpan(data) : NOOP_SPAN
}

async function runInSpan<T>(data: InternalSpanData, fn: (span: Span) => Promise<T>): Promise<T> {
  const span = toPublicSpan(data)
  return currentSpan.run(data, async () => {
    try {
      const result = await fn(span)
      if (data.statusCode === 'unset') span.setStatus('ok')
      return result
    } catch (err) {
      span.setStatus('error', err instanceof Error ? err.message : String(err))
      span.recordException(err)
      throw err
    } finally {
      span.end()
    }
  })
}

/**
 * Run `fn` inside a new child span (parent = whatever span is currently active). Ends the span
 * on settle either way, marking error status + recording the exception on a throw, which it
 * then re-throws — this wraps a step, it does not swallow its failure.
 */
export function withSpan<T>(
  name: string,
  attrs: SpanAttributes,
  fn: (span: Span) => Promise<T>,
  kind: SpanKind = 'internal',
): Promise<T> {
  return runInSpan(createSpanData(name, kind, attrs), fn)
}

/**
 * Run `fn` inside a new ROOT span with an explicit trace id (derived from the job id — see
 * `traceIdFromJobId`). Used once per research job, wrapping the whole run; anything deeper
 * enriches the span it is in via `getActiveSpan().setAttributes(...)` as facts become known.
 */
export function withRootSpan<T>(
  params: { traceId: string; name: string; attrs?: SpanAttributes; kind?: SpanKind },
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const data = createSpanData(params.name, params.kind ?? 'server', params.attrs, params.traceId)
  return runInSpan(data, fn)
}

// ── OTLP JSON record shapes + payload builders ───────────────────────────────
// Pure — no ENABLED gate, so the records a test observes through `_test` are exactly the ones
// production would put on the wire.

export interface SpanRecord {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: number
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: OtlpAttribute[]
  status: { code: number; message?: string }
  events?: Array<{ name: string; timeUnixNano: string; attributes: OtlpAttribute[] }>
}

export interface LogRecord {
  timeUnixNano: string
  severityNumber: number
  severityText: string
  body: { stringValue: string }
  attributes: OtlpAttribute[]
  traceId?: string
  spanId?: string
}

function spanRecord(data: InternalSpanData): SpanRecord {
  return {
    traceId: data.traceId,
    spanId: data.spanId,
    ...(data.parentSpanId ? { parentSpanId: data.parentSpanId } : {}),
    name: data.name,
    kind: KIND_CODE[data.kind],
    startTimeUnixNano: data.startTimeUnixNano.toString(),
    endTimeUnixNano: nowNanos().toString(),
    attributes: toOtlpAttributes(data.attributes),
    status: {
      code: STATUS_CODE[data.statusCode],
      ...(data.statusMessage ? { message: data.statusMessage } : {}),
    },
    ...(data.events.length
      ? {
          events: data.events.map((e) => ({
            name: e.name,
            timeUnixNano: e.timeUnixNano,
            attributes: toOtlpAttributes(e.attributes),
          })),
        }
      : {}),
  }
}

function buildTracesPayload(spans: SpanRecord[]): object {
  return {
    resourceSpans: [
      { resource: RESOURCE, scopeSpans: [{ scope: { name: env.OTEL_SERVICE_NAME }, spans }] },
    ],
  }
}

function buildLogsPayload(logs: LogRecord[]): object {
  return {
    resourceLogs: [
      {
        resource: RESOURCE,
        scopeLogs: [{ scope: { name: env.OTEL_SERVICE_NAME }, logRecords: logs }],
      },
    ],
  }
}

// ── Export — batched, fire-and-forget, never throws ──────────────────────────

const FLUSH_INTERVAL_MS = 2_000
const BATCH_MAX = 100
const FETCH_TIMEOUT_MS = 5_000
const FAILURE_LOG_INTERVAL_MS = 60_000
const MAX_IN_FLIGHT = 4

const spanQueue: SpanRecord[] = []
const logQueue: LogRecord[] = []

/** Test-only observers — fire on every span/log record built, independent of ENABLED. */
let spanHook: ((record: SpanRecord) => void) | null = null
let logHook: ((record: LogRecord) => void) | null = null

let lastFailureLogAt = 0

/**
 * Every batch POST that has started and not yet settled. Two jobs at once: it lets
 * `flushOtel` await a batch that some EARLIER flush spliced out of the queues but has not
 * finished sending (otherwise shutdown sees empty queues, returns instantly, and index.ts
 * exits on top of exactly the deploy-time batch this feature exists to preserve), and it
 * bounds concurrency — see MAX_IN_FLIGHT in `flush`.
 */
const inFlight = new Set<Promise<void>>()

/** Register a batch post for the lifetime of its fetch. The returned promise never rejects. */
function trackPost(post: Promise<void>): Promise<void> {
  const tracked = post.finally(() => {
    inFlight.delete(tracked)
  })
  inFlight.add(tracked)
  return tracked
}

/**
 * POST one OTLP JSON batch. Never throws — a non-ok response or a network failure is
 * rate-limited (at most once a minute) to `console.error` directly, deliberately bypassing
 * `log.ts` (which itself feeds `emitOtelLog`) so an export failure can never route back
 * through the exporter it is reporting on.
 */
async function postBatch(url: string, body: unknown): Promise<void> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) reportExportFailure(`export rejected: ${res.status} ${res.statusText}`)
  } catch (err) {
    reportExportFailure(`export failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function reportExportFailure(message: string): void {
  const now = Date.now()
  if (now - lastFailureLogAt < FAILURE_LOG_INTERVAL_MS) return
  lastFailureLogAt = now
  console.error(`[otel] ${message}`)
}

/**
 * Splice both queues and post them. `force` is shutdown-only: normally a tick that finds
 * MAX_IN_FLIGHT posts already outstanding SKIPS entirely, leaving the records queued for the
 * next tick, because BATCH_MAX trips repeatedly during a worker fan-out while the independent
 * 2s interval also fires — against a slow or unreachable collector (5s fetch timeout) that
 * would otherwise pile up an unbounded number of concurrent outbound POSTs.
 */
async function flush(force = false): Promise<void> {
  if (!ENDPOINT) return
  if (!force && inFlight.size >= MAX_IN_FLIGHT) return
  const spans = spanQueue.splice(0, spanQueue.length)
  const logs = logQueue.splice(0, logQueue.length)
  const tasks: Promise<void>[] = []
  if (spans.length) {
    tasks.push(trackPost(postBatch(`${ENDPOINT}/v1/traces`, buildTracesPayload(spans))))
  }
  if (logs.length) tasks.push(trackPost(postBatch(`${ENDPOINT}/v1/logs`, buildLogsPayload(logs))))
  if (tasks.length) await Promise.allSettled(tasks)
}

function exportSpan(data: InternalSpanData): void {
  const record = spanRecord(data)
  spanHook?.(record)
  if (!ENABLED) return
  spanQueue.push(record)
  if (spanQueue.length >= BATCH_MAX) void flush()
}

const SEVERITY_NUMBER: Record<LogSeverity, number> = { info: 9, warn: 13, error: 17 }
const SEVERITY_TEXT: Record<LogSeverity, string> = { info: 'INFO', warn: 'WARN', error: 'ERROR' }

/**
 * Ships one `log()` call to ClickStack over OTLP, in addition to the console line `log.ts`
 * already writes. `body` is the event name — so `research.done` is the greppable body text in
 * HyperDX, not buried in attributes — and the fields travel as attributes via
 * `toLogAttributes`, which JSON-stringifies non-scalars and drops `undefined` before the OTLP
 * conversion ever sees them. When the call happens inside a span the record is stamped with
 * that span's trace/span id, which is what makes a log line clickable from its trace.
 *
 * No-op on the network path when the endpoint is unset. Never throws and never blocks: the
 * record is only queued (the interval below exports it), and the try/catch means a broken
 * telemetry path degrades telemetry, not the research job the log line is describing.
 */
export function emitOtelLog(event: string, fields: Record<string, unknown>): void {
  try {
    const severity = severityFor(event, fields)
    const active = currentSpan.getStore()
    const record: LogRecord = {
      timeUnixNano: nowNanos().toString(),
      severityNumber: SEVERITY_NUMBER[severity],
      severityText: SEVERITY_TEXT[severity],
      body: { stringValue: event },
      attributes: toOtlpAttributes(toLogAttributes(fields)),
      ...(active ? { traceId: active.traceId, spanId: active.spanId } : {}),
    }
    logHook?.(record)
    if (!ENABLED) return
    logQueue.push(record)
    if (logQueue.length >= BATCH_MAX) void flush()
  } catch (err) {
    console.warn('[otel] failed to emit log record:', err)
  }
}

/**
 * Force-flushes both queues past the normal export interval — called from index.ts's
 * SIGTERM/SIGINT and uncaughtException handlers so the last records of a deploy aren't lost
 * the way container logs already are (see the header comment). No-op when the endpoint is
 * unset; never rejects.
 *
 * Ignores the MAX_IN_FLIGHT cap (shutdown must drain, not skip) and then awaits every post
 * still outstanding — including ones an interval- or BATCH_MAX-driven flush already spliced
 * out of the queues but has not finished sending, which empty queues would otherwise hide.
 * One drain pass suffices, no loop: the process is exiting, so nothing new is enqueued after
 * the final splice above and the set cannot grow again.
 */
export async function flushOtel(): Promise<void> {
  await flush(true)
  await Promise.allSettled([...inFlight])
}

if (ENABLED) {
  const timer = setInterval(() => void flush(), FLUSH_INTERVAL_MS)
  // Unref'd so a pending flush interval can never be the reason the process stays alive.
  timer.unref?.()
}

// ── Test-only seam ───────────────────────────────────────────────────────────
// otel.test.ts observes the real span/log records built by the real code path without a live
// endpoint (ENABLED stays false across the whole `bun test` process — OTEL_EXPORTER_OTLP_
// ENDPOINT is unset there, per env.ts) and exercises the network primitive directly against a
// stubbed `fetch`.
export const _test = {
  onSpanExport(hook: ((record: SpanRecord) => void) | null): void {
    spanHook = hook
  },
  onLogExport(hook: ((record: LogRecord) => void) | null): void {
    logHook = hook
  },
  postBatch,
}
