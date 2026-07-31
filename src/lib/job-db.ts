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
// legitimately queued — deep jobs run ~28 minutes, so with `RESEARCH_MAX_CONCURRENCY=3` a
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
  close(): void
}

interface JobRow {
  job_id: string
  status: string
  query: string
  depth: string
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
      result_json TEXT,
      error       TEXT,
      created_at  INTEGER NOT NULL,
      started_at  INTEGER,
      finished_at INTEGER,
      heartbeat_at INTEGER
    );
  `)

  // Idempotent column migration: a database created by the pre-heartbeat version of this
  // module has no `heartbeat_at` column, and referencing $heartbeatAt in a prepared statement
  // against that schema throws at prepare time. Add it if missing, same pattern as
  // audio-gateway's `error_text` migration.
  const cols = db.query('PRAGMA table_info(job)').all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'heartbeat_at')) {
    db.exec('ALTER TABLE job ADD COLUMN heartbeat_at INTEGER')
  }

  const putStmt = db.prepare(`
    INSERT INTO job (job_id, status, query, depth, result_json, error, created_at, started_at, finished_at, heartbeat_at)
    VALUES ($jobId, $status, $query, $depth, $resultJson, $error, $createdAt, $startedAt, $finishedAt, $heartbeatAt)
    ON CONFLICT(job_id) DO UPDATE SET
      status = excluded.status,
      query = excluded.query,
      depth = excluded.depth,
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

    close(): void {
      db.close()
    },
  }
}
