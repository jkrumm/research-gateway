import { describe, it, expect } from 'bun:test'
import { openJobDb, type JobDb } from './job-db.js'
import { createJobStore, HandedOffError, MAX_JOB_ATTEMPTS, type JobStore } from './job-store-core.js'
import { createJobRunner, type RunResearchFn } from './job-runner-core.js'
import { CHECKPOINT_VERSION, serializeCheckpoint, type ResearchCheckpoint } from '../agent/checkpoint.js'
import type { ResearchReport } from '../agent/schema.js'

// This is the test suite item 7 exists for: job-store.ts / run-job.ts import `env.ts` and
// `agent/run.js`'s LLM chain, so the lease/resume/drain state machine — this PR's whole
// purpose — shipped untested. job-store-core.ts / job-runner-core.ts are the same logic with
// every dependency injected, so it is exercised here against a REAL `openJobDb(':memory:')`
// shared between TWO store instances (simulating two replicas of a rolling deploy), with a
// FAKE `runResearch` (deferred promises — no LLM, no env).

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function makeStore(db: JobDb, instanceId: string): JobStore {
  return createJobStore({ db, instanceId, maxConcurrency: 1, maxQueue: 10, ttlMs: 60_000, log: () => {} })
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function report(overrides: Partial<ResearchReport> = {}): ResearchReport {
  return {
    report: 'The answer is 42.',
    citations: [],
    sources: [],
    unverified: [],
    status: 'ok',
    warnings: [],
    cost: {
      wallMs: 1,
      totalUsd: 0,
      llmUsd: 0,
      searchUsd: 0,
      searchCalls: 0,
      tavilyCredits: 0,
      tavilyExtractCalls: 0,
    },
    grounding: { pagesRetrieved: 0, pagesMissing: 0, pagesFailed: 0, citationsKept: 0, citationsDropped: 0, confidenceCapped: 0 },
    ...overrides,
  }
}

const zeroUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0, cachedInputTokens: 0, durationMs: 0 }

function checkpointFixture(overrides: Partial<ResearchCheckpoint> = {}): ResearchCheckpoint {
  return {
    version: CHECKPOINT_VERSION,
    subQuestions: [],
    round: 2,
    digests: [],
    ledgers: [],
    askedLower: [],
    failures: [],
    alreadyRetried: false,
    leadUsage: zeroUsage,
    workerUsage: zeroUsage,
    workersDispatchedTotal: 0,
    ...overrides,
  }
}

function makeRunner(store: JobStore, runResearch: RunResearchFn) {
  return createJobRunner({ store, runResearch, reportUsage: () => {}, log: () => {}, leadModel: 'lead', workerModel: 'worker' })
}

describe('startResearchJob — happy path', () => {
  it('goes queued -> running -> done and clears the checkpoint on success', async () => {
    const db = openJobDb(':memory:')
    const store = makeStore(db, 'A')
    const job = store.createJob({ query: 'q', depth: 'quick' })
    // Seed a stale checkpoint up front to prove a successful run clears it.
    store.saveJobCheckpoint(job.jobId, serializeCheckpoint(checkpointFixture()))
    expect(store.getJob(job.jobId)?.status).toBe('queued')

    const d = deferred<ResearchReport>()
    const runner = makeRunner(store, async () => d.promise)
    runner.startResearchJob(job)
    await flush()

    expect(store.getJob(job.jobId)?.status).toBe('running')
    // Read straight from the db, not `getJob` — a still-owned, non-terminal job is served from
    // the in-memory cache, which `saveJobCheckpoint` (a direct db write) never touches.
    expect(db.get(job.jobId)?.checkpointJson).not.toBeUndefined()

    d.resolve(report())
    await flush()
    await flush()

    const finished = store.getJob(job.jobId)
    expect(finished?.status).toBe('done')
    expect(finished?.result?.report).toBe('The answer is 42.')
    expect(finished?.checkpointJson).toBeUndefined() // cleared — nothing left to resume

    store.stopSweep()
    db.close()
  })
})

describe('adoption — a replica takeover', () => {
  it('replica B claims replica A\'s stale job and resumes it from A\'s checkpoint', async () => {
    const db = openJobDb(':memory:')
    const storeA = makeStore(db, 'A')
    const job = storeA.createJob({ query: 'q', depth: 'quick' })
    storeA.startHeartbeat(job.jobId)
    // Simulate A crashing a while ago: back-date its heartbeat directly on the shared db.
    db.renewLease(job.jobId, 'A', Date.now() - 999_999)
    const checkpoint = checkpointFixture({ round: 2, workersDispatchedTotal: 4 })
    storeA.saveJobCheckpoint(job.jobId, serializeCheckpoint(checkpoint))

    const storeB = makeStore(db, 'B')
    let seenCheckpoint: ResearchCheckpoint | null | undefined
    const runnerB = makeRunner(storeB, async (_input, _onUsage, opts) => {
      seenCheckpoint = opts?.checkpoint
      return report()
    })

    runnerB.runAdoptionPass()
    await flush()
    await flush()

    expect(seenCheckpoint).toEqual(checkpoint)
    const row = db.get(job.jobId)
    expect(row?.owner).toBe('B')
    expect(row?.attempts).toBe(1)
    expect(db.ownsLease(job.jobId, 'A')).toBe(false)
    expect(db.ownsLease(job.jobId, 'B')).toBe(true)

    storeA.stopSweep()
    storeB.stopSweep()
    db.close()
  })

  it('never re-claims a job the SAME instance still owns, however stale its heartbeat looks', () => {
    const db = openJobDb(':memory:')
    const storeA = makeStore(db, 'A')
    const job = storeA.createJob({ query: 'q', depth: 'quick' })
    storeA.startHeartbeat(job.jobId)
    db.renewLease(job.jobId, 'A', Date.now() - 999_999)

    const claimed = storeA.claimStaleJobs(Date.now())
    expect(claimed).toEqual([])
    expect(db.get(job.jobId)?.owner).toBe('A')

    storeA.stopSweep()
    db.close()
  })
})

describe('beginDraining — hands queued work off without failing it', () => {
  it('leaves a queued job queued with heartbeat cleared and no error, then lets B adopt it with attempts unchanged', async () => {
    const db = openJobDb(':memory:')
    const storeA = makeStore(db, 'A') // maxConcurrency: 1
    const never = deferred<ResearchReport>() // job1 occupies the only slot forever
    const runnerA = makeRunner(storeA, async () => never.promise)

    const job1 = storeA.createJob({ query: 'first', depth: 'quick' })
    const job2 = storeA.createJob({ query: 'second', depth: 'quick' })
    runnerA.startResearchJob(job1)
    await flush()
    expect(storeA.getJob(job1.jobId)?.status).toBe('running') // took the only slot

    let job2Started = false
    const runner2 = makeRunner(storeA, async () => {
      job2Started = true
      return report()
    })
    runner2.startResearchJob(job2)
    await flush()
    expect(job2Started).toBe(false) // still queued behind job1

    storeA.beginDraining()
    await flush()

    const row = db.get(job2.jobId)
    expect(row?.status).toBe('queued') // status untouched
    expect(row?.heartbeatAt).toBeUndefined() // lease released
    expect(row?.error).toBeUndefined() // HandedOffError routed silently, never markFailed
    expect(row?.attempts).toBe(-1) // released, not yet reclaimed — floored per job-db.ts's releaseLease

    const storeB = makeStore(db, 'B')
    const claimed = storeB.claimStaleJobs(Date.now())
    expect(claimed.map((j) => j.jobId)).toContain(job2.jobId)
    // -1 (voluntary release) + 1 (this claim) = 0 — a drain-then-adopt round trip nets to
    // "unchanged", exactly like a normal claim on a job that was never drained at all; it
    // must NOT look like an extra crash to the guard.
    expect(claimed.find((j) => j.jobId === job2.jobId)?.attempts).toBe(0)

    storeA.stopSweep()
    storeB.stopSweep()
    db.close()
  })
})

describe('releaseAllOwnedLeases', () => {
  it('releases a still-running job\'s lease so another replica can adopt it, netting attempts to 0', async () => {
    const db = openJobDb(':memory:')
    const storeA = makeStore(db, 'A')
    const never = deferred<ResearchReport>()
    const runnerA = makeRunner(storeA, async () => never.promise)
    const job = storeA.createJob({ query: 'q', depth: 'quick' })
    runnerA.startResearchJob(job)
    await flush()
    expect(storeA.getJob(job.jobId)?.status).toBe('running')

    storeA.releaseAllOwnedLeases()

    const row = db.get(job.jobId)
    expect(row?.heartbeatAt).toBeUndefined()
    expect(row?.owner).toBe('A') // owner column itself is untouched — only the heartbeat is released
    expect(row?.attempts).toBe(-1) // floored, per job-db.ts's releaseLease

    const storeB = makeStore(db, 'B')
    const claimed = storeB.claimStaleJobs(Date.now())
    expect(claimed.find((j) => j.jobId === job.jobId)?.attempts).toBe(0) // -1 released + 1 claimed = 0

    storeA.stopSweep()
    storeB.stopSweep()
    db.close()
  })
})

describe('fenced writes', () => {
  it('refuses replica A\'s late "done" write once replica B has already claimed the job', async () => {
    const db = openJobDb(':memory:')
    const storeA = makeStore(db, 'A')
    const job = storeA.createJob({ query: 'q', depth: 'quick' })
    storeA.startHeartbeat(job.jobId)
    db.renewLease(job.jobId, 'A', Date.now() - 999_999) // A goes stale

    const storeB = makeStore(db, 'B')
    storeB.claimStaleJobs(Date.now()) // B adopts it before A's write below lands

    // A, unaware its lease is gone, tries to report the job it thinks it's still running.
    storeA.updateJob(job.jobId, { status: 'done', result: report(), finishedAt: Date.now() })

    const row = db.get(job.jobId)
    expect(row?.status).not.toBe('done') // A's write was refused by the owner fence
    expect(row?.owner).toBe('B')
    expect(db.ownsLease(job.jobId, 'A')).toBe(false)
    expect(db.ownsLease(job.jobId, 'B')).toBe(true)

    storeA.stopSweep()
    storeB.stopSweep()
    db.close()
  })
})

describe('getJob — read-only, and a foreign job is always read fresh', () => {
  it('never writes, and reads a job owned by another instance straight from the store every time', () => {
    const db = openJobDb(':memory:')
    const storeA = makeStore(db, 'A')
    const storeB = makeStore(db, 'B')
    const job = storeA.createJob({ query: 'q', depth: 'quick' })

    const before = db.get(job.jobId)
    const firstRead = storeB.getJob(job.jobId) // storeB never created/heartbeats this job
    expect(firstRead?.status).toBe('queued')
    expect(db.get(job.jobId)).toEqual(before) // reading it did not write anything

    // A mutates it; B's NEXT read must see the change immediately — proof it is not served
    // from a stale local cache.
    storeA.updateJob(job.jobId, { status: 'running', startedAt: Date.now() })
    const secondRead = storeB.getJob(job.jobId)
    expect(secondRead?.status).toBe('running')

    storeA.stopSweep()
    storeB.stopSweep()
    db.close()
  })
})

describe('the crash-loop guard', () => {
  it('gives up at exactly MAX_JOB_ATTEMPTS claims — one fewer process crashes than the old off-by-one', async () => {
    const db = openJobDb(':memory:')
    const storeA = makeStore(db, 'A')
    const job = storeA.createJob({ query: 'q', depth: 'quick' })
    storeA.startHeartbeat(job.jobId)

    // Drive `attempts` up to MAX_JOB_ATTEMPTS - 1 by repeated claim/backdate cycles — each
    // claimStale bump is one "process crashed and got reclaimed" event.
    let owner = 'A'
    for (let i = 0; i < MAX_JOB_ATTEMPTS - 1; i++) {
      db.renewLease(job.jobId, owner, Date.now() - 999_999)
      const next = `owner-${i}`
      db.claimStale(next, Date.now(), Date.now())
      owner = next
    }
    expect(db.get(job.jobId)?.attempts).toBe(MAX_JOB_ATTEMPTS - 1)

    // One more stale-lease claim reaches exactly MAX_JOB_ATTEMPTS — the adopting runner must
    // give up here, not dispatch a run.
    db.renewLease(job.jobId, owner, Date.now() - 999_999)
    const storeFinal = makeStore(db, 'final-owner')
    let dispatched = false
    const runner = makeRunner(storeFinal, async () => {
      dispatched = true
      return report()
    })
    runner.runAdoptionPass()
    await flush()

    expect(dispatched).toBe(false)
    const row = db.get(job.jobId)
    expect(row?.attempts).toBe(MAX_JOB_ATTEMPTS)
    expect(row?.status).toBe('error')
    expect(row?.error).toContain('restarted')

    storeA.stopSweep()
    storeFinal.stopSweep()
    db.close()
  })

  it('still dispatches one claim short of the guard', async () => {
    const db = openJobDb(':memory:')
    const storeA = makeStore(db, 'A')
    const job = storeA.createJob({ query: 'q', depth: 'quick' })
    storeA.startHeartbeat(job.jobId)

    let owner = 'A'
    for (let i = 0; i < MAX_JOB_ATTEMPTS - 1; i++) {
      db.renewLease(job.jobId, owner, Date.now() - 999_999)
      const next = `owner-${i}`
      db.claimStale(next, Date.now(), Date.now())
      owner = next
    }
    expect(db.get(job.jobId)?.attempts).toBe(MAX_JOB_ATTEMPTS - 1)

    const storeFinal = makeStore(db, owner) // this IS the current owner from the loop above
    let dispatched = false
    const runner = makeRunner(storeFinal, async () => {
      dispatched = true
      return report()
    })
    // No further claim needed — `runAdoptionPass` itself claims whatever is stale; since this
    // job's heartbeat is fresh (just claimed above), nothing is claimed, so drive it directly
    // through `startResearchJob` instead, exactly as the real adoption loop would once a claim
    // succeeds at MAX_JOB_ATTEMPTS - 1.
    runner.startResearchJob(job, { checkpoint: null })
    await flush()
    await flush()

    expect(dispatched).toBe(true)

    storeA.stopSweep()
    storeFinal.stopSweep()
    db.close()
  })
})

describe('HandedOffError / job-store-core exports', () => {
  it('is a real Error subclass', () => {
    const err = new HandedOffError('handed off')
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe('handed off')
  })
})
