import { env } from '../env.js'
import type { ResearchReport, Depth, JobStatus } from '../agent/schema.js'
import { openJobDb } from './job-db.js'
import { log } from './log.js'

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
  log('job.reaped', { count: reaped.length, jobIds: reaped.map((job) => job.jobId) })
}
for (const job of db.all()) {
  jobs.set(job.jobId, job)
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
  const job = jobs.get(jobId)
  if (!job || (job.status !== 'running' && job.status !== 'queued')) return job

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
  log('job.reaped_on_read', { jobId })
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
const queue: Array<() => void> = []

function tryDispatch(): void {
  if (running < env.RESEARCH_MAX_CONCURRENCY && queue.length > 0) {
    running++
    const resolve = queue.shift()
    resolve?.()
  }
}

function acquire(): Promise<void> {
  if (running < env.RESEARCH_MAX_CONCURRENCY) {
    running++
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    queue.push(resolve)
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

export function atCapacity(): boolean {
  return running + queue.length >= env.RESEARCH_MAX_QUEUE
}
