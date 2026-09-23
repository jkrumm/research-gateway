// Thin, env-wired instance of job-store-core.ts's `createJobStore` — same public API, same
// behaviour, just constructed against the real sqlite path, a real `crypto.randomUUID()`
// instance id, `env.*` for the concurrency/queue/TTL knobs, and `lib/log.js`. All the actual
// lease/resume/drain/semaphore logic lives in job-store-core.ts, which is unit-tested directly
// (job-store.test.ts) without booting this module's env chain.
import { env } from '../env.js'
import { openJobDb } from './job-db.js'
import { log } from './log.js'
import { createJobStore, MAX_JOB_ATTEMPTS, HandedOffError, type Job, type JobStatus, type JobStore } from './job-store-core.js'

export type { JobStatus, Job }
export { MAX_JOB_ATTEMPTS, HandedOffError }

const store: JobStore = createJobStore({
  db: openJobDb(env.JOB_DB_PATH),
  instanceId: crypto.randomUUID(),
  maxConcurrency: env.RESEARCH_MAX_CONCURRENCY,
  maxQueue: env.RESEARCH_MAX_QUEUE,
  ttlMs: env.JOB_TTL_MINUTES * 60_000,
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
