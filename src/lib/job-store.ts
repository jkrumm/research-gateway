// Thin, env-wired instance of job-store-core.ts's `createJobStore` — same public API, same
// behaviour, just constructed against the real sqlite path, a real `crypto.randomUUID()`
// instance id, `env.*` for the concurrency/queue/TTL knobs, and `lib/log.js`. All the actual
// lease/resume/drain/semaphore logic lives in job-store-core.ts, which is unit-tested directly
// (job-store.test.ts) without booting this module's env chain. What stays here instead of
// there: cancellation (an `AbortController` per in-flight run, registered by run-job.ts — a
// runtime concern the durable core has no business owning) and live progress (`JobProgress`
// snapshots and the `JobLiveFields` shape both status doors add — memory-only, worthless once
// a job ends, and pulled straight from `agent/schema.js`, which the core stays free of).
import { env } from '../env.js'
import { isTerminalStatus, type JobLiveFields, type JobProgress } from '../agent/schema.js'
import { TYPICAL_DURATION_MS } from '../agent/depth.js'
import type { z } from 'zod'
import { openJobDb } from './job-db.js'
import { log } from './log.js'
import { createJobStore, MAX_JOB_ATTEMPTS, HandedOffError, type Job, type JobStatus, type JobStore } from './job-store-core.js'

export type { JobStatus, Job }
export { MAX_JOB_ATTEMPTS, HandedOffError }

// Kept as its own reference (not just handed to `createJobStore`) so `findActiveJobByIdempotencyKey`
// below can query it directly — the dedupe lookup is a plain read-through the core has no
// public method for, and adding one just to avoid this second reference isn't worth it for a
// single call site.
const db = openJobDb(env.JOB_DB_PATH)
const JOB_TTL_MS = env.JOB_TTL_MINUTES * 60_000

const store: JobStore = createJobStore({
  db,
  instanceId: crypto.randomUUID(),
  maxConcurrency: env.RESEARCH_MAX_CONCURRENCY,
  maxQueue: env.RESEARCH_MAX_QUEUE,
  ttlMs: JOB_TTL_MS,
  log,
})

// `run-job.ts` needs the whole instance (it builds a `createJobRunner` around it); every other
// consumer (routes/*, index.ts) keeps importing the flat, bound functions below — no call site
// outside this pair of files changes.
export const jobStoreInstance: JobStore = store

export const INSTANCE_ID = store.instanceId
export const createJob = store.createJob
export const getJob = store.getJob
export const updateJob = store.updateJob
export const saveJobCheckpoint = store.saveJobCheckpoint
export const ownsLease = store.ownsLease
export const startHeartbeat = store.startHeartbeat
export const claimStaleJobs = store.claimStaleJobs
export const withSlot = store.withSlot
export const admission = store.admission
export const isDraining = store.isDraining
export const setMemoryPressure = store.setMemoryPressure
export const setMemoryHold = store.setMemoryHold
export const jobCounts = store.jobCounts
export const beginDraining = store.beginDraining
export const releaseAllOwnedLeases = store.releaseAllOwnedLeases
export const waitForDrain = store.waitForDrain
export const restartStats = store.restartStats
export const notifyJobResumed = store.notifyJobResumed
export const notifyJobFailedAfterRestarts = store.notifyJobFailedAfterRestarts

// The submit dedupe lookup: the most recent job created with this key that has not yet aged
// out of retention. Never consults the in-memory map — the job a retried submit wants back may
// be a terminal result retained only in sqlite, and a queued/running sibling-replica job is in
// the file, not this process's map. A caller checks this BEFORE admission so a duplicate is
// never shed by a full queue or a busy process.
export function findActiveJobByIdempotencyKey(idempotencyKey: string): Job | undefined {
  return db.findByIdempotencyKey(idempotencyKey, Date.now() - JOB_TTL_MS)
}

// ── Cancel ──────────────────────────────────────────────────────────────────

const CANCELLED_MESSAGE = 'Cancelled by the caller before it finished.'

// The abort reason a cancel hands to a running job's controller and a queued job's semaphore
// waiter. run-job.ts tells a cancel apart from a real failure by the job's own signal, not by
// this type — but a typed reason keeps the unwinding error readable in a trace.
export class JobCancelledError extends Error {
  constructor() {
    super(CANCELLED_MESSAGE)
    this.name = 'JobCancelledError'
  }
}

// The abort controller of every job this process is executing, registered by run-job.ts for
// the job's whole lifetime (queued and running). Only the owning process can stop a job's
// work, so only it can cancel one.
const cancels = new Map<string, AbortController>()

export function registerCancel(jobId: string, controller: AbortController): () => void {
  cancels.set(jobId, controller)
  return () => {
    cancels.delete(jobId)
  }
}

export type CancelOutcome =
  | { kind: 'cancelled'; job: Job }
  | { kind: 'already_terminal'; job: Job }
  | { kind: 'not_found' }
  | { kind: 'not_owned'; job: Job }

// Idempotent: cancelling a terminal job (a second cancel included) returns it unchanged.
// A queued job leaves the semaphore line at once and never starts; a running job is marked
// 'cancelled' immediately and its controller aborted — the in-flight LLM calls abort through
// their idle watchdogs, and the concurrency slot frees as soon as the run unwinds (an in-flight
// page fetch finishes on its own budget first).
export function cancelJob(jobId: string): CancelOutcome {
  const job = store.getJob(jobId)
  if (!job) return { kind: 'not_found' }
  if (isTerminalStatus(job.status)) return { kind: 'already_terminal', job }
  const controller = cancels.get(jobId)
  // A live job this process has no controller for belongs to the sibling replica of a rolling
  // deploy: marking it here would be overwritten by the owner, which keeps running it. Only the
  // VPS's rolling deploy has a sibling (the mini runs one process); the window lasts until the
  // old replica has drained, up to SHUTDOWN_DRAIN_MS.
  if (!store.isOwned(jobId) || !controller) return { kind: 'not_owned', job }

  const finishedAt = Date.now()
  store.updateJob(jobId, { status: 'cancelled', error: CANCELLED_MESSAGE, finishedAt })
  progress.delete(jobId)

  const reason = new JobCancelledError()
  controller.abort(reason)
  store.rejectQueued(jobId, reason)
  log('job.cancelled', { jobId, wasStatus: job.status })
  return { kind: 'cancelled', job: { ...job, status: 'cancelled', error: CANCELLED_MESSAGE, finishedAt } }
}

// ── Live status ─────────────────────────────────────────────────────────────

// Latest phase per running job, fed by runResearch's onProgress through run-job.ts. Memory
// only, deliberately: it changes every worker completion, is worthless once the job ends, and
// a job whose process died is reaped to 'error' anyway — so nothing here needs to survive.
const progress = new Map<string, JobProgress>()

// Ignored once the job is terminal (or swept): a cancelled run keeps reporting workers as it
// unwinds, and writing those would re-create an entry nothing ever deletes again.
export function setJobProgress(jobId: string, value: JobProgress): void {
  const job = store.getJob(jobId)
  if (!job || isTerminalStatus(job.status)) return
  progress.set(jobId, value)
}

type LiveFields = { [K in keyof typeof JobLiveFields]: z.infer<(typeof JobLiveFields)[K]> }

const iso = (ms: number | undefined): string | null => (ms === undefined ? null : new Date(ms).toISOString())

// What both status doors add to a job. `queuePosition` and `progress` are only known to the
// process running the job; a job owned by the sibling replica of a rolling deploy reads null.
export function liveFields(job: Job): LiveFields {
  return {
    depth: job.depth,
    submittedAt: new Date(job.createdAt).toISOString(),
    startedAt: iso(job.startedAt),
    finishedAt: iso(job.finishedAt),
    queuePosition: job.status === 'queued' ? store.queuePosition(job.jobId) : null,
    progress: job.status === 'running' ? (progress.get(job.jobId) ?? null) : null,
    typicalDurationMs: TYPICAL_DURATION_MS[job.depth],
  }
}
