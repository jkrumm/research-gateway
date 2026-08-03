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
    grounding: { pagesRetrieved: 1, pagesFailed: 0, citationsKept: 1, citationsDropped: 0, confidenceCapped: 0 },
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
    ...overrides,
  }
}

describe('openJobDb — status-only durability', () => {
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

  it('reaps a running job with no heartbeat to a terminal error on reopen, never rehydrating it as running', () => {
    const dbPath = tmpDbPath()

    const first = openJobDb(dbPath)
    const running = job({ status: 'running', startedAt: Date.now() })
    first.put(running)
    // No heartbeat was ever stamped for this job — simulates the process dying mid-run
    // before its first heartbeat tick, or a heartbeat that has since gone fully cold.
    first.close()

    const second = openJobDb(dbPath)
    const reaped = second.reapInterrupted('lost to a restart, resubmit the query', Date.now())
    expect(reaped).toHaveLength(1)
    expect(reaped[0]?.jobId).toBe(running.jobId)
    expect(reaped[0]?.status).toBe('error')
    expect(reaped[0]?.error).toBe('lost to a restart, resubmit the query')

    // And the reap was persisted, not just returned in memory.
    const reloaded = second.all().find((j) => j.jobId === running.jobId)
    expect(reloaded?.status).toBe('error')
    expect(reloaded?.error).toBe('lost to a restart, resubmit the query')
    second.close()
  })

  it('reaps a queued job the same way as a running one', () => {
    const dbPath = tmpDbPath()
    const db = openJobDb(dbPath)
    db.put(job({ status: 'queued' }))

    const reaped = db.reapInterrupted('interrupted', Date.now())
    expect(reaped).toHaveLength(1)
    expect(reaped[0]?.status).toBe('error')
    db.close()
  })

  it('leaves already-terminal jobs untouched by reapInterrupted', () => {
    const db = openJobDb(':memory:')
    const done = job({ status: 'done', result: report() })
    const errored = job({ status: 'error', error: 'boom' })
    db.put(done)
    db.put(errored)

    const reaped = db.reapInterrupted('interrupted', Date.now())
    expect(reaped).toHaveLength(0)
    const all = db.all()
    expect(all.find((j) => j.jobId === done.jobId)?.status).toBe('done')
    expect(all.find((j) => j.jobId === errored.jobId)?.status).toBe('error')
    db.close()
  })

  it('put upserts: a second put with the same jobId overwrites rather than duplicating', () => {
    const db = openJobDb(':memory:')
    const id = crypto.randomUUID()
    db.put(job({ jobId: id, status: 'queued' }))
    db.put(job({ jobId: id, status: 'running', startedAt: 123 }))

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

// ── Heartbeat-based reaping — the regression coverage for the rolling-deploy bug ────────────
// rollhook runs two replicas against the SAME sqlite file for a brief overlap during a deploy.
// A blanket "reap everything queued/running at boot" would let the NEW replica kill jobs the
// OLD replica is still actively executing. reapInterrupted must only touch rows nobody is
// currently proving alive.
describe('openJobDb — heartbeat-based reaping', () => {
  it('leaves a running job with a FRESH heartbeat untouched — a live sibling replica must not be reaped out from under it', () => {
    const db = openJobDb(':memory:')
    const id = crypto.randomUUID()
    db.put(job({ jobId: id, status: 'running', startedAt: Date.now() }))
    db.touchHeartbeat(id, Date.now())

    const reaped = db.reapInterrupted('interrupted', Date.now() - HEARTBEAT_STALE_MS)
    expect(reaped).toHaveLength(0)
    expect(db.all().find((j) => j.jobId === id)?.status).toBe('running')
    db.close()
  })

  it('reaps a running job whose heartbeat has gone stale', () => {
    const db = openJobDb(':memory:')
    const id = crypto.randomUUID()
    db.put(job({ jobId: id, status: 'running', startedAt: Date.now() }))
    db.touchHeartbeat(id, Date.now() - HEARTBEAT_STALE_MS - 30_000) // well past the threshold

    const reaped = db.reapInterrupted('interrupted', Date.now() - HEARTBEAT_STALE_MS)
    expect(reaped).toHaveLength(1)
    expect(reaped[0]?.jobId).toBe(id)
    expect(db.all().find((j) => j.jobId === id)?.status).toBe('error')
    db.close()
  })

  it('reaps a running job with no heartbeat at all', () => {
    const db = openJobDb(':memory:')
    const id = crypto.randomUUID()
    db.put(job({ jobId: id, status: 'running', startedAt: Date.now() })) // never touched

    const reaped = db.reapInterrupted('interrupted', Date.now() - HEARTBEAT_STALE_MS)
    expect(reaped).toHaveLength(1)
    expect(reaped[0]?.jobId).toBe(id)
    db.close()
  })

  // The regression test for the SECOND rolling-deploy bug: the heartbeat now spans a job's
  // whole lifetime, including the queued wait before a concurrency slot frees up (which can be
  // 30+ minutes under load — see job-store.ts's startResearchJob). A `queued` job with a fresh
  // heartbeat must survive a sibling replica's boot reap exactly like a `running` one does.
  it('leaves a QUEUED job with a fresh heartbeat untouched by reapInterrupted', () => {
    const db = openJobDb(':memory:')
    const id = crypto.randomUUID()
    db.put(job({ jobId: id, status: 'queued' }))
    db.touchHeartbeat(id, Date.now())

    const reaped = db.reapInterrupted('interrupted', Date.now() - HEARTBEAT_STALE_MS)
    expect(reaped).toHaveLength(0)
    expect(db.all().find((j) => j.jobId === id)?.status).toBe('queued')
    db.close()
  })

  it('put() never overwrites an existing heartbeat — only touchHeartbeat may', () => {
    const db = openJobDb(':memory:')
    const id = crypto.randomUUID()
    db.put(job({ jobId: id, status: 'running', startedAt: Date.now() }))
    db.touchHeartbeat(id, Date.now())
    // A status-transition write (e.g. run-job.ts's final updateJob) must not clear the
    // heartbeat a concurrent heartbeat tick just stamped.
    db.put(job({ jobId: id, status: 'done', result: report() }))

    const reaped = db.reapInterrupted('interrupted', Date.now() - HEARTBEAT_STALE_MS)
    expect(reaped).toHaveLength(0) // already terminal, but also proves put() didn't null the heartbeat out from under a live row
    db.close()
  })
})

describe('openJobDb — schema migration', () => {
  it('opens a database file created before heartbeat_at existed without crashing, and migrates it', () => {
    const dbPath = tmpDbPath()

    // Simulate a database created by the pre-heartbeat version of this module.
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
    expect(() => db?.touchHeartbeat('legacy-1', Date.now())).not.toThrow()
    expect(db?.all().find((j) => j.jobId === 'legacy-1')).toBeDefined()
    db?.close()
  })
})
