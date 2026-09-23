import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
// Type-only import: erased by `verbatimModuleSyntax` at compile time, so this establishes
// no runtime dependency on `agent/schema.ts` (which itself imports nothing but zod — but the
// erasure means it wouldn't matter even if it did). Kept OFF the `env.ts` import chain on
// purpose: this module takes its database path as a parameter instead of reading env itself,
// so `bun test` can exercise it with zero environment variables — see job-db.test.ts and the
// same convention in `usage.test.ts` / `agent/ground.test.ts`.
import type { Depth, JobStatus, ResearchReport } from '../agent/schema.js'

// Durability for the job store: a job's status, query/depth, and (once terminal) its
// result/error survive a process restart — AND, since the lease/checkpoint rework below, so
// does enough of the agent's own progress to resume a job an owning process lost, rather than
// only reap it to a terminal error. `checkpoint_json` (opaque here — `checkpoint.ts` owns its
// shape) is what makes that possible; `owner`/`attempts` are what make handing a job to a NEW
// process safe while rollhook briefly runs two replicas against the SAME sqlite file.
//
// Ownership is a LEASE, not a fact recorded once: `owner` names whichever process currently
// heartbeats a job, `put()` is fenced so a replica that lost its lease cannot clobber the
// adopter's row (see its own comment below), and `claimStale`/`releaseLease` are the only ways
// a lease changes hands. This replaces the old "reap to a terminal error" model — a job whose
// owner's heartbeat goes stale is no longer a loss, it is CLAIMED by whichever process notices
// next (see job-store.ts's adoption loop), which resumes it from `checkpoint_json` instead of
// starting over. `attempts` exists so a poison job (one that crashes whatever process touches
// it) cannot loop forever between replicas — job-store.ts caps it.
//
// The heartbeat still spans a job's ENTIRE lifetime, not just 'running': job-store.ts starts
// it before `withSlot`'s concurrency wait, so a merely-`queued` job carries a live lease too.
// A NULL `heartbeat_at` reliably means "nobody is proving this job alive right now" — either a
// legacy row from before this mechanism existed, or a lease `releaseLease` just gave up — both
// are safe for `claimStale` to pick up immediately regardless of `staleBefore`.

export interface JobRecord {
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
  /**
   * The process instance currently leasing this job — see job-store.ts's `INSTANCE_ID`.
   * Undefined only for a legacy row written before this column existed, which is claimable
   * immediately (the same treatment a NULL heartbeat always got).
   */
  owner?: string
  /**
   * How many times this job has been (re)claimed after its previous owner's lease went
   * stale. 0 for a job no process has ever had to adopt. job-store.ts's crash-loop guard
   * reads this to stop resurrecting a job that kills every process that runs it.
   */
  attempts: number
  /**
   * A serialized `ResearchCheckpoint` (agent/checkpoint.ts) — opaque here, this module never
   * parses it. Undefined when no round has completed yet, or once the job reaches a terminal
   * status (cleared via `saveCheckpoint(jobId, owner, null)`).
   */
  checkpointJson?: string
}

export interface JobDb {
  /**
   * Insert a new job (sets `owner`/`attempts`) or apply a status-transition update to an
   * existing one. The update is OWNER-FENCED: it takes effect only `WHERE job.owner IS
   * excluded.owner` — i.e. only if the row's CURRENT owner is the same process making the
   * write. A replica whose lease was reassigned by `claimStale` (its heartbeat went stale and
   * another process adopted the job) therefore cannot overwrite the adopter's row with its own
   * stale idea of the job's state, even if it has not yet noticed the lease is gone — its
   * write is silently refused rather than raced. Returns whether the write took effect; a
   * caller that gets `false` back should treat its own in-flight run as fenced (job-store.ts's
   * heartbeat tick does exactly this). Never touches `heartbeat_at`, `attempts` or
   * `checkpoint_json` on an existing row — those are `renewLease`/`claimStale`/
   * `saveCheckpoint`'s alone to write, the same convention `heartbeat_at` already had.
   */
  put(job: JobRecord): boolean
  delete(jobId: string): void
  all(): JobRecord[]
  /**
   * One job by id, read fresh from the file. The in-memory cache in job-store.ts is hydrated
   * once at boot and only kept current for jobs THIS process owns, so a job belonging to a
   * sibling replica must be re-read here rather than trusted from that snapshot.
   */
  get(jobId: string): JobRecord | undefined
  /**
   * Renews `owner`'s lease on `jobId` by stamping a fresh heartbeat — but ONLY if `owner`
   * still holds it (`WHERE job_id = ? AND owner = ?`). Returns false when the lease is
   * already gone (another process's `claimStale` reassigned it), which is the one signal a
   * heartbeat tick has that its run has been fenced — see job-store.ts's `job.lease_lost`.
   * Replaces the old unconditional `touchHeartbeat`.
   */
  renewLease(jobId: string, owner: string, now: number): boolean
  /**
   * Atomically claims every `queued`/`running` row whose heartbeat is NULL or older than
   * `staleBefore`: sets `owner`, resets `heartbeat_at` to `now`, increments `attempts`, and
   * resets `status` to `'queued'` so the adopting process re-dispatches it through the normal
   * concurrency semaphore rather than assuming it may resume "running" work that never
   * actually kept running. One `UPDATE ... RETURNING` statement — SQLite serializes writers
   * across both replicas sharing this file, and the `WHERE` re-checks staleness at write time,
   * so this is the compare-and-set that makes it impossible for two processes to both claim
   * the same job: whichever one's UPDATE commits first changes the row's `heartbeat_at` away
   * from stale, so the other's `WHERE` no longer matches when its turn comes.
   */
  claimStale(owner: string, now: number, staleBefore: number): JobRecord[]
  /**
   * Gives up `owner`'s lease on `jobId` without changing its status, by clearing
   * `heartbeat_at` — a NULL heartbeat is immediately stale, so the very next `claimStale`
   * (a sibling's, or this process's own on its next boot) can adopt the job rather than
   * waiting out the full staleness window. No-op if `owner` no longer holds the lease. Used by
   * a drain that hands queued/running work to whichever replica survives it.
   */
  releaseLease(jobId: string, owner: string): void
  /**
   * Persists (or, with `json === null`, clears) a resumable checkpoint for a job `owner`
   * currently leases. Fenced the same way `renewLease` is: a write from a process that has
   * lost the lease is silently ignored rather than racing the adopter's own checkpoint writes.
   */
  saveCheckpoint(jobId: string, owner: string, json: string | null): void
  close(): void
}

interface JobRow {
  job_id: string
  status: string
  query: string
  depth: string
  context: string | null
  result_json: string | null
  error: string | null
  created_at: number
  started_at: number | null
  finished_at: number | null
  heartbeat_at: number | null
  owner: string | null
  attempts: number
  checkpoint_json: string | null
}

function toRecord(row: JobRow): JobRecord {
  return {
    jobId: row.job_id,
    status: row.status as JobStatus,
    query: row.query,
    depth: row.depth as Depth,
    ...(row.context !== null ? { context: row.context } : {}),
    ...(row.result_json !== null ? { result: JSON.parse(row.result_json) as ResearchReport } : {}),
    ...(row.error !== null ? { error: row.error } : {}),
    createdAt: row.created_at,
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    ...(row.finished_at !== null ? { finishedAt: row.finished_at } : {}),
    ...(row.heartbeat_at !== null ? { heartbeatAt: row.heartbeat_at } : {}),
    ...(row.owner !== null ? { owner: row.owner } : {}),
    attempts: row.attempts,
    ...(row.checkpoint_json !== null ? { checkpointJson: row.checkpoint_json } : {}),
  }
}

export function openJobDb(dbPath: string): JobDb {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })

  const db = new Database(dbPath, { create: true })
  db.exec('PRAGMA journal_mode = WAL;')
  // Two replicas write this file during a rolling deploy (heartbeats every 15s per job, claims
  // every 30s, per-round checkpoints). Without a busy timeout a colliding write throws
  // SQLITE_BUSY at once instead of waiting a few milliseconds for the other writer's lock.
  db.exec('PRAGMA busy_timeout = 5000;')
  db.exec(`
    CREATE TABLE IF NOT EXISTS job (
      job_id      TEXT PRIMARY KEY,
      status      TEXT NOT NULL,
      query       TEXT NOT NULL,
      depth       TEXT NOT NULL,
      context     TEXT,
      result_json TEXT,
      error       TEXT,
      created_at  INTEGER NOT NULL,
      started_at  INTEGER,
      finished_at INTEGER,
      heartbeat_at INTEGER
    );
  `)

  // Idempotent column migrations: a database created by an older version of this module may
  // be missing columns added since, and referencing the matching named parameter in a
  // prepared statement against that schema throws at prepare time. Same pattern throughout.
  const cols = db.query('PRAGMA table_info(job)').all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'context')) {
    db.exec('ALTER TABLE job ADD COLUMN context TEXT')
  }
  if (!cols.some((c) => c.name === 'heartbeat_at')) {
    db.exec('ALTER TABLE job ADD COLUMN heartbeat_at INTEGER')
  }
  if (!cols.some((c) => c.name === 'owner')) {
    db.exec('ALTER TABLE job ADD COLUMN owner TEXT')
  }
  if (!cols.some((c) => c.name === 'attempts')) {
    db.exec('ALTER TABLE job ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0')
  }
  if (!cols.some((c) => c.name === 'checkpoint_json')) {
    db.exec('ALTER TABLE job ADD COLUMN checkpoint_json TEXT')
  }

  const putStmt = db.prepare(`
    INSERT INTO job (job_id, status, query, depth, context, result_json, error, created_at, started_at, finished_at, heartbeat_at, owner, attempts)
    VALUES ($jobId, $status, $query, $depth, $context, $resultJson, $error, $createdAt, $startedAt, $finishedAt, $heartbeatAt, $owner, $attempts)
    ON CONFLICT(job_id) DO UPDATE SET
      status = excluded.status,
      query = excluded.query,
      depth = excluded.depth,
      context = excluded.context,
      result_json = excluded.result_json,
      error = excluded.error,
      created_at = excluded.created_at,
      started_at = excluded.started_at,
      finished_at = excluded.finished_at
      -- heartbeat_at/owner/attempts/checkpoint_json deliberately NOT in this SET list: they
      -- are owned exclusively by renewLease/claimStale/saveCheckpoint, so a status-transition
      -- write from another code path can never clobber a live lease or a saved checkpoint.
    WHERE job.owner IS excluded.owner
  `)

  const renewLeaseStmt = db.prepare(
    'UPDATE job SET heartbeat_at = $heartbeatAt WHERE job_id = $jobId AND owner = $owner',
  )

  const releaseLeaseStmt = db.prepare(
    // A voluntary release (a drain handing work on) is not a crash, so it gives back the
    // attempt the next claim will add — only a lease that went stale on its own counts
    // toward job-store.ts's MAX_JOB_ATTEMPTS crash-loop guard.
    'UPDATE job SET heartbeat_at = NULL, attempts = MAX(attempts - 1, -1) WHERE job_id = $jobId AND owner = $owner',
  )

  const saveCheckpointStmt = db.prepare(
    'UPDATE job SET checkpoint_json = $json WHERE job_id = $jobId AND owner = $owner',
  )

  // Single-row read by primary key. Exists for the one case the in-memory map cannot answer:
  // a job owned by the OTHER replica during a rolling deploy, whose row this process only ever
  // saw once (at boot) while the owner keeps writing to it. See job-store.ts's `getJob`.
  const getStmt = db.prepare('SELECT * FROM job WHERE job_id = ?')

  // One UPDATE, one statement, one implicit SQLite transaction — see the JobDb.claimStale
  // doc comment for why that alone is the compare-and-set two replicas racing this file need.
  const claimStaleStmt = db.prepare(`
    UPDATE job
    SET owner = $owner, heartbeat_at = $now, attempts = attempts + 1, status = 'queued'
    WHERE status IN ('queued', 'running')
      AND (heartbeat_at IS NULL OR heartbeat_at < $staleBefore)
      -- Never re-claim our own lease: after a local loop stall the adoption tick can run before
      -- the heartbeat tick, and self-claiming would start a second run of a job this process is
      -- still executing. INSTANCE_ID is per boot, so a restarted process still adopts its old jobs.
      AND (owner IS NULL OR owner != $owner)
    RETURNING *
  `)

  return {
    put(job: JobRecord): boolean {
      const result = putStmt.run({
        $jobId: job.jobId,
        $status: job.status,
        $query: job.query,
        $depth: job.depth,
        $context: job.context ?? null,
        $resultJson: job.result ? JSON.stringify(job.result) : null,
        $error: job.error ?? null,
        $createdAt: job.createdAt,
        $startedAt: job.startedAt ?? null,
        $finishedAt: job.finishedAt ?? null,
        // Only take effect on the initial INSERT (see the ON CONFLICT comment above).
        $heartbeatAt: job.heartbeatAt ?? null,
        $owner: job.owner ?? null,
        $attempts: job.attempts,
      })
      return result.changes > 0
    },

    delete(jobId: string): void {
      db.run('DELETE FROM job WHERE job_id = ?', [jobId])
    },

    all(): JobRecord[] {
      return (db.query('SELECT * FROM job').all() as JobRow[]).map(toRecord)
    },

    get(jobId: string): JobRecord | undefined {
      const row = getStmt.get(jobId) as JobRow | null
      return row === null ? undefined : toRecord(row)
    },

    renewLease(jobId: string, owner: string, now: number): boolean {
      const result = renewLeaseStmt.run({ $jobId: jobId, $owner: owner, $heartbeatAt: now })
      return result.changes > 0
    },

    claimStale(owner: string, now: number, staleBefore: number): JobRecord[] {
      const rows = claimStaleStmt.all({ $owner: owner, $now: now, $staleBefore: staleBefore }) as JobRow[]
      return rows.map(toRecord)
    },

    releaseLease(jobId: string, owner: string): void {
      releaseLeaseStmt.run({ $jobId: jobId, $owner: owner })
    },

    saveCheckpoint(jobId: string, owner: string, json: string | null): void {
      saveCheckpointStmt.run({ $jobId: jobId, $owner: owner, $json: json })
    },

    close(): void {
      db.close()
    },
  }
}
