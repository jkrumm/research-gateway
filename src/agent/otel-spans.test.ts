import { describe, it, expect, afterAll, beforeEach, afterEach } from 'bun:test'
import type { SpanRecord } from '../lib/otel.js'
import type { RetrievalLedger } from './ledger.js'

// `fetch-chain.ts` imports `env.ts`, which parses `process.env` at import time and throws
// without secrets — so the module graph is pulled in with a dynamic import AFTER these are
// set, rather than by a hoisted static import. Same reason run.test.ts imports from
// `assemble.ts` instead of `run.ts`. `??=` so a real environment is never clobbered.
process.env['API_SECRET'] ??= 'test-secret'
process.env['IU_BASE_URL'] ??= 'https://example.invalid/v1'
process.env['IU_API_KEY'] ??= 'test-key'
process.env['TAVILY_API_KEY'] ??= 'test-key'
// A literal, public, non-routable IP (TEST-NET-3): the render step fetches this directly with
// no SSRF/DNS round trip, so the stub below is the only thing it can reach.
//
// Assigned, NOT `??=`. This one steers routing: the waterfall test recognises the render step
// by matching this host, so an inherited value sends the chain past lightpanda into
// tavily-extract and wayback and the assertion fails. CI has a real LIGHTPANDA_URL in scope,
// which is exactly how that happened.
process.env['LIGHTPANDA_URL'] = 'http://203.0.113.10:7781'

const { runFetchChain } = await import('./fetch-chain.js')
// The chain reads env.LIGHTPANDA_URL, and `env.ts` parses process.env ONCE at first import.
// Under `bun test` the module registry is shared across files, so if any earlier file imported
// it the assignment above arrived too late and the chain calls the inherited URL instead. Read
// back what the chain will actually use and match the stub against that, so this test is
// correct under any import order.
const RENDER_HOST = new URL((await import('../env.js')).env.LIGHTPANDA_URL ?? 'http://203.0.113.10:7781').host
const { createLedger } = await import('./ledger.js')
const { buildTools } = await import('./tools.js')
const { _test, withSpan } = await import('../lib/otel.js')

// TEST-NET-3 again for the page itself — a literal IP resolves through `lookup()` without a
// DNS query, so the SSRF guard passes offline and no test here touches the network.
const PAGE = 'https://203.0.113.20/page'

const attrOf = (attrs: Array<{ key: string; value: Record<string, unknown> }>, key: string): unknown =>
  Object.values(attrs.find((a) => a.key === key)?.value ?? {})[0]

const realFetch = globalThis.fetch
afterAll(() => {
  globalThis.fetch = realFetch
})

let spans: SpanRecord[] = []
beforeEach(() => {
  spans = []
  _test.onSpanExport((record) => spans.push(record))
})
afterEach(() => {
  _test.onSpanExport(null)
})

function stubFetch(handler: (url: string) => Response): void {
  globalThis.fetch = ((input: unknown) => Promise.resolve(handler(String(input)))) as typeof fetch
}

async function chain(url: string): Promise<{ attempts: Array<{ step: string }>; events: SpanRecord['events'] }> {
  const result = await withSpan(
    'tool.fetchPage',
    {},
    async () => runFetchChain(url, { ledger: createLedger() }),
    'client',
  )
  const span = spans.find((s) => s.name === 'tool.fetchPage')
  expect(span).toBeDefined()
  return { attempts: result.attempts, events: (span!.events ?? []).filter((e) => e.name === 'fetch.step') }
}

// The fetch waterfall is the highest-value thing the trace carries — which step rescued a page,
// or which one lost it. It is emitted as span EVENTS from a single place in runFetchChain, so
// the invariant worth pinning is exactly that: one `fetch.step` event per recorded attempt, in
// order, on every terminal path the chain has.
describe('runFetchChain span events', () => {
  it('emits one fetch.step event per attempt when the chain succeeds at the first step', async () => {
    stubFetch(
      () =>
        new Response('{"version":"1.2.3"}', { status: 200, headers: { 'content-type': 'application/json' } }),
    )

    const { attempts, events } = await chain(PAGE)

    expect(attempts.map((a) => a.step)).toEqual(['raw'])
    expect(events).toHaveLength(attempts.length)
    expect(events!.map((e) => attrOf(e.attributes, 'step'))).toEqual(['raw'])
    expect(attrOf(events![0]!.attributes, 'ok')).toBe(true)
  })

  it('emits one event per attempt across a multi-step waterfall, in attempt order', async () => {
    const rendered = 'Real page content. '.repeat(200)
    stubFetch((url) =>
      url.includes(RENDER_HOST)
        ? new Response(JSON.stringify({ ok: true, text: rendered, status: 200 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        : // Thin HTML: Readability finds nothing usable, so the chain falls through to the
          // renderer, which answers — two attempts, two events.
          new Response('<html><body><p>hi</p></body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
    )

    const { attempts, events } = await chain(PAGE)

    expect(attempts.map((a) => a.step)).toEqual(['readability', 'lightpanda'])
    expect(events).toHaveLength(attempts.length)
    expect(events!.map((e) => attrOf(e.attributes, 'step'))).toEqual(attempts.map((a) => a.step))
    expect(events!.map((e) => attrOf(e.attributes, 'ok'))).toEqual([false, true])
  })

  it('emits the events on the failure path too, not just on success', async () => {
    // 404 is definitively-missing: the chain stops at step 1 and returns via `fail`.
    stubFetch(() => new Response('nope', { status: 404 }))

    const { attempts, events } = await chain(PAGE)

    expect(attempts.map((a) => a.step)).toEqual(['readability'])
    expect(events).toHaveLength(attempts.length)
    expect(attrOf(events![0]!.attributes, 'ok')).toBe(false)
  })

  it('emits nothing when the SSRF refusal returns before any attempt was recorded', async () => {
    stubFetch(() => new Response('unreachable', { status: 200 }))

    const { attempts, events } = await chain('http://127.0.0.1/secret')

    expect(attempts).toHaveLength(0)
    expect(events).toHaveLength(0)
  })
})

// `instrument()` in tools.ts wraps EVERY tool's execute in a span. The invariant that makes
// that safe is that it is invisible to the loop: same return value out, same error object
// thrown. It is not exported, so these drive it the way production does — through buildTools —
// picking the two tool paths that settle without touching the network.
type ToolRecord = ReturnType<typeof buildTools>
type ExecuteOptions = Parameters<NonNullable<ToolRecord[string]['execute']>>[1]
const EXEC_OPTS: ExecuteOptions = { toolCallId: 'test-call', messages: [], context: undefined }

function runTool(tools: ToolRecord, name: string, input: unknown): Promise<unknown> {
  const t = tools[name]
  if (!t?.execute) throw new Error(`tool ${name} has no execute`)
  return Promise.resolve(t.execute(input, EXEC_OPTS))
}

describe('instrument() passthrough', () => {
  it('returns the tool result unchanged, under a span named after the tool', async () => {
    const tools = buildTools({ ledger: createLedger(), jobId: 'test-job' })

    // An empty package name is rejected by `badPackageName` before any lookup, so this is
    // the tool's own return value with nothing else in the way.
    const result = await runTool(tools, 'packageInfo', { ecosystem: 'npm', name: '' })

    expect(result).toEqual({ error: expect.any(String) })
    expect(spans.map((s) => s.name)).toContain('tool.packageInfo')
  })

  it('propagates the SAME error object when a tool throws', async () => {
    const boom = new Error('ledger exploded')
    // The ledger is the one injected dependency reachable without a live model: findPackages
    // calls recordRetrieved outside any try/catch once the registry answers.
    const ledger: RetrievalLedger = {
      ...createLedger(),
      recordRetrieved() {
        throw boom
      },
    }
    stubFetch(
      () =>
        new Response('{"objects":[]}', { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    const tools = buildTools({ ledger, jobId: 'test-job' })

    let thrown: unknown = null
    try {
      await runTool(tools, 'findPackages', { registry: 'npm', query: 'elysia' })
    } catch (err) {
      thrown = err
    }

    // Identity, not shape: withSpan records the exception and rethrows it untouched.
    expect(thrown).toBe(boom)
    const span = spans.find((s) => s.name === 'tool.findPackages')
    expect(span?.status.code).toBe(2)
  })

  it('leaves every tool it wraps otherwise intact — only execute is replaced', async () => {
    const tools = buildTools({ ledger: createLedger(), jobId: 'test-job' })

    for (const [name, t] of Object.entries(tools)) {
      expect(typeof t.execute, `${name}.execute`).toBe('function')
      expect(t.description, `${name}.description`).toBeTruthy()
      expect(t.inputSchema, `${name}.inputSchema`).toBeDefined()
    }
  })
})
