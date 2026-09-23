// Main-thread side of the off-main-thread HTML parser (see parse-worker.ts). Exposes two async
// functions — `extractText` (site adapter, then Readability) and `readabilityText` (Readability
// only, for the Wayback step) — that funnel the synchronous linkedom/Readability work into a
// small pool of Bun Workers, so parsing never blocks the event loop that serves /health and
// the HTTP listener (issue #21).
//
// The pool is lazy and long-lived: workers spawn on first use and are reused until process
// exit. Each worker is `unref`'d so a live pool does not keep the process open on its own — in
// production the HTTP server is the handle that keeps the loop alive, and `bun test` exits
// cleanly with a live pool. A worker handles exactly one parse at a time, so its `message`
// event is unambiguously the reply to the request it was handed.
//
// Dependency-free by design (no env/log/fetch import) — same convention as ledger/extract.

type ParseRequest =
  | { kind: 'extract'; url: string; body: string }
  | { kind: 'readability'; body: string }

type ParseResponse =
  | { ok: true; via: 'site-adapter' | 'readability'; text: string | null }
  | { ok: false; error: string }

export interface ExtractedText {
  via: 'site-adapter' | 'readability'
  text: string | null
}

interface Pending {
  req: ParseRequest
  resolve: (res: ParseResponse) => void
  signal?: AbortSignal | undefined
}

// Sized so a burst of concurrent fetches queues rather than spawning unbounded workers, while
// one pathological parse cannot serialize every other fetch's. Parse is fast relative to the
// network steps that feed it, so throughput is not the point — keeping the loop responsive is.
const POOL_SIZE = 4
const WORKER_URL = new URL('./parse-worker.ts', import.meta.url)

const idle: Worker[] = []
const queue: Pending[] = []
const inFlight = new Map<Worker, Pending>()
let spawned = 0
let dispatched = 0

function spawnWorker(): Worker {
  spawned++
  const w = new Worker(WORKER_URL)
  // The pool must not keep the process open on its own: the HTTP server is what keeps the
  // loop alive in production, and `bun test` exits cleanly with a live pool. The worker still
  // runs normally while the loop is otherwise busy.
  w.unref()
  w.onmessage = (e: MessageEvent<ParseResponse>) => finish(w, e.data)
  w.onerror = (e) => {
    // Only a catastrophic failure (the worker module failed to load) reaches here — every
    // parse error is caught inside the worker and answered `{ ok: false }`. Resolve the
    // in-flight job, if any, and retire the dead worker so the pool does not hand it more work.
    retire(w, `parse worker failed: ${e.message}`)
  }
  return w
}

// Kill a worker that can no longer be trusted with work — its module failed to load, or its
// parse outran the caller's budget (pathological markup can spin linkedom/Readability far
// longer than any fetch is allowed to take) — fail its job and hand the slot to a fresh worker,
// so one stuck parse neither hangs its caller nor permanently shrinks the pool.
function retire(w: Worker, error: string): void {
  const job = inFlight.get(w)
  inFlight.delete(w)
  spawned--
  w.terminate()
  if (job) job.resolve({ ok: false, error })
  const next = queue.shift()
  if (next) run(spawnWorker(), next)
  else idle.push(spawnWorker())
}

function run(w: Worker, job: Pending): void {
  dispatched++
  inFlight.set(w, job)
  w.postMessage(job.req)
  job.signal?.addEventListener('abort', () => {
    if (inFlight.get(w) === job) retire(w, 'parse aborted: fetch chain budget exhausted')
  }, { once: true })
}

function finish(w: Worker, res: ParseResponse): void {
  const job = inFlight.get(w)
  if (!job) return // an error delivered after the reply was already handled — nothing to do
  inFlight.delete(w)
  job.resolve(res)
  const next = queue.shift()
  if (next) run(w, next)
  else idle.push(w)
}

function request(req: ParseRequest, signal?: AbortSignal): Promise<ParseResponse> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve({ ok: false, error: 'parse aborted: fetch chain budget exhausted' })
    const job: Pending = { req, resolve, signal }
    const w = idle.pop()
    if (w) return run(w, job)
    if (spawned < POOL_SIZE) return run(spawnWorker(), job)
    queue.push(job)
    // A job still queued when the budget fires leaves the queue without ever reaching a worker.
    signal?.addEventListener('abort', () => {
      const i = queue.indexOf(job)
      if (i === -1) return
      queue.splice(i, 1)
      resolve({ ok: false, error: 'parse aborted: fetch chain budget exhausted' })
    }, { once: true })
  })
}

async function parse(req: ParseRequest, signal?: AbortSignal): Promise<ExtractedText> {
  const res = await request(req, signal)
  if (!res.ok) throw new Error(res.error)
  return { via: res.via, text: res.text }
}

// Step 1 of the fetch chain: the site adapter's reader when one applies, Readability otherwise.
export function extractText(url: string, body: string, signal?: AbortSignal): Promise<ExtractedText> {
  return parse({ kind: 'extract', url, body }, signal)
}

// The Wayback step: plain Readability, no site adapter (see fetch-chain.ts's tryWayback).
export function readabilityText(body: string, signal?: AbortSignal): Promise<{ text: string | null }> {
  return parse({ kind: 'readability', body }, signal).then((r) => ({ text: r.text }))
}

// Test-only seam — see fetch-chain.test.ts. `dispatched` proves a parse actually left the
// main thread (the worker pool would otherwise be invisible to an assertion).
export const _test = {
  get dispatched(): number {
    return dispatched
  },
}
