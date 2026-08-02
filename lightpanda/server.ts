// A thin HTTP front for `lightpanda fetch --dump markdown`, run as a sidecar next to the
// gateway. POST /render {url} -> {ok:true,text,status} | {ok:false,error}.
//
// WHY A SIDECAR RATHER THAN IN THE GATEWAY CONTAINER
//
// Three measurements, taken on the VPS against lightpanda 0.3.6 on 2026-08-02, and one of
// them is not a judgement call:
//
//   1. The binary is dynamically linked against glibc (`ldd` resolves libc.so.6,
//      ld-linux-x86-64.so.2). The gateway image is oven/bun:1.3-ALPINE — musl. It cannot
//      execute this binary at all without changing the gateway's base image.
//   2. Peak RSS per render is 100-205 MB with the heap cap below, and 479 MB on a real page
//      (bun.com/docs) without it. The gateway runs at ~151 MiB under a 512 MiB limit; a
//      single uncapped render inside it is an OOM kill of the whole service, which takes
//      every in-flight research job with it.
//   3. The binary is 153 MB — roughly triple the gateway image, for a step that fires on
//      about 11% of fetches.
//
// (2) is the one that decides the shape rather than merely the size. A renderer is the least
// reliable component in the chain — beta software, driving hostile third-party JavaScript,
// with no upper bound on what a page asks for. Putting it in its own memory cgroup means its
// worst day costs one fetch, which falls through to Tavily Extract, instead of costing every
// running job. That is the whole trade, and it is why the semaphore lives HERE and not in the
// gateway: this process is what owns the memory budget, and it is the only place that knows
// how many renders that budget can hold. The gateway has 8 workers per job and up to 3
// concurrent jobs; there is no single point over there that could enforce this.
//
// WHY `fetch` PER RENDER RATHER THAN `lightpanda serve` (CDP)
//
// A CDP client is a real dependency in the gateway for a step that wants one string back, and
// the markdown dump already replaces Readability for these pages. But the deciding reason is
// again memory: `serve` keeps one long-lived browser whose heap is shared across renders, so
// one pathological page degrades every render after it. One process per render means the
// page's memory dies with the page — an unbounded page is bounded by process exit.

import { parseLightpandaStdout, type RenderResult } from './parse.js'
import { createSemaphore } from './semaphore.js'

// The gateway validates its whole environment through zod at boot (src/env.ts) precisely so a
// bad value fails loudly instead of degrading at request time. This service has no zod (it
// ships with no dependencies at all), so it gets the same guarantee the short way. It is not
// theoretical: `RENDER_MAX_CONCURRENCY=""` makes `Number('')` zero, and a zero-slot semaphore
// never admits anyone — every render would queue and time out, on a container reporting
// healthy. A stringified NaN would likewise be handed to the browser as `--v8-max-heap-mb NaN`.
function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got ${JSON.stringify(raw)}`)
  }
  return value
}

const PORT = numberFromEnv('PORT', 7781)
const BIN = process.env['LIGHTPANDA_BIN'] ?? '/usr/local/bin/lightpanda'

// Sized against the measured worst case: 205 MB for the heaviest page in the sweep, at the
// heap cap below. 3 x 205 MB + this Bun process (~50 MB) = ~665 MB, which is what the 768 MiB
// `mem_limit` in deploy/compose.yml is derived from. Change one, recompute the other.
const MAX_CONCURRENCY = numberFromEnv('RENDER_MAX_CONCURRENCY', 3)

// The single most valuable flag on the binary. Measured across 8 real pages at caps of 32, 64
// and none: at 64 the extracted content is byte-identical to uncapped on every one of them,
// while worst-case RSS drops 479 -> 205 MB and worst-case wall time 32.2s -> 9.3s (V8 spends
// the difference growing and collecting a heap nothing reads).
//
// 32 is NOT safe and is the reason this number is measured rather than guessed: it returned
// 2,517 chars of techempower.com/benchmarks where 64 and uncapped both return 4,627. That is
// a silent 45% content loss on the exact page this feature exists for, and it lands well above
// the 200-char floor, so nothing downstream would have flagged it.
//
// Note that lightpanda logs `JS heap limit reached` whenever the cap binds, INCLUDING on pages
// where the extracted content is identical to uncapped. It is a curiosity, not a defect
// signal — do not wire an alert to it.
const V8_MAX_HEAP_MB = numberFromEnv('RENDER_V8_MAX_HEAP_MB', 64)

// lightpanda's own default `--wait-ms` is 5000 and it is the latency floor for almost every
// page: 7 of 8 pages in the sweep finished in 5.1s, a static one in 0.7s. Left at the default
// deliberately — this step only ever runs on pages whose text is not in the HTML, so cutting
// the settle time is cutting the one thing we came for.
const WAIT_MS = numberFromEnv('RENDER_WAIT_MS', 5000)

// Hard deadline for page JavaScript, then a longer hard deadline on the process itself. Both
// are needed: --terminate-ms stops a runaway script but still lets the dump be written (a
// partial page beats no page), while the process timeout covers the case where the binary
// itself wedges and never gets to the dump.
const TERMINATE_MS = numberFromEnv('RENDER_TERMINATE_MS', 20_000)
const PROCESS_TIMEOUT_MS = numberFromEnv('RENDER_TIMEOUT_MS', 35_000)

// How long a request will wait for a render slot before giving up. A caller that waits longer
// than this is worse off than one that fails fast: the gateway's fallback (Tavily Extract)
// costs a credit but answers in ~2s, and the resource actually being conserved over there is
// the worker step, not the credit.
const QUEUE_TIMEOUT_MS = numberFromEnv('RENDER_QUEUE_TIMEOUT_MS', 20_000)

// A dump is a whole page of markdown; 4 MiB is far above anything measured (the largest in the
// sweep was 68 KB) and exists only so a pathological page cannot grow this process's heap
// without limit. Exceeding it kills the render and fails the request, which is correct —
// the chain falls through to Tavily.
const MAX_STDOUT_BYTES = 4 * 1024 * 1024

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }))
}

const slots = createSemaphore(MAX_CONCURRENCY, QUEUE_TIMEOUT_MS)

// --- Render ------------------------------------------------------------------------------

async function readCapped(stream: ReadableStream<Uint8Array>, cap: number): Promise<{ text: string; truncated: boolean }> {
  const decoder = new TextDecoder()
  let text = ''
  let bytes = 0
  for await (const chunk of stream) {
    bytes += chunk.length
    if (bytes > cap) return { text, truncated: true }
    text += decoder.decode(chunk, { stream: true })
  }
  return { text: text + decoder.decode(), truncated: false }
}

async function render(url: string): Promise<RenderResult> {
  const proc = Bun.spawn(
    [
      BIN,
      'fetch',
      url,
      '--dump',
      'markdown',
      '--json',
      // Defense in depth. The gateway already refuses non-public URLs before it calls here
      // (lib/ssrf.ts), but this process reaches the internet on behalf of a URL it was
      // handed, and it sits on a Docker network with the gateway. It should not be usable
      // as a probe for anything on that network even if something upstream regresses.
      '--block-private-networks',
      '--v8-max-heap-mb',
      String(V8_MAX_HEAP_MB),
      '--wait-ms',
      String(WAIT_MS),
      '--terminate-ms',
      String(TERMINATE_MS),
    ],
    {
      stdout: 'pipe',
      // Inherited, not piped: page JS errors are unbounded in volume and are pure diagnostics
      // — every signal this function acts on is on stdout. Inheriting sends them to the
      // container log, where the json-file driver's max-size already bounds them, instead of
      // buffering them in this process's heap.
      stderr: 'inherit',
      timeout: PROCESS_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    },
  )

  const { text, truncated } = await readCapped(proc.stdout, MAX_STDOUT_BYTES)
  if (truncated) {
    // SIGKILL explicitly, not a bare kill(). Bun's `killSignal` option governs only the kill
    // its OWN timeout fires; a manual .kill() defaults to SIGTERM, which a page still busy in
    // JS does not honour promptly. That would hold a render slot — one of three — for the
    // remaining tens of seconds until the process timeout got around to it, which is the exact
    // stall this fast-fail path exists to avoid.
    proc.kill('SIGKILL')
    await proc.exited
    return { ok: false, error: `render output exceeded ${MAX_STDOUT_BYTES} bytes` }
  }

  const code = await proc.exited

  // The timeout path — and a trap worth spelling out, because it silently broke every render
  // the first time this ran against the real binary. Bun's `proc.killed` is NOT "was killed":
  // it reads true for a clean `exit 0` at 703ms just as it does for a SIGKILL at the deadline
  // (measured on Bun 1.3.14). Gating on it turned every successful render into "render timed
  // out". `signalCode` is the discriminator that actually holds — null on any exit the process
  // chose for itself, 'SIGKILL' only when the deadline fired.
  if (proc.signalCode) return { ok: false, error: `render timed out after ${PROCESS_TIMEOUT_MS}ms` }

  // A non-zero exit is the binary itself failing — a crash, a bad flag, an OOM kill of the
  // child by the cgroup. Distinct from "the page could not be read", which exits 0.
  if (code !== 0) return { ok: false, error: `lightpanda exited ${code}` }

  return parseLightpandaStdout(text)
}

// --- Server ------------------------------------------------------------------------------

const server = Bun.serve({
  port: PORT,
  idleTimeout: 0,
  fetch: async (req) => {
    const { pathname } = new URL(req.url)

    if (pathname === '/health') {
      return Response.json({ status: 'ok', active: slots.active, queued: slots.queued })
    }

    if (pathname !== '/render' || req.method !== 'POST') {
      return new Response('not found', { status: 404 })
    }

    let url: unknown
    try {
      url = ((await req.json()) as { url?: unknown }).url
    } catch {
      return Response.json({ ok: false, error: 'malformed JSON body' }, { status: 400 })
    }
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      return Response.json({ ok: false, error: 'body must be {"url":"http(s)://..."}' }, { status: 400 })
    }

    // Saturation is answered with a 200 envelope, not a 503, on purpose: to the caller this
    // is the same class of event as a page that would not render — a reason it has no text —
    // and it takes the same fallback. A non-2xx from this service should mean the service
    // itself is broken, which is a different thing and worth distinguishing in the gateway's
    // logs.
    const started = Date.now()
    if (!(await slots.acquire())) {
      log('render', { url, ok: false, error: 'queue timeout', queued: slots.queued })
      return Response.json({ ok: false, error: `no render slot within ${QUEUE_TIMEOUT_MS}ms` })
    }

    try {
      const result = await render(url)
      log('render', {
        url,
        ok: result.ok,
        ms: Date.now() - started,
        ...(result.ok ? { chars: result.text.length, status: result.status } : { error: result.error }),
      })
      return Response.json(result)
    } catch (err) {
      // This process must not die on a bad page. It is one link in the gateway's fallback
      // chain, and an unhandled rejection here would take the sidecar down for every
      // subsequent render, not just this one.
      log('render', { url, ok: false, error: String(err), ms: Date.now() - started })
      return Response.json({ ok: false, error: String(err) })
    } finally {
      slots.release()
    }
  },
})

log('lightpanda.listening', {
  port: server.port,
  bin: BIN,
  maxConcurrency: MAX_CONCURRENCY,
  v8MaxHeapMb: V8_MAX_HEAP_MB,
})
