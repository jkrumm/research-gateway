import { describe, it, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Imported directly — `job-db.ts` takes its path as a parameter and has no `env.js` import
// chain, so this file exercises it with zero environment variables (the CI condition). Same
// convention as `usage.test.ts` / `agent/ground.test.ts`.
import { openJobDb, type JobRecord } from './job-db.js'
import type { ResearchReport } from '../agent/schema.js'

const HEARTBEAT_STALE_MS = 90_000 // mirrors job-store.ts's threshold

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'research-gateway-job-db-'))
  return join(dir, 'jobs.sqlite')
}

function report(overrides: Partial<ResearchReport> = {}): ResearchReport {
  return {
    report: 'The answer is 42.',
    citations: [{ claim: '42', url: 'https://a.example', confidence: 'high' }],
    sources: ['https://a.example'],
    unverified: [],
    status: 'ok',
    warnings: [],
    cost: {
      wallMs: 1_000,
      totalUsd: 0.01,
      llmUsd: 0.005,
      searchUsd: 0.005,
      searchCalls: 1,
      tavilyCredits: 0,
      tavilyExtractCalls: 0,
    },
    grounding: {
      pagesRetrieved: 1,
      pagesMissing: 0,
      pagesFailed: 0,
      citationsKept: 1,
      citationsDropped: 0,
      confidenceCapped: 0,
    },
    ...overrides,
  }
}

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    jobId: crypto.randomUUID(),
    status: 'queued',
    query: 'what is the answer',
    depth: 'standard',
    createdAt: Date.now(),
    attempts: 0,
    owner: 'owner-a',
    ...overrides,
  }
}

describe('openJobDb — durability', () => {
  it('a done job with its full result survives closing and reopening the same database file', () => {
    const dbPath = tmpDbPath()

    const first = openJobDb(dbPath)
    const done = job({
      status: 'done',
      startedAt: Date.now() - 1000,
      finishedAt: Date.now(),
      result: report(),
    })
    first.put(done)
    first.close()

    const second = openJobDb(dbPath)
    const reloaded = second.all().find((j) => j.jobId === done.jobId)
    expect(reloaded).toEqual(done)
    second.close()
  })

  it('a done result is readable by id after a restart — the read path getJob uses', () => {
    const dbPath = tmpDbPath()
    const first = openJobDb(dbPath)
    const done = job({ status: 'done', finishedAt: Date.now(), result: report() })
    first.put(done)
    first.close()

    const second = openJobDb(dbPath)
    expect(second.get(done.jobId)?.result).toEqual(report())
    second.close()
  })

  it('deleteFinishedBefore expires only terminal rows past the cutoff, never live ones', () => {
    const db = openJobDb(':memory:')
    const now = Date.now()
    const old = job({ status: 'done', finishedAt: now - 5 * 3_600_000, result: report() })
    const oldError = job({ status: 'error', error: 'x', finishedAt: now - 5 * 3_600_000 })
    const recent = job({ status: 'done', finishedAt: now - 60_000, result: report() })
    const ancientButRunning = job({ status: 'running', createdAt: now - 10 * 3_600_000 })
    for (const j of [old, oldError, recent, ancientButRunning]) db.put(j)

    expect(db.deleteFinishedBefore(now - 4 * 3_600_000)).toBe(2)
    expect(db.get(old.jobId)).toBeUndefined()
    expect(db.get(oldError.jobId)).toBeUndefined()
    expect(db.get(recent.jobId)?.result).toEqual(report())
    expect(db.get(ancientButRunning.jobId)?.status).toBe('running')
    db.close()
  })

  it('put upserts: a second put with the same jobId and the same owner overwrites rather than duplicating', () => {
    const db = openJobDb(':memory:')
    const id = crypto.randomUUID()
    db.put(job({ jobId: id, status: 'queued', owner: 'owner-a' }))
    db.put(job({ jobId: id, status: 'running', startedAt: 123, owner: 'owner-a' }))

    const all = db.all()
    expect(all).toHaveLength(1)
    expect(all[0]?.status).toBe('running')
    expect(all[0]?.startedAt).toBe(123)
    db.close()
  })

  it('delete removes a row', () => {
    const db = openJobDb(':memory:')
    const id = crypto.randomUUID()
    db.put(job({ jobId: id }))
    db.delete(id)
    expect(db.all()).toEqual([])
    db.close()
  })
})

// ── put() ownership fencing — the guarantee that replaces reapInterrupted ───────────────────
// A replica whose lease was reassigned by claimStale must not be able to overwrite the
// adopter's row with its own stale idea of the job's state.
describe('openJobDb — put() is owner-fenced', () => {
  it('applies a status-transition write from the CURRENT owner', () => {
    const db = openJobDb(':memory:')
    const id = crypto.randomUUID()
    db.put(job({ jobId: id, status: 'queued', owner: 'owner-a' }))

    const wrote = db.put(job({ jobId: id, status: 'running', owner: 'owner-a', startedAt: 1 }))
    expect(wrote).toBe(true)
    expect(db.get(id)?.status).toBe('running')
    db.close()
  })

  it('refuses a write from a FORMER owner once the row belongs to someone else', () => {
    const db = openJobDb(':memory:')
    const id = crypto.randomUUID()
    db.put(job({ jobId: id, status: 'running', owner: 'owner-a' }))
    // owner-a's lease goes stale and owner-b adopts it.
    db.claimStale('owner-b', Date.now(), Date.now())

    // owner-a, unaware its lease is gone, tries to write its own idea of the job's outcome.
    const wrote = db.put(job({ jobId: id, status: 'done', owner: 'owner-a', result: report() }))
    expect(wrote).toBe(false)
    // The adopter's row (status reset to queued by claimStale) is untouched by the stale write.
    expect(db.get(id)?.status).toBe('queued')
    expect(db.get(id)?.owner).toBe('owner-b')
    db.close()
  })

  it('the initial INSERT always succeeds regardless of owner, since there is no existing lease to fence against', () => {
    const db = openJobDb(':memory:')
    const wrote = db.put(job({ owner: 'owner-a' }))
    expect(wrote).toBe(true)
    db.close()
  })
})

// ── renewLease / releaseLease — the lease itself ────────────────────────────────────────────
describe('openJobDb — renewLease', () => {
  it('renews the heartbeat when the caller still holds the lease', () => {
    const db = openJobDb(':memory:')
    const id = crypto.randomUUID()
    db.put(job({ jobId: id, status: 'running', owner: 'owner-a' }))

    const now = Date.now()
    expect(db.renewLease(id, 'owner-a', now)).toBe(true)
    expect(db.get(id)?.heartbeatAt).toBe(now)
    db.close()
  })

  it('returns false — the lease-lost signal — once another owner has claimed the row', () => {
    const db = openJobDb(':memory:')
    const id = crypto.randomUUID()
    db.put(job({ jobId: id, status: 'running', owner: 'owner-a' }))
    db.claimStale('owner-b', Date.now(), Date.now())

    expect(db.renewLease(id, 'owner-a', Date.now())).toBe(false)
    db.close()
  })
})

describe('openJobDb — releaseLease', () => {
  it('clears the heartbeat so the row is immediately claimable, without changing status', () => {
    const db = openJobDb(':memory:')
    const id = crypto.randomUUID()
    db.put(job({ jobId: id, status: 'running', owner: 'owner-a' }))
    db.renewLease(id, 'owner-a', Date.now())

    db.releaseLease(id, 'owner-a')
    const row = db.get(id)
    expect(row?.heartbeatAt).toBeUndefined()
    expect(row?.status).toBe('running')

    // Immediately claimable — staleBefore = now still catches a NULL heartbeat.
    const claimed = db.claimStale('owner-b', Date.now(), Date.now())
    expect(claimed.map((j) => j.jobId)).toContain(id)
    // A voluntary hand-off does not count toward the crash-loop guard: release + claim is net zero.
    expect(claimed.find((j) => j.jobId === id)?.attempts).toBe(0)
    db.close()
  })

  it('is a no-op when the caller no longer holds the lease', () => {
    const db = openJobDb(':memory:')
    const id = crypto.randomUUID()
    db.put(job({ jobId: id, status: 'running', owner: 'owner-a' }))
    db.renewLease(id, 'owner-a', Date.now() - HEARTBEAT_STALE_MS - 1_000) // legitimately stale
    db.claimStale('owner-b', Date.now(), Date.now() - HEARTBEAT_STALE_MS) // owner-b adopts it

    db.releaseLease(id, 'owner-a') // stale caller, no longer the owner
    expect(db.get(id)?.heartbeatAt).not.toBeUndefined() // owner-b's fresh heartbeat survives
    db.close()
  })
})

describe('openJobDb — ownsLease', () => {
  it('is true for the current owner and false for anyone else', () => {
    const db = openJobDb(':memory:')
    const id = crypto.randomUUID()
    db.put(job({ jobId: id, status: 'running', owner: 'owner-a' }))

    expect(db.ownsLease(id, 'owner-a')).toBe(true)
    expect(db.ownsLease(id, 'owner-b')).toBe(false)
    db.close()
  })

  it('is false for a job id that does not exist', () => {
    const db = openJobDb(':memory:')
    expect(db.ownsLease(crypto.randomUUID(), 'owner-a')).toBe(false)
    db.close()
  })

  it('flips to the adopter once claimStale reassigns the lease', () => {
    const db = openJobDb(':memory:')
    const id = crypto.randomUUID()
    db.put(job({ jobId: id, status: 'running', owner: 'owner-a' }))
    db.renewLease(id, 'owner-a', Date.now() - HEARTBEAT_STALE_MS - 1_000)

    db.claimStale('owner-b', Date.now(), Date.now() - HEARTBEAT_STALE_MS)

    expect(db.ownsLease(id, 'owner-a')).toBe(false)
    expect(db.ownsLease(id, 'owner-b')).toBe(true)
    db.close()
  })

  it('never writes — a read-only check', () => {
    const db = openJobDb(':memory:')
    const id = crypto.randomUUID()
    db.put(job({ jobId: id, status: 'running', owner: 'owner-a' }))
    const before = db.get(id)

    db.ownsLease(id, 'owner-a')
    db.ownsLease(id, 'someone-else')

    expect(db.get(id)).toEqual(before)
    db.close()
  })
})

// ── claimStale — the compare-and-set that replaces reapInterrupted ──────────────────────────
describe('openJobDb — claimStale', () => {
  it('never re-claims a job the caller itself still owns, however stale its heartbeat', () => {
    const db = openJobDb(':memory:')
    const id = crypto.randomUUID()
    db.put(job({ jobId: id, status: 'running', owner: 'owner-a' }))
    db.renewLease(id, 'owner-a', Date.now() - HEARTBEAT_STALE_MS - 1_000)

    expect(db.claimStale('owner-a', Date.now(), Date.now() - HEARTBEAT_STALE_MS)).toEqual([])
    expect(db.claimStale('owner-b', Date.now(), Date.now() - HEARTBEAT_STALE_MS).map((j) => j.jobId)).toEqual([id])
    db.close()
  })

  it('claims a running job with no heartbeat at all, resetting it to queued for the adopter', () => {
    const db = openJobDb(':memory:')
    const id = crypto.randomUUID()
    db.put(job({ jobId: id, status: 'running', owner: 'owner-a' })) // never heartbeated

    const claimed = db.claimStale('owner-b', Date.now(), Date.now() - HEARTBEAT_STALE_MS)
    expect(claimed).toHaveLength(1)
    expect(claimed[0]?.jobId).toBe(id)
    expect(claimed[0]?.status).toBe('queued')
    expect(claimed[0]?.owner).toBe('owner-b')
    expect(claimed[0]?.attempts).toBe(1)
    db.close()
  })

  it('claims a job whose heartbeat has gone stale, and increments attempts on each claim', () => {
    const db = openJobDb(':memory:')
    const id = crypto.randomUUID()
    db.put(job({ jobId: id, status: 'running', owner: 'owner-a' }))
    db.renewLease(id, 'owner-a', Date.now() - HEARTBEAT_STALE_MS - 30_000)

    const first = db.claimStale('owner-b', Date.now(), Date.now() - HEARTBEAT_STALE_MS)
    expect(first).toHaveLength(1)
    expect(first[0]?.attempts).toBe(1)

    db.renewLease(id, 'owner-b', Date.now() - HEARTBEAT_STALE_MS - 30_000)
    const second = db.claimStale('owner-c', Date.now(), Date.now() - HEARTBEAT_STALE_MS)
    expect(second).toHaveLength(1)
    expect(second[0]?.attempts).toBe(2)
    expect(second[0]?.owner).toBe('owner-c')
    db.close()
  })

  it('leaves a job with a FRESH heartbeat untouched — a live owner must not be adopted out from under it', () => {
    const db = openJobDb(':memory:')
    const id = crypto.randomUUID()
    db.put(job({ jobId: id, status: 'running', owner: 'owner-a' }))
    db.renewLease(id, 'owner-a', Date.now())

    const claimed = db.claimStale('owner-b', Date.now(), Date.now() - HEARTBEAT_STALE_MS)
    expect(claimed).toHaveLength(0)
    expect(db.get(id)?.owner).toBe('owner-a')
    db.close()
  })

  it('claims a QUEUED job the same way as a running one — the lease spans the whole lifetime', () => {
    const db = openJobDb(':memory:')
    const id = crypto.randomUUID()
    db.put(job({ jobId: id, status: 'queued', owner: 'owner-a' }))

    const claimed = db.claimStale('owner-b', Date.now(), Date.now() - HEARTBEAT_STALE_MS)
    expect(claimed).toHaveLength(1)
    expect(claimed[0]?.status).toBe('queued')
    db.close()
  })

  it('leaves already-terminal jobs untouched', () => {
    const db = openJobDb(':memory:')
    const done = job({ status: 'done', result: report() })
    const errored = job({ status: 'error', error: 'boom' })
    db.put(done)
    db.put(errored)

    const claimed = db.claimStale('owner-b', Date.now(), Date.now())
    expect(claimed).toHaveLength(0)
    db.close()
  })

  it('carries the checkpoint along with a claim, so the adopter can resume from it', () => {
    const db = openJobDb(':memory:')
    const id = crypto.randomUUID()
    db.put(job({ jobId: id, status: 'running', owner: 'owner-a' }))
    db.saveCheckpoint(id, 'owner-a', '{"version":1,"round":2}')

    const claimed = db.claimStale('owner-b', Date.now(), Date.now())
    expect(claimed[0]?.checkpointJson).toBe('{"version":1,"round":2}')
    db.close()
  })
})

// ── saveCheckpoint ───────────────────────────────────────────────────────────────────────────
describe('openJobDb — saveCheckpoint', () => {
  it('persists a checkpoint for the current owner', () => {
    const db = openJobDb(':memory:')
    const id = crypto.randomUUID()
    db.put(job({ jobId: id, status: 'running', owner: 'owner-a' }))

    db.saveCheckpoint(id, 'owner-a', '{"version":1}')
    expect(db.get(id)?.checkpointJson).toBe('{"version":1}')
    db.close()
  })

  it('clears a checkpoint when passed null', () => {
    const db = openJobDb(':memory:')
    const id = crypto.randomUUID()
    db.put(job({ jobId: id, status: 'running', owner: 'owner-a' }))
    db.saveCheckpoint(id, 'owner-a', '{"version":1}')

    db.saveCheckpoint(id, 'owner-a', null)
    expect(db.get(id)?.checkpointJson).toBeUndefined()
    db.close()
  })

  it('is fenced the same way renewLease is — a former owner cannot write a stale checkpoint over the adopter\'s', () => {
    const db = openJobDb(':memory:')
    const id = crypto.randomUUID()
    db.put(job({ jobId: id, status: 'running', owner: 'owner-a' }))
    db.claimStale('owner-b', Date.now(), Date.now())

    db.saveCheckpoint(id, 'owner-a', '{"version":1,"stale":true}')
    expect(db.get(id)?.checkpointJson).toBeUndefined()
    db.close()
  })
})

// `get()` is what job-store.ts's `getJob` reaches for when the polled job belongs to the OTHER
// replica of a rolling deploy: its in-memory copy of that job is frozen at boot while the owner
// keeps writing to it, so trusting the cache reaped a live job out from under it.
describe('openJobDb — single-row read', () => {
  it('returns undefined for a job id that was never written', () => {
    const db = openJobDb(':memory:')
    expect(db.get(crypto.randomUUID())).toBeUndefined()
    db.close()
  })

  it('reads back a row the same shape all() gives, result included', () => {
    const db = openJobDb(':memory:')
    const id = crypto.randomUUID()
    const record = job({ jobId: id, status: 'done', result: report(), finishedAt: Date.now() })
    db.put(record)

    const got = db.get(id)
    expect(got?.status).toBe('done')
    expect(got?.result).toEqual(record.result as ResearchReport)
    expect(got).toEqual(db.all().find((j) => j.jobId === id) as JobRecord)
    db.close()
  })

  it('sees a heartbeat written after the row was read once — the whole reason it exists', () => {
    const db = openJobDb(':memory:')
    const id = crypto.randomUUID()
    db.put(job({ jobId: id, status: 'running', owner: 'owner-a' }))
    const beforeTouch = db.get(id)
    expect(beforeTouch?.heartbeatAt).toBeUndefined()

    const now = Date.now()
    db.renewLease(id, 'owner-a', now)
    expect(db.get(id)?.heartbeatAt).toBe(now)
    db.close()
  })
})

describe('openJobDb — schema migration', () => {
  it('opens a database file created before heartbeat_at/owner/attempts/checkpoint_json existed without crashing, and migrates it', () => {
    const dbPath = tmpDbPath()

    // Simulate a database created by the pre-lease version of this module.
    const legacy = new Database(dbPath, { create: true })
    legacy.exec(`
      CREATE TABLE job (
        job_id      TEXT PRIMARY KEY,
        status      TEXT NOT NULL,
        query       TEXT NOT NULL,
        depth       TEXT NOT NULL,
        result_json TEXT,
        error       TEXT,
        created_at  INTEGER NOT NULL,
        started_at  INTEGER,
        finished_at INTEGER
      );
    `)
    legacy.run('INSERT INTO job (job_id, status, query, depth, created_at) VALUES (?, ?, ?, ?, ?)', [
      'legacy-1',
      'running',
      'a pre-migration job',
      'standard',
      Date.now(),
    ])
    legacy.close()

    let db: ReturnType<typeof openJobDb> | undefined
    expect(() => {
      db = openJobDb(dbPath)
    }).not.toThrow()
    expect(db?.all().find((j) => j.jobId === 'legacy-1')).toBeDefined()
    // A legacy row has no owner — claimable immediately, same treatment a NULL heartbeat
    // always got, and attempts defaults to 0 via the column's own DEFAULT.
    expect(db?.get('legacy-1')?.owner).toBeUndefined()
    expect(db?.get('legacy-1')?.attempts).toBe(0)
    const claimed = db?.claimStale('owner-a', Date.now(), Date.now())
    expect(claimed?.map((j) => j.jobId)).toContain('legacy-1')
    db?.close()
  })

  it('opens a database created before context existed, migrates it, and puts with context work', () => {
    const dbPath = tmpDbPath()

    // Simulate the current-at-heartbeat-era schema: has heartbeat_at, no context column.
    const legacy = new Database(dbPath, { create: true })
    legacy.exec(`
      CREATE TABLE job (
        job_id      TEXT PRIMARY KEY,
        status      TEXT NOT NULL,
        query       TEXT NOT NULL,
        depth       TEXT NOT NULL,
        result_json TEXT,
        error       TEXT,
        created_at  INTEGER NOT NULL,
        started_at  INTEGER,
        finished_at INTEGER,
        heartbeat_at INTEGER
      );
    `)
    legacy.close()

    let db: ReturnType<typeof openJobDb> | undefined
    expect(() => {
      db = openJobDb(dbPath)
    }).not.toThrow()

    const carried = job({ jobId: 'carried-1', context: 'Bun 1.2 is current; tier-3 boots reworked.' })
    expect(() => db?.put(carried)).not.toThrow()
    expect(db?.get('carried-1')?.context).toBe('Bun 1.2 is current; tier-3 boots reworked.')
    expect(db?.get('legacy-absent')?.context).toBeUndefined()
    db?.close()
  })
})

describe('openJobDb — context column', () => {
  it('round-trips an optional context through put/all/get, and omits it when absent', () => {
    const db = openJobDb(':memory:')

    const withContext = job({ context: 'patch 7.2 removed boot enchants' })
    db.put(withContext)
    expect(db.all().find((j) => j.jobId === withContext.jobId)?.context).toBe(
      'patch 7.2 removed boot enchants',
    )
    expect(db.get(withContext.jobId)?.context).toBe('patch 7.2 removed boot enchants')

    const withoutContext = job()
    db.put(withoutContext)
    const reloaded = db.get(withoutContext.jobId)
    expect(reloaded).toEqual(withoutContext)
    expect('context' in (reloaded ?? {})).toBe(false)
    db.close()
  })
})
