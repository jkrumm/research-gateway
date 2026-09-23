// The lease/resume/drain state machine itself, factored out of job-store.ts so it is
// unit-testable against `openJobDb(':memory:')` without booting `env.ts` (which parses
// `process.env` at import time and throws without secrets). `job-store.ts` is now a thin,
// env-wired instance of this factory — same public API, same behaviour, just constructed with
// real dependencies (the real sqlite path, `crypto.randomUUID()`, `env.*`, `lib/log.js`) instead
// of injected ones. See job-store.test.ts for the two-replica scenarios this makes testable:
// adoption, the self-reclaim exclusion, a drain handing queued work off, a fenced write being
// refused, and `getJob`'s read-through for a foreign job.
import type { ResearchReport, Depth, JobStatus } from '../agent/schema.js'
import type { JobDb } from './job-db.js'
import { admit, canDispatch, type AdmissionRefusal } from './admission.js'

export type { JobStatus }

export interface Job {
  jobId: string
  status: JobStatus
  query: string
  depth: Depth
  context?: string
  result?: ResearchReport
  error?: string
  createdAt: number
  startedAt?: number
  finishedAt?: number
  heartbeatAt?: number
  owner?: string
  attempts: number
  checkpointJson?: string
}

// Rejects a `withSlot` waiter that a drain is handing off to another replica rather than
// failing outright — the caller (run-job(-core).ts) recognizes this type and does NOT turn it
// into `status: 'error'`, since the job is not lost, only no longer this process's to run.
export class HandedOffError extends Error {}

// How many times a job may be (re)claimed after a lost lease before it is given up on rather
// than resurrected again — the crash-loop guard for a POISON job. Not a runtime cap on a
// healthy job — see ~/.claude/rules/agent-limits.md; this bounds RESTARTS of one job record,
// not a job's duration or step count.
export const MAX_JOB_ATTEMPTS = 3

// How often the owning process re-proves a job (queued OR running) is alive, and how far
// behind that a heartbeat has to fall before another process may claim the job as abandoned.
// The gap between the two (6 missed ticks) absorbs an occasional slow event-loop tick without
// a false claim.
const HEARTBEAT_INTERVAL_MS = 15_000
const HEARTBEAT_STALE_MS = 90_000

export interface JobStoreDeps {
  db: JobDb
  /** Unique per PROCESS, not per job — two replicas sharing a DB file must never collide. */
  instanceId: string
  maxConcurrency: number
  maxQueue: number
  ttlMs: number
  log: (event: string, fields?: Record<string, unknown>) => void
}

export interface JobStore {
  readonly instanceId: string
  createJob(input: { query: string; depth: Depth; context?: string | undefined }): Job
  getJob(jobId: string): Job | undefined
  updateJob(jobId: string, patch: Partial<Job>): void
  saveJobCheckpoint(jobId: string, json: string | null): void
  ownsLease(jobId: string): boolean
  startHeartbeat(jobId: string): () => void
  claimStaleJobs(now: number): Job[]
  withSlot<T>(jobId: string, fn: () => Promise<T>): Promise<T>
  admission(): AdmissionRefusal | null
  isDraining(): boolean
  setMemoryPressure(under: boolean): void
  setMemoryHold(held: boolean): void
  jobCounts(): { running: number; queued: number }
  beginDraining(): void
  releaseAllOwnedLeases(): void
  waitForDrain(deadlineMs: number): Promise<{ remaining: number; waitedMs: number }>
  restartStats(): { lastRestartAt: string; resumed: number; failedAfterRestarts: number }
  notifyJobResumed(): void
  notifyJobFailedAfterRestarts(): void
  /** Stops the background sweep timer — tests call this so `bun test` can exit cleanly. */
  stopSweep(): void
}

export function createJobStore(deps: JobStoreDeps): JobStore {
  const { db, instanceId, maxConcurrency, maxQueue, ttlMs, log } = deps

  // `jobs` is the hot-path source of truth (getJob/job_wait poll it every couple seconds);
  // `db` is the durable write-through. Hydrated only for jobs THIS instance creates/adopts —
  // a job belonging to a sibling replica is always re-read from `db` instead (see `getJob`).
  const jobs = new Map<string, Job>()
  // Job ids this instance is actively heartbeating — heartbeating a job IS owning it.
  const owned = new Set<string>()
  // Stop-functions for every heartbeat this instance currently runs, keyed by jobId.
  const heartbeatStoppers = new Map<string, () => void>()

  const bootedAt = new Date().toISOString()
  let resumedCount = 0
  let failedAfterRestartsCount = 0

  function sweep(): void {
    const now = Date.now()
    for (const [id, job] of jobs) {
      if (job.status !== 'done' && job.status !== 'error') continue
      jobs.delete(id)
      owned.delete(id)
    }
    db.deleteFinishedBefore(now - ttlMs)
  }

  const sweepTimer = setInterval(sweep, 60_000)
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref()

  function createJob(input: { query: string; depth: Depth; context?: string | undefined }): Job {
    sweep()
    const job: Job = {
      jobId: crypto.randomUUID(),
      status: 'queued',
      query: input.query,
      depth: input.depth,
      ...(input.context !== undefined ? { context: input.context } : {}),
      createdAt: Date.now(),
      owner: instanceId,
      attempts: 0,
    }
    jobs.set(job.jobId, job)
    db.put(job) // a brand-new row: always succeeds, there is no existing lease to fence against
    return job
  }

  // READ-ONLY. A job this instance owns and is heartbeating is, by definition, still being
  // executed by this very process right now. A job this instance does NOT own (or has never
  // seen) is read fresh from the shared store, since a sibling replica may be actively writing
  // to that row while this instance's cached copy sits frozen.
  function getJob(jobId: string): Job | undefined {
    const cached = jobs.get(jobId)
    if (cached && owned.has(jobId) && cached.status !== 'done' && cached.status !== 'error') return cached
    return db.get(jobId) ?? cached
  }

  function updateJob(jobId: string, patch: Partial<Job>): void {
    const job = jobs.get(jobId)
    if (!job) return
    const updated: Job = { ...job, ...patch, owner: instanceId }
    if (db.put(updated)) {
      jobs.set(jobId, updated)
    }
    // A `false` return means this instance's lease was already gone by the time this write
    // landed — the same signal `startHeartbeat`'s tick gets from `renewLease`.
  }

  function saveJobCheckpoint(jobId: string, json: string | null): void {
    try {
      db.saveCheckpoint(jobId, instanceId, json)
    } catch (err) {
      log('job.checkpoint_failed', { jobId, error: String(err) })
    }
  }

  function ownsLease(jobId: string): boolean {
    return db.ownsLease(jobId, instanceId)
  }

  function startHeartbeat(jobId: string): () => void {
    owned.add(jobId)
    let fenced = false
    const tick = (): void => {
      if (fenced) return
      const now = Date.now()
      let renewed: boolean
      try {
        renewed = db.renewLease(jobId, instanceId, now)
      } catch (err) {
        log('job.heartbeat_failed', { jobId, error: String(err) })
        return
      }
      if (!renewed) {
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

  function claimStaleJobs(now: number): Job[] {
    const claimed = db.claimStale(instanceId, now, now - HEARTBEAT_STALE_MS)
    for (const record of claimed) {
      jobs.set(record.jobId, record)
    }
    return claimed
  }

  // ── Semaphore ──────────────────────────────────────────────────────────────
  let running = 0
  const queue: Array<{ jobId: string; resolve: () => void; reject: (err: Error) => void }> = []
  let draining = false
  let memoryPressure = false
  let memoryHold = false

  function tryDispatch(): void {
    if (draining) return
    while (canDispatch({ memoryPressure, held: memoryHold, running, queued: queue.length, maxConcurrency })) {
      running++
      const waiter = queue.shift()
      waiter?.resolve()
    }
  }

  function acquire(jobId: string): Promise<void> {
    if (!memoryPressure && !memoryHold && running < maxConcurrency) {
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

  async function withSlot<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
    await acquire(jobId)
    try {
      return await fn()
    } finally {
      release()
    }
  }

  function admission(): AdmissionRefusal | null {
    return admit({ draining, memoryPressure, running, queued: queue.length, maxQueue })
  }

  function isDraining(): boolean {
    return draining
  }

  function setMemoryPressure(under: boolean): void {
    memoryPressure = under
    if (!under) tryDispatch()
  }

  function setMemoryHold(held: boolean): void {
    memoryHold = held
    if (!held) tryDispatch()
  }

  function jobCounts(): { running: number; queued: number } {
    return { running, queued: queue.length }
  }

  function beginDraining(): void {
    if (draining) return
    draining = true
    const waiters = queue.splice(0, queue.length)
    for (const waiter of waiters) {
      heartbeatStoppers.get(waiter.jobId)?.()
      owned.delete(waiter.jobId)
      db.releaseLease(waiter.jobId, instanceId)
      waiter.reject(
        new HandedOffError(
          'This research job was still queued when this process began restarting; its lease was released for another instance to resume.',
        ),
      )
    }
    log('job.drain_handed_off', { count: waiters.length })
  }

  function releaseAllOwnedLeases(): void {
    for (const jobId of [...owned]) {
      heartbeatStoppers.get(jobId)?.()
      owned.delete(jobId)
      db.releaseLease(jobId, instanceId)
    }
  }

  async function waitForDrain(deadlineMs: number): Promise<{ remaining: number; waitedMs: number }> {
    const start = Date.now()
    const deadline = start + deadlineMs
    while (running > 0 && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 250))
    }
    return { remaining: running, waitedMs: Date.now() - start }
  }

  function restartStats(): { lastRestartAt: string; resumed: number; failedAfterRestarts: number } {
    return { lastRestartAt: bootedAt, resumed: resumedCount, failedAfterRestarts: failedAfterRestartsCount }
  }

  function notifyJobResumed(): void {
    resumedCount++
  }

  function notifyJobFailedAfterRestarts(): void {
    failedAfterRestartsCount++
  }

  function stopSweep(): void {
    clearInterval(sweepTimer)
  }

  return {
    instanceId,
    createJob,
    getJob,
    updateJob,
    saveJobCheckpoint,
    ownsLease,
    startHeartbeat,
    claimStaleJobs,
    withSlot,
    admission,
    isDraining,
    setMemoryPressure,
    setMemoryHold,
    jobCounts,
    beginDraining,
    releaseAllOwnedLeases,
    waitForDrain,
    restartStats,
    notifyJobResumed,
    notifyJobFailedAfterRestarts,
    stopSweep,
  }
}
