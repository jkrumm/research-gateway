// Per-job single-flight and memory for fetchPage. Env-free, so it is unit-tested.
//
// Workers run in parallel and each has its own `fetched` set, so before this existed a job
// walked the same URL once per worker: 1,037 repeated (job, url) pairs against 6,204 unique in
// the 2026-09-23..10-08 audit, one URL 11 times in 7s, one blocked thread 11 times. The
// fetch chain is expensive (origin, render, Tavily, human solve, Wayback) and a block or a 404
// does not change within a job.
//
// Rules: concurrent callers share ONE chain run. A settled outcome that cannot change within
// the job (a page was read, the origin answered 404/410, or the chain saw a block) is replayed
// to later callers. A transient failure is dropped on settle so a retry really retries.
// Memory: a remembered page keeps its capped text (<= TEXT_CAP) until run.ts clears the job;
// a deep job holds the pages it read, not more. The first caller's abort signal drives a
// shared run (a job cancel reaches every worker, so that is the same signal in practice).
// Each caller still commits the outcome's staged ledger record into ITS OWN ledger and charges
// ITS OWN page budget — the cache removes network work, never a worker's accounting.

import { urlParts, normalizeUrl, type LedgerSnapshot } from './ledger.js'

export interface FetchOutcome {
  text: string | null
  error: string | null
  /** What the chain recorded for the URL, committed per caller (fetch-guard.ts commitRead). */
  staged: LedgerSnapshot
  /** Asking again within this job cannot change the answer. */
  terminal: boolean
}

export type FlightSource = 'ran' | 'joined' | 'replayed'

// A failed fetch is terminal when the origin answered definitively (404/410, ledger `missing`)
// or the chain classified a block. Everything else (timeout, 5xx, a rate limit) may clear.
export function isTerminalOutcome(args: { text: string | null; staged: LedgerSnapshot; blocked: boolean }): boolean {
  return args.text !== null || args.blocked || args.staged.missing.length > 0
}

// What a worker sees on a 404/410: an instruction, not a bare status, because the bare 404
// invites the next guessed URL (11% of audited fetches were `missing`).
export function missingHint(url: string, outcome: Pick<FetchOutcome, 'text' | 'staged'>): string | null {
  if (outcome.text !== null || outcome.staged.missing.length === 0) return null
  const host = urlParts(url)?.host
  const where = host ? `on ${host}` : 'for it'
  return `This URL does not exist (${outcome.staged.missing[0]?.reason ?? 'HTTP 404'}). Do not guess URLs: searchWeb for the page ${where} and fetch a URL a search result returned, or follow a link from a page you already read.`
}

// Bounds the registry when jobs never call clear() (scripts, a crashed job). Oldest job first.
const MAX_TRACKED_JOBS = 64

export interface FlightRegistry {
  /** `variant` names a differently-shaped read of the same URL (fetchPage's `lines` filter): it
   * gets its own flight, so a filtered outcome is never replayed to an unfiltered caller. */
  run(jobId: string, url: string, exec: () => Promise<FetchOutcome>, variant?: string): Promise<{ outcome: FetchOutcome; source: FlightSource }>
  /** Drop a finished job's remembered pages. */
  clear(jobId: string): void
}

export function createFlightRegistry(): FlightRegistry {
  const jobs = new Map<string, Map<string, { promise: Promise<FetchOutcome>; settled: boolean }>>()

  return {
    async run(jobId, url, exec, variant = '') {
      let flights = jobs.get(jobId)
      if (!flights) {
        flights = new Map()
        jobs.set(jobId, flights)
        if (jobs.size > MAX_TRACKED_JOBS) {
          const oldest = jobs.keys().next().value
          if (oldest !== undefined) jobs.delete(oldest)
        }
      }

      const key = variant ? `${normalizeUrl(url)}\n${variant}` : normalizeUrl(url)
      const existing = flights.get(key)
      if (existing) {
        const source = existing.settled ? 'replayed' : 'joined'
        return { outcome: await existing.promise, source }
      }

      const entry: { promise: Promise<FetchOutcome>; settled: boolean } = {
        settled: false,
        promise: exec().then(
          (outcome) => {
            entry.settled = true
            if (!outcome.terminal) flights.delete(key)
            return outcome
          },
          (err: unknown) => {
            flights.delete(key)
            throw err
          },
        ),
      }
      flights.set(key, entry)
      return { outcome: await entry.promise, source: 'ran' }
    },
    clear(jobId) {
      jobs.delete(jobId)
    },
  }
}
