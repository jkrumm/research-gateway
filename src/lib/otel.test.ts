import { describe, it, expect } from 'bun:test'
// Type-only, so it is erased at compile time and does NOT pull the module in ahead of the
// env assignments below.
import type { SpanRecord, LogRecord } from './otel.js'
// `otel.ts` imports `env.ts`, which parses `process.env` at import time and throws without
// secrets — the opposite of the zero-env convention `usage.test.ts` / `job-db.test.ts` rely
// on, and unavoidable here since the module reads OTEL_* config. So: fill the required vars
// with placeholders FIRST, then load the module through a dynamic import (a static one would
// be hoisted above these assignments). OTEL_EXPORTER_OTLP_ENDPOINT stays deliberately unset,
// which is the production-realistic "disabled" path — every assertion below observes the real
// records through the `_test` hooks, which fire regardless of that gate.
process.env['API_SECRET'] ??= 'test-secret'
process.env['IU_BASE_URL'] ??= 'https://iu.example/v1'
process.env['IU_API_KEY'] ??= 'test-key'
process.env['TAVILY_API_KEY'] ??= 'test-key'

const { traceIdFromJobId, parseResourceAttributesEnv, withSpan, withRootSpan, emitOtelLog, flushOtel, _test } =
  await import('./otel.js')

/** Collect every span record built while `fn` runs. */
async function captureSpans(fn: () => Promise<void>): Promise<SpanRecord[]> {
  const records: SpanRecord[] = []
  _test.onSpanExport((r) => records.push(r))
  try {
    await fn()
  } finally {
    _test.onSpanExport(null)
  }
  return records
}

/** Collect every log record built while `fn` runs. */
async function captureLogs(fn: () => Promise<void>): Promise<LogRecord[]> {
  const records: LogRecord[] = []
  _test.onLogExport((r) => records.push(r))
  try {
    await fn()
  } finally {
    _test.onLogExport(null)
  }
  return records
}

function byName(records: SpanRecord[], name: string): SpanRecord {
  const found = records.find((r) => r.name === name)
  if (!found) throw new Error(`no span named ${name} in [${records.map((r) => r.name).join(', ')}]`)
  return found
}

describe('traceIdFromJobId', () => {
  it('returns the dash-stripped UUID as 32 lowercase hex', () => {
    expect(traceIdFromJobId('0189D4F1-2A3B-4C5D-8E9F-A0B1C2D3E4F5')).toBe(
      '0189d4f12a3b4c5d8e9fa0b1c2d3e4f5',
    )
  })

  it('falls back to a fresh random trace id for a non-UUID job id', () => {
    // `'-'` is the synthetic job id this repo uses off the job path.
    const a = traceIdFromJobId('-')
    const b = traceIdFromJobId('-')
    expect(a).toMatch(/^[0-9a-f]{32}$/)
    expect(b).toMatch(/^[0-9a-f]{32}$/)
    expect(a).not.toBe(b)
  })
})

describe('span context propagation', () => {
  it('parents a nested withSpan to its root and keeps the root trace id', async () => {
    const traceId = traceIdFromJobId('0189d4f1-2a3b-4c5d-8e9f-a0b1c2d3e4f5')
    let rootSpanId = ''
    const records = await captureSpans(async () => {
      await withRootSpan({ traceId, name: 'job', attrs: { jobId: 'x' } }, async (root) => {
        rootSpanId = root.spanId
        await withSpan('plan', {}, async () => {})
      })
    })

    const child = byName(records, 'plan')
    expect(child.traceId).toBe(traceId)
    expect(child.parentSpanId).toBe(rootSpanId)
    expect(byName(records, 'job').traceId).toBe(traceId)
  })

  it('parents concurrent sibling spans to the root, not to each other', async () => {
    let rootSpanId = ''
    const records = await captureSpans(async () => {
      await withRootSpan({ traceId: traceIdFromJobId('-'), name: 'job' }, async (root) => {
        rootSpanId = root.spanId
        // Mirrors the worker fan-out: several spans started concurrently in one root.
        await Promise.all([
          withSpan('worker.0', {}, async () => {}),
          withSpan('worker.1', {}, async () => {}),
        ])
      })
    })

    const a = byName(records, 'worker.0')
    const b = byName(records, 'worker.1')
    expect(a.parentSpanId).toBe(rootSpanId)
    expect(b.parentSpanId).toBe(rootSpanId)
    expect(a.spanId).not.toBe(b.spanId)
    expect(a.traceId).toBe(b.traceId)
  })
})

describe('withSpan', () => {
  it('records the exception, marks the span errored, and re-throws', async () => {
    let thrown: unknown = null
    const records = await captureSpans(async () => {
      try {
        await withSpan('boom', {}, async () => {
          throw new Error('kaboom')
        })
      } catch (err) {
        thrown = err
      }
    })

    expect(thrown).toBeInstanceOf(Error)
    const span = byName(records, 'boom')
    expect(span.status.code).toBe(2)
    expect(span.status.message).toBe('kaboom')
    const exception = span.events?.find((e) => e.name === 'exception')
    expect(exception).toBeDefined()
    expect(exception?.attributes).toContainEqual({
      key: 'exception.message',
      value: { stringValue: 'kaboom' },
    })
  })

  it('exports events added via addEvent', async () => {
    const records = await captureSpans(async () => {
      await withSpan('fetch', {}, async (span) => {
        span.addEvent('fetch.retry', { attempt: 2 })
      })
    })

    const event = byName(records, 'fetch').events?.find((e) => e.name === 'fetch.retry')
    expect(event).toBeDefined()
    expect(event?.attributes).toContainEqual({ key: 'attempt', value: { intValue: '2' } })
  })
})

describe('emitOtelLog', () => {
  it('maps the event name to the body and classifies severity', async () => {
    const [record] = await captureLogs(async () => {
      emitOtelLog('worker.failed', { error: 'x' })
    })

    expect(record?.body.stringValue).toBe('worker.failed')
    expect(record?.severityText).toBe('ERROR')
    expect(record?.severityNumber).toBe(17)
    expect(record?.attributes).toContainEqual({ key: 'error', value: { stringValue: 'x' } })
  })

  it('stamps the active span ids inside a span and none outside one', async () => {
    let spanIds = { traceId: '', spanId: '' }
    const records = await captureLogs(async () => {
      await withSpan('job', {}, async (span) => {
        spanIds = { traceId: span.traceId, spanId: span.spanId }
        emitOtelLog('research.start', {})
      })
      emitOtelLog('research.done', {})
    })

    const inside = records.find((r) => r.body.stringValue === 'research.start')
    expect(inside?.traceId).toBe(spanIds.traceId)
    expect(inside?.spanId).toBe(spanIds.spanId)

    const outside = records.find((r) => r.body.stringValue === 'research.done')
    expect(outside?.traceId).toBeUndefined()
    expect(outside?.spanId).toBeUndefined()
  })
})

describe('parseResourceAttributesEnv', () => {
  it('parses comma-separated key=value pairs and trims them', () => {
    expect(parseResourceAttributesEnv('host.name=vps, deployment.environment=production')).toEqual({
      'host.name': 'vps',
      'deployment.environment': 'production',
    })
  })

  it('skips malformed pairs with no `=` and keeps the rest', () => {
    expect(parseResourceAttributesEnv('a=1,garbage,b=2')).toEqual({ a: '1', b: '2' })
  })

  it('returns an empty object for the empty string — the unset-env default', () => {
    expect(parseResourceAttributesEnv('')).toEqual({})
  })
})

/** Swap in a `fetch` stub for the duration of `fn`, always restoring the real one. */
async function withStubbedFetch(stub: () => Promise<unknown>, fn: () => Promise<void>): Promise<void> {
  const realFetch = globalThis.fetch
  // `unknown` first: Bun's `typeof fetch` carries a `preconnect` property a bare stub has no
  // reason to implement.
  globalThis.fetch = stub as unknown as typeof fetch
  try {
    await fn()
  } finally {
    globalThis.fetch = realFetch
  }
}

describe('postBatch', () => {
  it('resolves rather than throwing when the collector is unreachable', async () => {
    await withStubbedFetch(
      () => Promise.reject(new Error('connection refused')),
      async () => {
        const posted = _test.postBatch('http://collector.invalid/v1/traces', {})
        await expect(posted).resolves.toBeUndefined()
      },
    )
  })

  it('resolves rather than throwing when the collector rejects the batch', async () => {
    await withStubbedFetch(
      () => Promise.resolve({ ok: false, status: 503, statusText: 'Service Unavailable' }),
      async () => {
        const posted = _test.postBatch('http://collector.invalid/v1/traces', {})
        await expect(posted).resolves.toBeUndefined()
      },
    )
  })
})

describe('flushOtel', () => {
  // The shutdown path index.ts races against a 2s deadline: it must neither reject nor hang,
  // including while a batch post is still in flight.
  it('resolves without throwing while a post is outstanding', async () => {
    await withStubbedFetch(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ ok: true, status: 200, statusText: 'OK' }), 1),
        ),
      async () => {
        void _test.postBatch('http://collector.invalid/v1/logs', {})
        await expect(flushOtel()).resolves.toBeUndefined()
      },
    )
  })
})
