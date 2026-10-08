// Shared client plumbing for the two scripts that drive a RUNNING gateway over REST
// (bench.ts, eval.ts). Env-free (the only src/ import is the zod-only schema.ts): the bearer and base
// URL come in as arguments, so both scripts keep owning their own flags and defaults.

import { isTerminalStatus, type Depth, type JobStatus } from '../src/agent/schema.js'

/** `get('--flag')` → the token after the flag, or undefined. */
export function flagGetter(argv: string[]): (flag: string) => string | undefined {
  return (flag) => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
}

export type JobOutcome<R> = { ok: true; result: R } | { ok: false; error: string }

interface JobPoll<R> {
  status: JobStatus
  error?: string
  result?: R
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>

/**
 * Submit one job and poll it to a terminal state. Poll, never long-poll, and with no overall
 * deadline: a job runs as long as it takes (agent-limits), and the tick only quantises the
 * client clock — callers report the server-side wall time. Never throws: a network failure or
 * a non-done terminal status comes back as `{ ok: false, error }`. `fetchFn` / `pollMs` exist
 * for the tests.
 */
export async function runJob<R>(opts: {
  baseUrl: string
  secret: string
  query: string
  depth: Depth
  fetchFn?: FetchFn
  pollMs?: number
}): Promise<JobOutcome<R>> {
  const fetchFn = opts.fetchFn ?? fetch
  const pollMs = opts.pollMs ?? 5_000
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.secret}` }
  try {
    const submit = await fetchFn(`${opts.baseUrl}/research`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query: opts.query, depth: opts.depth }),
    })
    if (!submit.ok) return { ok: false, error: `submit ${submit.status}: ${(await submit.text()).slice(0, 200)}` }
    const { jobId } = (await submit.json()) as { jobId: string }

    for (;;) {
      await new Promise((r) => setTimeout(r, pollMs))
      const poll = await fetchFn(`${opts.baseUrl}/research/${jobId}`, { headers })
      if (!poll.ok) return { ok: false, error: `poll ${poll.status}` }
      const job = (await poll.json()) as JobPoll<R>
      if (!isTerminalStatus(job.status)) continue
      if (job.status === 'done' && job.result) return { ok: true, result: job.result }
      return { ok: false, error: job.error ?? `job ${job.status}` }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Run `task(0..total-1)` across `concurrency` workers; each index is taken exactly once. */
export async function runPool(total: number, concurrency: number, task: (index: number) => Promise<void>): Promise<void> {
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    for (;;) {
      const index = cursor++
      if (index >= total) return
      await task(index)
    }
  })
  await Promise.all(workers)
}
