// Runs the fetch chain's HTML parse (linkedom + a site adapter or Readability, then
// `normalizeText`) on a small pool of Bun Workers instead of the main event loop.
//
// `PARSE_INPUT_CAP` (response-kind.ts) still bounds worker memory and the structured-clone
// copy of the HTML string across the thread boundary — moving the parse off-loop does not
// make an unbounded document free, it makes a BOUNDED one non-blocking for everything else
// this process does (heartbeats, the idle watchdog, the HTTP listener). Measured in this
// file's own test (`parse-pool.test.ts`, the liveness case): a ~1.5M-char document parsed
// inline can stall a 20ms tick for well over a second; through the pool the same document
// keeps the main thread's worst tick gap under 250ms.
//
// Env-free by design (no env.js/log.js import, same convention as ledger.ts/extract.ts) so it
// stays unit-testable without booting the env/LLM import chain. A caller that wants a log
// line passes `onEvent` — this module never decides how (or whether) to log.
//
// Workers are lazily created on first `parse()` call and `unref()`d immediately, so importing
// this module — or an idle process that never fetches a page — carries no worker at all.

export interface ParseResult {
  via: 'site-adapter' | 'readability'
  text: string | null
}

export interface ParsePoolEvent {
  event: 'worker_hang' | 'worker_error'
  workerIndex: number
  detail: string
}

export interface ParsePoolOptions {
  /** Number of persistent workers. Defaults to 2. */
  size?: number
  /**
   * How long one parse may run before its worker is terminated and replaced. Defaults to
   * 60s — a per-operation hang guard on one worker's unit of work (a parse), not a job-level
   * or wall-clock cap on the run itself (see ~/.claude/rules/agent-limits.md): the job that
   * asked for this page simply sees the parse as a miss and falls through to the next fetch
   * step, exactly as a thrown error already does.
   */
  hangGuardMs?: number
  /**
   * The worker script this pool spawns. Defaults to `./parse-worker.ts` next to this module —
   * overridable so a test can point at a fixture worker that behaves in a specific broken way
   * (never replies, throws on message) without editing the production entry.
   */
  workerUrl?: string | URL
  /** Structured events for the caller to log; the pool itself never imports log.js. */
  onEvent?: ((e: ParsePoolEvent) => void) | undefined
}

interface ParseRequest {
  id: number
  html: string
  url: string
}

type ParseResponse =
  | { id: number; via: 'site-adapter' | 'readability'; text: string | null }
  | { id: number; error: string }

interface RunningJob {
  id: number
  resolve: (r: ParseResult) => void
  reject: (err: Error) => void
  hangTimer: ReturnType<typeof setTimeout>
}

interface QueuedJob {
  request: ParseRequest
  resolve: (r: ParseResult) => void
  reject: (err: Error) => void
}

interface Slot {
  worker: Worker
  current: RunningJob | null
}

const DEFAULT_SIZE = 2
const DEFAULT_HANG_GUARD_MS = 60_000

export class ParsePool {
  private readonly size: number
  private readonly hangGuardMs: number
  private readonly workerUrl: string | URL
  private readonly onEvent: ((e: ParsePoolEvent) => void) | undefined
  private slots: Slot[] | null = null
  private readonly queue: QueuedJob[] = []
  private nextId = 1

  constructor(opts: ParsePoolOptions = {}) {
    this.size = opts.size ?? DEFAULT_SIZE
    this.hangGuardMs = opts.hangGuardMs ?? DEFAULT_HANG_GUARD_MS
    this.workerUrl = opts.workerUrl ?? new URL('./parse-worker.ts', import.meta.url)
    this.onEvent = opts.onEvent
  }

  private ensureSlots(): Slot[] {
    if (this.slots) return this.slots
    this.slots = Array.from({ length: this.size }, (_unused, index) => this.spawn(index))
    return this.slots
  }

  private spawn(index: number): Slot {
    const worker = new Worker(this.workerUrl)
    worker.unref()
    const slot: Slot = { worker, current: null }
    // A crash fires BOTH `error` and `close` on the same dead worker, in no guaranteed order,
    // and `replace()` runs on the first one to arrive — so the second is always a STALE event
    // from a worker this slot no longer holds. Without this identity check, that late event
    // reads `this.slots[index].current` after the slot has moved on to its NEXT job and
    // rejects that job instead of the one that actually died — measured while writing this
    // pool's own tests, where a terminated worker's delayed `close` reached in and failed the
    // following, unrelated parse.
    const isCurrent = (): boolean => this.slots?.[index]?.worker === worker
    worker.addEventListener('message', (event) => {
      if (!isCurrent()) return
      this.handleMessage(index, (event as MessageEvent<ParseResponse>).data)
    })
    worker.addEventListener('error', (event) => {
      if (!isCurrent()) return
      this.handleFailure(index, (event as ErrorEvent).message || 'worker error')
    })
    worker.addEventListener('close', () => {
      if (!isCurrent()) return
      this.handleFailure(index, 'worker closed unexpectedly')
    })
    return slot
  }

  private replace(index: number): void {
    const slots = this.slots
    if (!slots) return
    try {
      slots[index]!.worker.terminate()
    } catch {
      // already gone
    }
    slots[index] = this.spawn(index)
    this.onEvent?.({ event: 'worker_error', workerIndex: index, detail: 'replaced' })
  }

  private handleMessage(index: number, response: ParseResponse): void {
    const slots = this.slots
    if (!slots) return
    const slot = slots[index]!
    const job = slot.current
    // A reply from a job already timed out and had its slot replaced — the new slot's
    // `current` is either null or a different job's id, so this is discarded rather than
    // resolving/rejecting the wrong promise.
    if (!job || job.id !== response.id) return
    clearTimeout(job.hangTimer)
    slot.current = null
    if ('error' in response) job.reject(new Error(response.error))
    else job.resolve({ via: response.via, text: response.text })
    this.dispatchNext(index)
  }

  private handleFailure(index: number, detail: string): void {
    const slots = this.slots
    const job = slots?.[index]?.current ?? null
    if (job) clearTimeout(job.hangTimer)
    this.onEvent?.({ event: 'worker_error', workerIndex: index, detail })
    this.replace(index)
    job?.reject(new Error(`parse worker failed: ${detail}`))
    this.dispatchNext(index)
  }

  private dispatchNext(index: number): void {
    const slots = this.slots
    if (!slots) return
    const slot = slots[index]!
    if (slot.current) return // still busy — a message and a queued dispatch raced
    const next = this.queue.shift()
    if (!next) return
    this.run(index, next.request, next.resolve, next.reject)
  }

  private run(index: number, request: ParseRequest, resolve: (r: ParseResult) => void, reject: (err: Error) => void): void {
    const slots = this.slots!
    const slot = slots[index]!
    const hangTimer = setTimeout(() => {
      this.onEvent?.({ event: 'worker_hang', workerIndex: index, detail: `${this.hangGuardMs}ms` })
      slot.current = null
      this.replace(index)
      reject(new Error(`parse hang guard (${this.hangGuardMs}ms)`))
      this.dispatchNext(index)
    }, this.hangGuardMs)
    hangTimer.unref?.()
    slot.current = { id: request.id, resolve, reject, hangTimer }
    slot.worker.postMessage(request)
  }

  /** Parses one document. Never throws synchronously — a hang, a crash and a parse error all reject the returned promise. */
  parse(input: { html: string; url: string }): Promise<ParseResult> {
    const slots = this.ensureSlots()
    const request: ParseRequest = { id: this.nextId++, html: input.html, url: input.url }
    return new Promise((resolve, reject) => {
      const freeIndex = slots.findIndex((s) => !s.current)
      if (freeIndex === -1) {
        this.queue.push({ request, resolve, reject })
        return
      }
      this.run(freeIndex, request, resolve, reject)
    })
  }
}

let sharedPool: ParsePool | null = null

/** The process-wide pool `fetch-chain.ts` parses through. Lazily created on first call. */
export function getParsePool(): ParsePool {
  if (!sharedPool) sharedPool = new ParsePool()
  return sharedPool
}
