import { env } from '../env.js'
import type { ResearchReport, Depth } from '../agent/schema.js'

export type JobStatus = 'queued' | 'running' | 'done' | 'error'

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
}

const jobs = new Map<string, Job>()

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
  return job
}

export function getJob(jobId: string): Job | undefined {
  return jobs.get(jobId)
}

export function updateJob(jobId: string, patch: Partial<Job>): void {
  const job = jobs.get(jobId)
  if (!job) return
  jobs.set(jobId, { ...job, ...patch })
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
