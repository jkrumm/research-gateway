import { env } from '../env.js'
import type { ResearchReport, Depth, JobStatus } from '../agent/schema.js'
import { openJobDb, type JobRecord } from './job-db.js'
import { log } from './log.js'
import { admit, canDispatch, type AdmissionRefusal } from './admission.js'

export type { JobStatus }

export interface Job {
  jobId: string
  status: JobStatus
  query: string
  depth: Depth
  // Optional caller-supplied background (issue #6). Persisted only so it survives a restart
  // between create and run — the agent itself reads it once, at the start of the run.
  context?: string
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
  /** The process instance currently leasing this job — see `INSTANCE_ID` below. */
  owner?: string
  /** How many times this job has been (re)claimed after a lost lease. 0 until it happens once. */
  attempts: number
  /** A serialized `ResearchCheckpoint` (agent/checkpoint.ts), or absent if none exists yet. */
  checkpointJson?: string
}

// One id per PROCESS, not per job: `owner` throughout job-db.ts means "whichever process
// currently proves a job alive by heartbeating it". `crypto.randomUUID()` rather than a
// hostname/pid — two replicas can share a hostname (containers on the same host/port), and a
// pid recycles across a restart inside the same container, either of which would let a fresh
// process's writes slip past an old row's owner fence by coincidence.
export const INSTANCE_ID = crypto.randomUUID()

// How many times a job may be (re)claimed after a lost lease before it is given up on rather
// than resurrected again — the crash-loop guard for a POISON job: one that reproducibly kills
// (or wedges) whatever process runs it, so re-adopting it forever would just move the crash
// from replica to replica instead of surfacing it. Not a runtime cap on a healthy job — see
// ~/.claude/rules/agent-limits.md; this bounds RESTARTS of one job record, not a job's
// duration or step count.
export const MAX_JOB_ATTEMPTS = 3

// Rejects a `withSlot` waiter that a drain is handing off to another replica rather than
// failing outright — `run-job.ts`'s `.catch` recognizes this type and does NOT turn it into
// `status: 'error'`, since the job is not lost, only no longer this process's to run.
export class HandedOffError extends Error {}

// How often the owning process re-proves a job (queued OR running) is alive (see
// `startHeartbeat`), and how far behind that a heartbeat has to fall before another process
// may claim the job as abandoned (see `claimStaleJobs`). The gap between the two (90s vs 15s —
// 6 missed ticks) absorbs an occasional slow event-loop tick without a false claim; it is NOT
// meant to absorb a genuinely dead process for long, since that is exactly the scenario this
// whole mechanism exists to detect promptly.
const HEARTBEAT_INTERVAL_MS = 15_000
const HEARTBEAT_STALE_MS = 90_000

// `jobs` is the hot-path source of truth (getJob/job_wait poll it every couple seconds); `db`
// is the durable write-through so a job's status, result and resumable checkpoint survive a
// restart. Every create and status transition writes to both, synchronously — see
// createJob/updateJob below.
const db = openJobDb(env.JOB_DB_PATH)

const jobs = new Map<string, Job>()

// Job ids this process is actively heartbeating (see `startHeartbeat`). The map above is
// hydrated once at boot and thereafter only kept current for these — a job belonging to the
// SIBLING replica of a rolling deploy keeps changing in sqlite while this process's copy of it
// stays frozen at whatever it read at boot. `getJob` uses this to decide whose word to trust.
const owned = new Set<string>()

// Stop-functions for every heartbeat THIS process currently runs, keyed by jobId — so a drain
// can silence a specific job's heartbeat (handing it off) without waiting for `run-job.ts`'s
// own `.finally()` to get around to it. Entries remove themselves once stopped, either
// normally (the job reached a terminal status) or via a hand-off.
const heartbeatStoppers = new Map<string, () => void>()

// ── No boot hydration ───────────────────────────────────────────────────────
// `jobs` holds only what this process is running; every other read — a sibling's job, a
// finished result, anything from before this boot — comes straight from sqlite (`getJob`).
// Hydrating every row at boot bought nothing once foreign jobs were always re-read, and at a
// 240-minute TTL it would keep hours of full reports resident against the 2 GiB limit. A job
// whose heartbeat is stale is CLAIMED and resumed (`claimStaleJobs`, run-job.ts's adoption
// loop), never written over with a terminal error on sight.

// Surfaced on GET /health so a keyword monitor can see restart/resume activity without log
// access. `resumed` and `failedAfterRestarts` replace the old `reaped`/`interrupted` counters
// now that a stale job is adopted rather than reaped — see README § Restarts.
const bootedAt = new Date().toISOString()
let resumedCount = 0
let failedAfterRestartsCount = 0

export function restartStats(): { lastRestartAt: string; resumed: number; failedAfterRestarts: number } {
  return { lastRestartAt: bootedAt, resumed: resumedCount, failedAfterRestarts: failedAfterRestartsCount }
}

/** Bumped by run-job.ts's adoption loop for every job it resumes from a lost lease. */
export function notifyJobResumed(): void {
  resumedCount++
}

/** Bumped by run-job.ts's adoption loop for every job given up on by `MAX_JOB_ATTEMPTS`. */
export function notifyJobFailedAfterRestarts(): void {
  failedAfterRestartsCount++
}

const JOB_TTL_MS = env.JOB_TTL_MINUTES * 60_000

function sweep(): void {
  const now = Date.now()
  // Terminal jobs leave the working set at once — their result is in sqlite, which is where
  // getJob reads it from — and leave sqlite once past the retention window. The delete runs
  // against the whole table, not just this process's jobs: a row a sibling replica finished
  // and then exited on has no other process left to expire it.
  for (const [id, job] of jobs) {
    if (job.status !== 'done' && job.status !== 'error') continue
    jobs.delete(id)
    owned.delete(id)
  }
  db.deleteFinishedBefore(now - JOB_TTL_MS)
}

// Run sweep on an interval so the map doesn't grow unboundedly.
// .unref() ensures the timer doesn't prevent process exit on shutdown.
const _sweepTimer = setInterval(sweep, 60_000)
if (typeof _sweepTimer.unref === 'function') _sweepTimer.unref()

export function createJob(input: { query: string; depth: Depth; context?: string | undefined }): Job {
  sweep()
  const job: Job = {
    jobId: crypto.randomUUID(),
    status: 'queued',
    query: input.query,
    depth: input.depth,
    ...(input.context !== undefined ? { context: input.context } : {}),
    createdAt: Date.now(),
    owner: INSTANCE_ID,
    attempts: 0,
  }
  jobs.set(job.jobId, job)
  db.put(job) // a brand-new row: always succeeds, there is no existing lease to fence against
  return job
}

// READ-ONLY. A job this process owns and is heartbeating is, by definition, still being
// executed by this very process right now — there is nothing to re-check, and nothing here
// ever writes. A job this process does NOT own (or has never seen) is read fresh from the
// shared file, since a sibling replica may be actively writing to that row while this
// process's cached copy (hydrated once at boot) sits frozen. This replaces the old
// reap-on-read: a stale lease is no longer this function's problem to fix — `claimStaleJobs`
// (below, driven by run-job.ts's adoption loop) is the only thing that ever adopts a job away
// from a dead owner, and it runs on its own schedule, not on a caller's poll.
export function getJob(jobId: string): Job | undefined {
  const cached = jobs.get(jobId)
  if (cached && owned.has(jobId) && cached.status !== 'done' && cached.status !== 'error') return cached
  // Not cached on the way back: `jobs` is this process's working set, not a read-through cache
  // (see "No boot hydration" above). One primary-key read per poll.
  return db.get(jobId) ?? cached
}

export function updateJob(jobId: string, patch: Partial<Job>): void {
  const job = jobs.get(jobId)
  if (!job) return
  // Always written as THIS process's own claim of ownership: updateJob is only ever called
  // for a job this process is actively running (createJob's caller, or run-job.ts's
  // adoption-resumed jobs, both of which set `owner: INSTANCE_ID` before any of this runs).
  // `db.put`'s owner fence is what makes this safe even so — see its own doc comment.
  const updated: Job = { ...job, ...patch, owner: INSTANCE_ID }
  if (db.put(updated)) {
    jobs.set(jobId, updated)
  }
  // A `false` return means this process's lease was already gone by the time this write
  // landed — the SAME signal `startHeartbeat`'s tick gets from `renewLease`, just discovered
  // here instead. Nothing further to do: the adopter's row is untouched, and this process's
  // heartbeat tick will independently notice and log `job.lease_lost` on its own next tick.
}

/**
 * True only if THIS process still holds `jobId`'s lease right now — a plain read, straight
 * from sqlite rather than the in-memory cache (which stays frozen for a job once heartbeating
 * starts, exactly the case this exists to catch: `claimStale` can reassign the lease to a
 * sibling replica while this process is mid-round and has not yet had a heartbeat tick fail).
 * Wraps `db.ownsLease` with this process's own instance id — see job-db.ts's doc comment.
 */
export function ownsLease(jobId: string): boolean {
  return db.ownsLease(jobId, INSTANCE_ID)
}

/** Wraps `db.saveCheckpoint` with this process's own instance id — see job-db.ts's doc comment for the owner fence. */
export function saveJobCheckpoint(jobId: string, json: string | null): void {
  // Best-effort: a checkpoint that fails to save only costs a resumed job some re-done work,
  // while a throw here would fail the live run that called it.
  try {
    db.saveCheckpoint(jobId, INSTANCE_ID, json)
  } catch (err) {
    log('job.checkpoint_failed', { jobId, error: String(err) })
  }
}

// Start (and immediately stamp) a liveness LEASE for a job. The caller — run-job.ts — starts
// this the moment a job is dispatched (queued or running) and stops it in a `finally`, so the
// heartbeat runs for exactly the job's actual lifetime and clears on both success and failure.
// Returns a stop function; `.unref()` matches `_sweepTimer` so it never blocks process exit.
export function startHeartbeat(jobId: string): () => void {
  // Heartbeating a job IS owning it — this is the one place a job becomes this process's own,
  // and `getJob` reads `owned` to decide whose word to trust.
  owned.add(jobId)
  let fenced = false
  const tick = (): void => {
    if (fenced) return
    const now = Date.now()
    let renewed: boolean
    try {
      renewed = db.renewLease(jobId, INSTANCE_ID, now)
    } catch (err) {
      // A transient sqlite error (a lock held past busy_timeout) must not become an
      // uncaughtException that kills every job on this replica — the next tick retries, and
      // the 90s staleness window absorbs several missed ones.
      log('job.heartbeat_failed', { jobId, error: String(err) })
      return
    }
    if (!renewed) {
      // Another process already claimed this job (`claimStaleJobs`) — our lease is gone.
      // We let the run finish rather than abort it (no AbortSignal threaded through the agent
      // loop in this change): every later `updateJob`/checkpoint write for this job is
      // refused by the owner fence anyway, so whatever this process eventually produces is
      // silently discarded in favour of the adopter's own result.
      fenced = true
      log('job.lease_lost', { jobId })
      owned.delete(jobId)
      return
    }
    const job = jobs.get(jobId)
    if (job) jobs.set(jobId, { ...job, heartbeatAt: now })
  }
  tick()
  const timer = setInterval(tick, HEARTBEAT_INTERVAL_MS)
  if (typeof timer.unref === 'function') timer.unref()
  const stop = (): void => {
    clearInterval(timer)
    heartbeatStoppers.delete(jobId)
  }
  heartbeatStoppers.set(jobId, stop)
  return stop
}

// Atomically adopts every `queued`/`running` job whose lease has gone stale — a crash, a
// SIGKILL, an unclean restart of whichever process last owned it — and returns them so the
// caller (run-job.ts's adoption loop) can resume each from its checkpoint. Updates the local
// cache to match what was just claimed, the same way any other write here does.
export function claimStaleJobs(now: number): Job[] {
  const claimed = db.claimStale(INSTANCE_ID, now, now - HEARTBEAT_STALE_MS)
  for (const record of claimed) {
    jobs.set(record.jobId, record)
  }
  return claimed
}

// ── Semaphore ──────────────────────────────────────────────────────────────

// Tiny async semaphore to gate concurrent agent runs.
// Avoids reaching for p-limit for a few lines of logic.

let running = 0
// Each queued waiter carries its OWN jobId, so a drain can look up (and silence) that
// specific job's heartbeat and release its lease when handing it off — see `beginDraining`.
const queue: Array<{ jobId: string; resolve: () => void; reject: (err: Error) => void }> = []

// Set once by `beginDraining` (SIGTERM/SIGINT — see index.ts) and never cleared: a process
// that started shutting down must never resume accepting work. `tryDispatch` checks it so a
// slot freed by a job finishing mid-drain does not start a fresh one from the queue — every
// queued waiter was already handed off by `beginDraining` itself, so the queue is empty by the
// time this matters, but the guard also covers the (impossible in practice, cheap to guard)
// case of a `withSlot` call racing in after draining began.
let draining = false

// Set by `setMemoryPressure`, driven by `memory-watch.ts`'s pressure/recovery callback —
// purely a read for `admission()`; nothing here sheds already-running work.
let memoryPressure = false

// Set by `setMemoryHold`, driven by `memory-watch.ts`'s SOFTER, earlier threshold (70%,
// below the 85% `memoryPressure` shed). A queued job simply WAITS for a free slot rather than
// being refused — unlike `memoryPressure`, this never reaches `admission()`, only dispatch.
let memoryHold = false

// A loop, not a single dispatch: `release()` frees one slot at a time, but `setMemoryPressure`/
// `setMemoryHold` releasing the brake can free several at once, and every free slot must be
// filled in that one call or the backlog stalls until the next unrelated release.
function tryDispatch(): void {
  if (draining) return
  while (
    canDispatch({
      memoryPressure,
      held: memoryHold,
      running,
      queued: queue.length,
      maxConcurrency: env.RESEARCH_MAX_CONCURRENCY,
    })
  ) {
    running++
    const waiter = queue.shift()
    waiter?.resolve()
  }
}

function acquire(jobId: string): Promise<void> {
  if (!memoryPressure && !memoryHold && running < env.RESEARCH_MAX_CONCURRENCY) {
    running++
    return Promise.resolve()
  }
  return new Promise<void>((resolve, reject) => {
    queue.push({ jobId, resolve, reject })
  })
}

function release(): void {
  running--
  tryDispatch()
}

export async function withSlot<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
  await acquire(jobId)
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

// Same shape as `setMemoryPressure`, one threshold earlier — see `memoryHold`'s own comment.
export function setMemoryHold(held: boolean): void {
  memoryHold = held
  if (!held) tryDispatch()
}

export function jobCounts(): { running: number; queued: number } {
  return { running, queued: queue.length }
}

// Idempotent — a second SIGTERM must not re-hand-off an already-emptied queue. HANDS OFF every
// waiter still sitting in the semaphore queue, rather than failing them: each of these jobs
// legitimately exists in the store as 'queued', so releasing its lease (and silencing its
// heartbeat) makes it immediately claimable by whichever replica survives this drain — its
// last completed round's checkpoint, if any, is still on the row, so the adopter resumes it
// instead of starting over. `run-job.ts`'s `withSlot(...).catch(...)` recognizes
// `HandedOffError` and does NOT turn it into `status: 'error'` (see `startResearchJob`).
export function beginDraining(): void {
  if (draining) return
  draining = true
  const waiters = queue.splice(0, queue.length)
  for (const waiter of waiters) {
    heartbeatStoppers.get(waiter.jobId)?.()
    owned.delete(waiter.jobId)
    db.releaseLease(waiter.jobId, INSTANCE_ID)
    waiter.reject(new HandedOffError('This research job was still queued when this process began restarting; its lease was released for another instance to resume.'))
  }
  log('job.drain_handed_off', { count: waiters.length })
}

// Called by index.ts's `drainThenExit` once `waitForDrain` elapses with jobs still RUNNING —
// releases their leases (and silences their heartbeats) exactly like `beginDraining` did for
// the queued ones, so the next replica adopts them immediately instead of waiting out the full
// HEARTBEAT_STALE_MS after this process is already gone. The jobs themselves are NOT
// cancelled — this process is about to exit regardless, and their last checkpoint is what the
// adopter resumes from.
export function releaseAllOwnedLeases(): void {
  for (const jobId of [...owned]) {
    heartbeatStoppers.get(jobId)?.()
    owned.delete(jobId)
    db.releaseLease(jobId, INSTANCE_ID)
  }
}

// Polled by index.ts's shutdown path. Only `running` counts — the queue was already handed
// off in `beginDraining`, so a job stuck there is no longer this process's concern.
export async function waitForDrain(deadlineMs: number): Promise<{ remaining: number; waitedMs: number }> {
  const start = Date.now()
  const deadline = start + deadlineMs
  while (running > 0 && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 250))
  }
  return { remaining: running, waitedMs: Date.now() - start }
}
