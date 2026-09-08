import { env } from '../env.js'
import type { ResearchReport, Depth, JobStatus } from '../agent/schema.js'
import { openJobDb } from './job-db.js'
import { log } from './log.js'
import { admit, canDispatch, type AdmissionRefusal } from './admission.js'

export type { JobStatus }

export interface Job {
  jobId: string
  status: JobStatus
  query: string
  depth: Depth
  result?: ResearchReport
  error?: string
  createdAt: number
  startedAt?: number
  finishedAt?: number
  // Liveness proof for a non-terminal job, refreshed on an interval by the process that owns
  // it (see `startHeartbeat`) for the job's ENTIRE lifetime — from the moment it is created
  // (while 'queued', possibly for 30+ minutes behind other deep jobs) through 'running' to
  // completion. Absent only for a legacy pre-heartbeat row or a terminal job.
  heartbeatAt?: number
}

// Shown to a caller polling a job whose heartbeat went stale (or was never set) while it was
// 'queued' or 'running' — the process that was executing it is presumed gone, so there is
// nothing left to wait for. Status-only durability: the AGENT's own in-flight work is not
// resumed (checkpoint/resume is a separate, later change), so the honest answer is "lost,
// resubmit" rather than "still running" (which would leave a caller polling forever for work
// nobody is doing).
const INTERRUPTED_MESSAGE =
  'This research job was lost when the service restarted before it finished running. It cannot be resumed — resubmit the query.'

// Shown to a waiter still sitting in the semaphore queue when `beginDraining` rejects it: the
// job never started (unlike INTERRUPTED_MESSAGE, which covers one that was queued/running and
// lost its heartbeat), so there is nothing to reap on the next boot — just resubmit.
const DRAIN_QUEUED_MESSAGE =
  'This research job was still queued when the service began restarting. It never started — resubmit the query.'

// How often the owning process re-proves a job (queued OR running) is alive (see
// `startHeartbeat`), and how far behind that a heartbeat has to fall before another process
// may treat the job as dead. The gap between the two (90s vs 15s — 6 missed ticks) absorbs an
// occasional slow event-loop tick without a false reap; it is NOT meant to absorb a genuinely
// dead process for long, since that is exactly the scenario this whole mechanism exists to
// detect promptly.
const HEARTBEAT_INTERVAL_MS = 15_000
const HEARTBEAT_STALE_MS = 90_000

// `jobs` is the hot-path source of truth (getJob/job_wait poll it every couple seconds); `db`
// is the durable write-through so a job's status and terminal result survive a restart. Every
// create and status transition writes to both, synchronously — see createJob/updateJob below.
const db = openJobDb(env.JOB_DB_PATH)

const jobs = new Map<string, Job>()

// Job ids this process is actively heartbeating (see `startHeartbeat`). The map above is
// hydrated once at boot and thereafter only kept current for these — a job belonging to the
// SIBLING replica of a rolling deploy keeps changing in sqlite while this process's copy of it
// stays frozen at whatever it read at boot. `getJob` uses this to decide whose word to trust.
const owned = new Set<string>()

// ── Boot: hydrate from the durable store ────────────────────────────────────
// A job that reached 'done'/'error' survives with its full result. A job that was
// 'queued'/'running' with a stale (or absent) heartbeat is reaped straight to a terminal
// 'error' — never rehydrated as 'running' (see INTERRUPTED_MESSAGE above). Deliberately NOT a
// blanket "everything queued/running at boot is dead": rollhook's rolling deploy runs two
// replicas against the SAME sqlite file for a brief overlap, and the old replica may still be
// genuinely alive and heartbeating a job when this process boots. Only a stale heartbeat means
// nobody is left proving the job alive.
const reaped = db.reapInterrupted(INTERRUPTED_MESSAGE, Date.now() - HEARTBEAT_STALE_MS)
if (reaped.length > 0) {
  // Error level (otel-format.ts ERROR_EVENTS) with a `count`: every reaped job is one a caller
  // lost to a restart, and this line is what the HyperDX alert fires on.
  log('job.reaped', { count: reaped.length, jobIds: reaped.map((job) => job.jobId) })
}
for (const job of db.all()) {
  jobs.set(job.jobId, job)
}

// Surfaced on GET /health so a keyword monitor can see an unclean restart without log access.
// `reaped` is this boot's reap; `interrupted` also counts jobs reaped later on read (getJob).
const bootedAt = new Date().toISOString()
let interruptedCount = reaped.length

export function restartStats(): { lastRestartAt: string; reaped: number; interrupted: number } {
  return { lastRestartAt: bootedAt, reaped: reaped.length, interrupted: interruptedCount }
}

const JOB_TTL_MS = env.JOB_TTL_MINUTES * 60_000

function sweep(): void {
  const now = Date.now()
  for (const [id, job] of jobs) {
    // Only evict terminal jobs — never reap one that is still queued or running
    // (a queued job under sustained backlog could otherwise be deleted before it runs).
    if (job.status !== 'done' && job.status !== 'error') continue
    const age = now - (job.finishedAt ?? job.createdAt)
    if (age > JOB_TTL_MS) {
      jobs.delete(id)
      owned.delete(id)
      db.delete(id)
    }
  }
}

// Run sweep on an interval so the map doesn't grow unboundedly.
// .unref() ensures the timer doesn't prevent process exit on shutdown.
const _sweepTimer = setInterval(sweep, 60_000)
if (typeof _sweepTimer.unref === 'function') _sweepTimer.unref()

export function createJob(input: { query: string; depth: Depth }): Job {
  sweep()
  const job: Job = {
    jobId: crypto.randomUUID(),
    status: 'queued',
    query: input.query,
    depth: input.depth,
    createdAt: Date.now(),
  }
  jobs.set(job.jobId, job)
  db.put(job)
  return job
}

export function getJob(jobId: string): Job | undefined {
  let job = jobs.get(jobId)
  if (!job || (job.status !== 'running' && job.status !== 'queued')) return job

  // A non-terminal job this process does NOT own is being executed by the sibling replica of a
  // rolling deploy, which heartbeats it into the shared sqlite file this process never re-reads.
  // Trusting the boot-time snapshot here reaped a LIVE job ~90s after this replica booted and
  // wrote 'error' over the owner's row — the precise failure the drain exists to prevent,
  // reintroduced from the other side, and made far more likely by the drain itself: the old
  // replica now outlives the new one's boot by up to SHUTDOWN_DRAIN_MS instead of 2 seconds.
  if (!owned.has(jobId)) {
    const fresh = db.get(jobId)
    // A missing row means the cached snapshot is all there is (sweep only ever deletes terminal
    // jobs, so this is not reachable in practice) — fall through to the staleness check below
    // rather than hand back a 'running' job nothing is proving alive.
    if (fresh) {
      job = fresh
      jobs.set(jobId, fresh)
      if (fresh.status !== 'running' && fresh.status !== 'queued') return fresh
    }
  }

  // Read-time half of the heartbeat guarantee: a job hydrated at boot as 'queued'/'running'
  // (owned by whichever replica actually created or started it) can go stale between boot and
  // the next reapInterrupted call, which only runs once at startup. Without this check, a
  // caller could poll such an orphaned job and wait indefinitely. A job this process itself
  // owns has its heartbeatAt kept fresh by `startHeartbeat` for its entire queued+running
  // lifetime, so this never fires for genuinely live local work.
  const stale = job.heartbeatAt === undefined || Date.now() - job.heartbeatAt > HEARTBEAT_STALE_MS
  if (!stale) return job

  const reapedJob: Job = { ...job, status: 'error', error: INTERRUPTED_MESSAGE, finishedAt: Date.now() }
  jobs.set(jobId, reapedJob)
  db.put(reapedJob)
  interruptedCount++
  log('job.reaped_on_read', { jobId, count: 1 })
  return reapedJob
}

export function updateJob(jobId: string, patch: Partial<Job>): void {
  const job = jobs.get(jobId)
  if (!job) return
  const updated = { ...job, ...patch }
  jobs.set(jobId, updated)
  db.put(updated)
}

// Start (and immediately stamp) a liveness heartbeat for a running job. The caller — run-job.ts
// — starts this the moment a job transitions to 'running' and stops it in a `finally`, so the
// heartbeat runs for exactly the job's actual lifetime and clears on both success and failure.
// Returns a stop function; `.unref()` matches `_sweepTimer` so it never blocks process exit.
export function startHeartbeat(jobId: string): () => void {
  // Heartbeating a job IS owning it — this is the one place a job becomes this process's own,
  // and `getJob` reads `owned` to decide whether its cached copy is authoritative or has to be
  // re-read from the shared file. Kept in the set after the timer stops: the stop happens in
  // run-job.ts's `.finally()`, by which point the job is terminal and the cache is correct.
  owned.add(jobId)
  const tick = (): void => {
    const now = Date.now()
    const job = jobs.get(jobId)
    if (job) jobs.set(jobId, { ...job, heartbeatAt: now })
    db.touchHeartbeat(jobId, now)
  }
  tick()
  const timer = setInterval(tick, HEARTBEAT_INTERVAL_MS)
  if (typeof timer.unref === 'function') timer.unref()
  return () => clearInterval(timer)
}

// ── Semaphore ──────────────────────────────────────────────────────────────

// Tiny async semaphore to gate concurrent agent runs.
// Avoids reaching for p-limit for a few lines of logic.

let running = 0
const queue: Array<{ resolve: () => void; reject: (err: Error) => void }> = []

// Set once by `beginDraining` (SIGTERM/SIGINT — see index.ts) and never cleared: a process
// that started shutting down must never resume accepting work. `tryDispatch` checks it so a
// slot freed by a job finishing mid-drain does not start a fresh one from the queue — every
// queued waiter was already rejected by `beginDraining` itself, so the queue is empty by the
// time this matters, but the guard also covers the (impossible in practice, cheap to guard)
// case of a `withSlot` call racing in after draining began.
let draining = false

// Set by `setMemoryPressure`, driven by `memory-watch.ts`'s pressure/recovery callback —
// purely a read for `admission()`; nothing here sheds already-running work.
let memoryPressure = false

// A loop, not a single dispatch: `release()` frees one slot at a time, but `setMemoryPressure`
// releasing the brake can free several at once, and every free slot must be filled in that one
// call or the backlog stalls until the next unrelated release.
function tryDispatch(): void {
  if (draining) return
  while (
    canDispatch({ memoryPressure, running, queued: queue.length, maxConcurrency: env.RESEARCH_MAX_CONCURRENCY })
  ) {
    running++
    const waiter = queue.shift()
    waiter?.resolve()
  }
}

function acquire(): Promise<void> {
  if (!memoryPressure && running < env.RESEARCH_MAX_CONCURRENCY) {
    running++
    return Promise.resolve()
  }
  return new Promise<void>((resolve, reject) => {
    queue.push({ resolve, reject })
  })
}

function release(): void {
  running--
  tryDispatch()
}

export async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquire()
  try {
    return await fn()
  } finally {
    release()
  }
}

export function admission(): AdmissionRefusal | null {
  return admit({ draining, memoryPressure, running, queued: queue.length, maxQueue: env.RESEARCH_MAX_QUEUE })
}

export function isDraining(): boolean {
  return draining
}

// Driven by `memory-watch.ts`'s cgroup sampler. Both directions matter: setting it stops
// `tryDispatch` from starting queued work (see canDispatch), and clearing it must actively
// restart dispatch — nothing else will, since the release that would normally trigger it
// already happened while the brake was on.
export function setMemoryPressure(under: boolean): void {
  memoryPressure = under
  if (!under) tryDispatch()
}

export function jobCounts(): { running: number; queued: number } {
  return { running, queued: queue.length }
}

// Idempotent — a second SIGTERM must not re-reject an already-emptied queue. Rejects every
// waiter still sitting in the semaphore queue: that job was created (it exists in the store
// as 'queued') but never got a slot, so there is nothing running to wait for and nothing to
// reap on the next boot — the honest answer is DRAIN_QUEUED_MESSAGE, not a hang. `run-job.ts`'s
// `withSlot(...).catch(...)` (see startResearchJob) turns this rejection into `status: 'error'`
// with that message.
export function beginDraining(): void {
  if (draining) return
  draining = true
  const waiters = queue.splice(0, queue.length)
  for (const waiter of waiters) {
    waiter.reject(new Error(DRAIN_QUEUED_MESSAGE))
  }
  log('job.drain_queued', { count: waiters.length })
}

// Polled by index.ts's shutdown path. Only `running` counts — the queue was already rejected
// in `beginDraining`, so a job stuck there is already terminal, not something worth waiting on.
export async function waitForDrain(deadlineMs: number): Promise<{ remaining: number; waitedMs: number }> {
  const start = Date.now()
  const deadline = start + deadlineMs
  while (running > 0 && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 250))
  }
  return { remaining: running, waitedMs: Date.now() - start }
}
