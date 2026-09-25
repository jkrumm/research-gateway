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

// Status-only durability for the job store: a job's status, query/depth, and (once terminal)
// its result/error survive a process restart. This does NOT persist or resume the AGENT's
// own in-flight work (tool calls, retrieval ledger, partial digests) — a job caught mid-run
// by a restart is simply reaped to a terminal 'error' once its heartbeat goes stale (see
// `reapInterrupted`). Checkpoint/resume of the agent loop itself is a separate, later change.
//
// Reaping is heartbeat-based, NOT a blanket "everything queued/running at boot is dead":
// rollhook's rolling deploy briefly runs two replicas against the SAME sqlite file (the
// `research-gateway-data` volume). If boot reaped every queued/running row unconditionally,
// the NEW replica would kill jobs the OLD replica is still actively executing (or still has
// legitimately queued — a deep job runs up to ~21 minutes (measured max), so with
// `RESEARCH_MAX_CONCURRENCY=3` a
// queued job can wait well over half an hour) the moment it starts — the exact bug this
// heartbeat exists to prevent. A row only gets reaped once its `heartbeat_at` is stale (or was
// never set), which means no process is currently proving it alive — see job-store.ts's
// `startHeartbeat`/`touchHeartbeat` for the write side and its read-time staleness check in
// `getJob` for the other half of the guarantee.
//
// The heartbeat spans a job's ENTIRE lifetime, not just 'running': job-store.ts's
// `startResearchJob` starts it before `withSlot`'s concurrency wait, so a merely-`queued` job
// carries a live heartbeat too. That makes a NULL `heartbeat_at` a reliable signal on its own —
// it can now only mean a row written by code that predates this mechanism (a legacy row from
// before the `heartbeat_at` migration below) or a process that died in the sub-millisecond gap
// between `INSERT` and the first `touchHeartbeat` call, both of which are safe to reap
// immediately regardless of `staleBefore`. Before the queued-phase fix this was a much larger
// window (an entire legitimate queued wait could show as NULL), which is why `reapInterrupted`
// still special-cases NULL for immediate reaping rather than requiring `staleBefore` too — that
// treatment was reconsidered, not just carried over, once the gap it used to paper over closed.

export interface JobRecord {
  jobId: string
  status: JobStatus
  query: string
  depth: Depth
  context?: string
  // Set once at create when a caller supplies one (job-store.ts's createJob). Retained with
  // the row so a retried submit can find the original job by key — see `findByIdempotencyKey`.
  idempotencyKey?: string
  result?: ResearchReport
  error?: string
  createdAt: number
  startedAt?: number
  finishedAt?: number
  heartbeatAt?: number
}

export interface JobDb {
  /** Insert a new job or overwrite an existing one by jobId (used for both create and every status transition). Never touches `heartbeat_at` on an existing row — see `touchHeartbeat`. */
  put(job: JobRecord): void
  delete(jobId: string): void
  all(): JobRecord[]
  /**
   * One job by id, read fresh from the file. The in-memory cache in job-store.ts is hydrated
   * once at boot and only kept current for jobs THIS process owns, so a job belonging to a
   * sibling replica must be re-read here rather than trusted from that snapshot.
   */
  get(jobId: string): JobRecord | undefined
  /** Stamp the liveness heartbeat for a job. The only writer of `heartbeat_at`. */
  touchHeartbeat(jobId: string, heartbeatAt: number): void
  /**
   * Mark every 'queued'/'running' job whose heartbeat is stale (older than `staleBefore`) or
   * altogether absent as a terminal 'error' with the given message, persist that, and return
   * the reaped records. A job with a heartbeat newer than `staleBefore` is left untouched —
   * some process (possibly a sibling replica sharing this file) is still actively proving it
   * alive. Call once at boot, before hydrating an in-memory cache from `all()`.
   */
  reapInterrupted(message: string, staleBefore: number): JobRecord[]
  /**
   * Delete terminal jobs whose finish time (or create time, for a legacy row without one) is
   * older than `cutoff` — the retention sweep. A queued/running job is never touched. One
   * statement, so a store with many finished jobs is pruned without walking them into memory.
   */
  deleteFinishedBefore(cutoff: number): void
  /**
   * The most recent non-expired job carrying an idempotency key: a queued/running job, or a
   * terminal one whose finish time is at or after `cutoff`. Undefined when the key was never
   * used or every job that used it has aged out. Consulted by the submit dedupe path
   * (job-store.ts's `findActiveJobByIdempotencyKey`) — never the in-memory map, because the
   * job it wants back may be a terminal result retained only in sqlite.
   */
  findByIdempotencyKey(key: string, cutoff: number): JobRecord | undefined
  close(): void
}

interface JobRow {
  job_id: string
  status: string
  query: string
  depth: string
  context: string | null
  idempotency_key: string | null
  result_json: string | null
  error: string | null
  created_at: number
  started_at: number | null
  finished_at: number | null
  heartbeat_at: number | null
}

function toRecord(row: JobRow): JobRecord {
  return {
    jobId: row.job_id,
    status: row.status as JobStatus,
    query: row.query,
    depth: row.depth as Depth,
    ...(row.context !== null ? { context: row.context } : {}),
    ...(row.idempotency_key !== null ? { idempotencyKey: row.idempotency_key } : {}),
    ...(row.result_json !== null ? { result: JSON.parse(row.result_json) as ResearchReport } : {}),
    ...(row.error !== null ? { error: row.error } : {}),
    createdAt: row.created_at,
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    ...(row.finished_at !== null ? { finishedAt: row.finished_at } : {}),
    ...(row.heartbeat_at !== null ? { heartbeatAt: row.heartbeat_at } : {}),
  }
}

export function openJobDb(dbPath: string): JobDb {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })

  const db = new Database(dbPath, { create: true })
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec(`
    CREATE TABLE IF NOT EXISTS job (
      job_id      TEXT PRIMARY KEY,
      status      TEXT NOT NULL,
      query       TEXT NOT NULL,
      depth       TEXT NOT NULL,
      context     TEXT,
      idempotency_key TEXT,
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
  // prepared statement against that schema throws at prepare time. Same pattern as the
  // heartbeat_at migration below it (itself copied from audio-gateway's error_text).
  const cols = db.query('PRAGMA table_info(job)').all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'context')) {
    db.exec('ALTER TABLE job ADD COLUMN context TEXT')
  }
  if (!cols.some((c) => c.name === 'heartbeat_at')) {
    db.exec('ALTER TABLE job ADD COLUMN heartbeat_at INTEGER')
  }
  if (!cols.some((c) => c.name === 'idempotency_key')) {
    db.exec('ALTER TABLE job ADD COLUMN idempotency_key TEXT')
  }

  // Partial — only rows that actually carry a key are indexed. Must run AFTER the migration
  // above, or opening a pre-idempotency file would fail on the missing column.
  db.exec(
    'CREATE INDEX IF NOT EXISTS job_idempotency_key ON job (idempotency_key) WHERE idempotency_key IS NOT NULL',
  )

  const putStmt = db.prepare(`
    INSERT INTO job (job_id, status, query, depth, context, idempotency_key, result_json, error, created_at, started_at, finished_at, heartbeat_at)
    VALUES ($jobId, $status, $query, $depth, $context, $idempotencyKey, $resultJson, $error, $createdAt, $startedAt, $finishedAt, $heartbeatAt)
    ON CONFLICT(job_id) DO UPDATE SET
      status = excluded.status,
      query = excluded.query,
      depth = excluded.depth,
      context = excluded.context,
      idempotency_key = excluded.idempotency_key,
      result_json = excluded.result_json,
      error = excluded.error,
      created_at = excluded.created_at,
      started_at = excluded.started_at,
      finished_at = excluded.finished_at
      -- heartbeat_at deliberately NOT in this SET list: it is owned exclusively by
      -- touchHeartbeat, so a status-transition write from another code path (or an unrelated
      -- Job snapshot with a stale in-memory heartbeatAt) can never clobber a live heartbeat.
  `)

  const touchHeartbeatStmt = db.prepare(
    'UPDATE job SET heartbeat_at = $heartbeatAt WHERE job_id = $jobId',
  )

  // Single-row read by primary key. Exists for the one case the in-memory map cannot answer:
  // a job owned by the OTHER replica during a rolling deploy, whose row this process only ever
  // saw once (at boot) while the owner keeps writing to it. See job-store.ts's `getJob`.
  const getStmt = db.prepare('SELECT * FROM job WHERE job_id = ?')

  const deleteFinishedStmt = db.prepare(`
    DELETE FROM job
    WHERE status IN ('done', 'error', 'cancelled')
      AND COALESCE(finished_at, created_at) < $cutoff
  `)

  // A queued/running job never expires (it has not finished yet), so it is always a valid
  // dedupe hit; a terminal one only while its finish time is inside the retention window. A
  // cancelled job is never one: cancelling says "this job is void", and the natural next move —
  // fix the input, resubmit under the same key — must start a fresh job, not hand the corpse back.
  const findByIdempotencyStmt = db.prepare(`
    SELECT * FROM job
    WHERE idempotency_key = $key
      AND status != 'cancelled'
      AND (status IN ('queued', 'running') OR COALESCE(finished_at, created_at) >= $cutoff)
    ORDER BY created_at DESC
    LIMIT 1
  `)

  const reapStmt = db.prepare(`
    UPDATE job SET status = 'error', error = $error, finished_at = $finishedAt
    WHERE status IN ('queued', 'running')
      AND (heartbeat_at IS NULL OR heartbeat_at < $staleBefore)
  `)

  return {
    put(job: JobRecord): void {
      putStmt.run({
        $jobId: job.jobId,
        $status: job.status,
        $query: job.query,
        $depth: job.depth,
        $context: job.context ?? null,
        $idempotencyKey: job.idempotencyKey ?? null,
        $resultJson: job.result ? JSON.stringify(job.result) : null,
        $error: job.error ?? null,
        $createdAt: job.createdAt,
        $startedAt: job.startedAt ?? null,
        $finishedAt: job.finishedAt ?? null,
        // Only takes effect on the initial INSERT (see the ON CONFLICT comment above).
        $heartbeatAt: job.heartbeatAt ?? null,
      })
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

    touchHeartbeat(jobId: string, heartbeatAt: number): void {
      touchHeartbeatStmt.run({ $jobId: jobId, $heartbeatAt: heartbeatAt })
    },

    reapInterrupted(message: string, staleBefore: number): JobRecord[] {
      const stale = (
        db
          .query(
            "SELECT * FROM job WHERE status IN ('queued', 'running') AND (heartbeat_at IS NULL OR heartbeat_at < ?)",
          )
          .all(staleBefore) as JobRow[]
      ).map(toRecord)
      if (stale.length === 0) return []

      const finishedAt = Date.now()
      reapStmt.run({ $error: message, $finishedAt: finishedAt, $staleBefore: staleBefore })
      return stale.map((job) => ({ ...job, status: 'error' as JobStatus, error: message, finishedAt }))
    },

    deleteFinishedBefore(cutoff: number): void {
      deleteFinishedStmt.run({ $cutoff: cutoff })
    },

    findByIdempotencyKey(key: string, cutoff: number): JobRecord | undefined {
      const row = findByIdempotencyStmt.get({ $key: key, $cutoff: cutoff }) as JobRow | null
      return row === null ? undefined : toRecord(row)
    },

    close(): void {
      db.close()
    },
  }
}
