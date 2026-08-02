// Benchmark harness — repeated runs over a fixed query set against a RUNNING gateway.
//
// Why this exists: the search-backend tuning in 2026-08 was done with single runs per
// configuration, and that turned out to be indefensible. Two `deep` runs of the SAME query
// on the SAME configuration differed by 66 vs 158 citations and 671s vs 1137s. At that
// spread, a one-shot A/B cannot tell a real improvement from noise, and every number in
// HANDOVER's tuning tables was one sample. This runs the matrix properly and reports
// spread, so a config change can be argued from a distribution instead of an anecdote.
//
// It drives the HTTP API rather than importing the agent, so it measures the deployed
// thing (including queueing and the real network) and needs no provider secrets of its
// own — just the gateway's bearer.
//
// Runs are SERIAL by default and that is deliberate: wall-clock is one of the metrics, and
// concurrent jobs contend for RESEARCH_MAX_CONCURRENCY, the worker semaphore and the
// shared Perplexity rate limit. `--concurrency` exists for cost-only sweeps where wall
// time is not being measured; it prints a warning.
//
//   bun run scripts/bench.ts --depth standard --reps 3
//   bun run scripts/bench.ts --depth quick --reps 5 --base http://localhost:7780
//   bun run scripts/bench.ts --depth deep --reps 2 --queries 2 --out /tmp/deep.jsonl
//
// API_SECRET must be in the environment (the gateway's bearer):
//   API_SECRET=$(secrets-run read op://vps/research-gateway/API_SECRET) bun run scripts/bench.ts ...

import type { Depth } from '../src/agent/schema.js'

// Fixed and deliberately heterogeneous: a config that only looks good on one shape of
// question is not an improvement. Ordered so `--queries N` takes a spread, not a run of
// near-duplicates.
//
//   1. opinion/long-tail — no authoritative source, rewards broad discovery
//   2. version/API fact  — answerable from a registry, should barely search at all
//   3. comparison        — needs several independent sources reconciled
//   4. recent event      — rewards freshness, punishes stale indexes
//   5. narrow technical  — one right answer, buried in docs
const QUERIES = [
  'What do engineering teams report about running Bun in production in 2026 — what problems do they hit, and how does it compare to Node.js for long-running HTTP services?',
  'What is the current stable version of the Elysia web framework and what changed in its most recent minor release?',
  'Compare Postgres logical replication with Debezium for change data capture — operational tradeoffs, failure modes, and when each is the wrong choice.',
  'What changed in the TypeScript 6.0 release and what is the migration path from 5.x?',
  'How does Cloudflare Tunnel handle origin certificate rotation, and what breaks if the tunnel token is rotated while connections are live?',
]

interface Args {
  base: string
  depth: Depth
  reps: number
  queries: number
  concurrency: number
  out: string | null
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  return {
    base: get('--base') ?? 'https://research.jkrumm.com',
    depth: (get('--depth') as Depth | undefined) ?? 'standard',
    reps: Number(get('--reps') ?? 3),
    queries: Number(get('--queries') ?? QUERIES.length),
    concurrency: Number(get('--concurrency') ?? 1),
    out: get('--out') ?? null,
  }
}

interface RunRow {
  query: number
  rep: number
  depth: Depth
  ok: boolean
  error?: string
  wallMs: number
  clientWallMs: number
  totalUsd: number | null
  llmUsd: number | null
  searchUsd: number
  searchCalls: number
  tavilyCredits: number
  citations: number
  sources: number
  pagesRetrieved: number
  pagesFailed: number
  citationsDropped: number
  confidenceCapped: number
  status: string
}

async function runOne(args: Args, secret: string, queryIndex: number, rep: number): Promise<RunRow> {
  const query = QUERIES[queryIndex]!
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` }
  const started = Date.now()

  const base: RunRow = {
    query: queryIndex,
    rep,
    depth: args.depth,
    ok: false,
    wallMs: 0,
    clientWallMs: 0,
    totalUsd: null,
    llmUsd: null,
    searchUsd: 0,
    searchCalls: 0,
    tavilyCredits: 0,
    citations: 0,
    sources: 0,
    pagesRetrieved: 0,
    pagesFailed: 0,
    citationsDropped: 0,
    confidenceCapped: 0,
    status: 'unknown',
  }

  const submit = await fetch(`${args.base}/research`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, depth: args.depth }),
  })
  if (!submit.ok) {
    return { ...base, error: `submit ${submit.status}: ${(await submit.text()).slice(0, 200)}`, clientWallMs: Date.now() - started }
  }
  const { jobId } = (await submit.json()) as { jobId: string }

  // Poll rather than long-poll: this is a measurement client, and a 5s tick adds at most
  // 5s of quantisation to a job measured in minutes. `wallMs` from the server is the
  // authoritative duration; `clientWallMs` includes queueing and is reported alongside so
  // a queued run is visible rather than silently inflating the server figure.
  for (;;) {
    await new Promise((r) => setTimeout(r, 5_000))
    const poll = await fetch(`${args.base}/research/${jobId}`, { headers })
    if (!poll.ok) {
      return { ...base, error: `poll ${poll.status}`, clientWallMs: Date.now() - started }
    }
    const job = (await poll.json()) as {
      status: string
      error?: string
      result?: {
        citations: unknown[]
        sources: unknown[]
        status: string
        grounding: { pagesRetrieved: number; pagesFailed: number; citationsDropped: number; confidenceCapped: number }
        cost?: {
          wallMs: number
          totalUsd: number | null
          llmUsd: number | null
          searchUsd: number
          searchCalls: number
          tavilyCredits: number
        }
      }
    }

    if (job.status === 'error') {
      return { ...base, error: job.error ?? 'job error', clientWallMs: Date.now() - started }
    }
    if (job.status !== 'done' || !job.result) continue

    const r = job.result
    // `cost` is optional here only to stay readable against a gateway older than the
    // commit that added it — against a current one it is always present.
    const c = r.cost
    return {
      ...base,
      ok: true,
      clientWallMs: Date.now() - started,
      wallMs: c?.wallMs ?? Date.now() - started,
      totalUsd: c?.totalUsd ?? null,
      llmUsd: c?.llmUsd ?? null,
      searchUsd: c?.searchUsd ?? 0,
      searchCalls: c?.searchCalls ?? 0,
      tavilyCredits: c?.tavilyCredits ?? 0,
      citations: r.citations.length,
      sources: r.sources.length,
      pagesRetrieved: r.grounding.pagesRetrieved,
      pagesFailed: r.grounding.pagesFailed,
      citationsDropped: r.grounding.citationsDropped,
      confidenceCapped: r.grounding.confidenceCapped,
      status: r.status,
    }
  }
}

function stats(values: number[]): { n: number; mean: number; sd: number; min: number; max: number; cv: number } {
  const n = values.length
  if (n === 0) return { n: 0, mean: 0, sd: 0, min: 0, max: 0, cv: 0 }
  const mean = values.reduce((a, b) => a + b, 0) / n
  // Sample standard deviation (n-1): these are samples from a noisy process, not a
  // population. With n=2 the population form would understate the spread by ~30%, and
  // understating spread is exactly the error this harness exists to stop making.
  const sd = n > 1 ? Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0
  return { n, mean, sd, min: Math.min(...values), max: Math.max(...values), cv: mean === 0 ? 0 : sd / mean }
}

function fmt(x: number, digits = 2): string {
  return x.toFixed(digits)
}

function summarize(rows: RunRow[]): void {
  const ok = rows.filter((r) => r.ok)
  console.log(`\n=== ${ok.length}/${rows.length} runs completed ===`)
  for (const r of rows.filter((x) => !x.ok)) {
    console.log(`  FAILED q${r.query} rep${r.rep}: ${r.error}`)
  }
  if (ok.length === 0) return

  const metrics: Array<[string, (r: RunRow) => number, number]> = [
    ['wall (s)', (r) => r.wallMs / 1000, 1],
    ['total ($)', (r) => r.totalUsd ?? 0, 4],
    ['search ($)', (r) => r.searchUsd, 4],
    ['searches', (r) => r.searchCalls, 1],
    ['citations', (r) => r.citations, 1],
    ['pages', (r) => r.pagesRetrieved, 1],
    ['pagesFailed', (r) => r.pagesFailed, 1],
  ]

  console.log('\nAcross all runs (cv = sd/mean; >0.3 means the metric is too noisy for n=1 A/B):')
  console.log('  metric        n   mean      sd       cv     min      max')
  for (const [name, pick, digits] of metrics) {
    const s = stats(ok.map(pick))
    console.log(
      `  ${name.padEnd(12)} ${String(s.n).padStart(2)}  ${fmt(s.mean, digits).padStart(8)} ${fmt(s.sd, digits).padStart(8)} ${fmt(s.cv, 2).padStart(6)} ${fmt(s.min, digits).padStart(8)} ${fmt(s.max, digits).padStart(8)}`,
    )
  }

  // Per-query spread matters separately: a metric can look noisy in aggregate purely
  // because the queries differ in difficulty. Only WITHIN-query spread is the noise that
  // invalidates an A/B on a fixed query.
  console.log('\nWithin-query spread (this is the noise floor an A/B must beat):')
  console.log('  query  n   wall cv   cost cv   citations cv')
  const byQuery = new Map<number, RunRow[]>()
  for (const r of ok) byQuery.set(r.query, [...(byQuery.get(r.query) ?? []), r])
  for (const [q, rs] of [...byQuery.entries()].sort((a, b) => a[0] - b[0])) {
    const w = stats(rs.map((r) => r.wallMs))
    const c = stats(rs.map((r) => r.totalUsd ?? 0))
    const cit = stats(rs.map((r) => r.citations))
    console.log(
      `  q${q}     ${String(rs.length).padStart(2)}  ${fmt(w.cv).padStart(7)}  ${fmt(c.cv).padStart(7)}  ${fmt(cit.cv).padStart(11)}`,
    )
  }
}

const args = parseArgs(process.argv)
const secret = process.env['API_SECRET']
if (!secret) {
  console.error('API_SECRET is required (the gateway bearer).')
  process.exit(1)
}
if (args.concurrency > 1) {
  console.warn(
    `[bench] concurrency=${args.concurrency}: wall-clock figures will be contended and are NOT comparable to serial runs.`,
  )
}

const plan: Array<{ q: number; rep: number }> = []
for (let rep = 0; rep < args.reps; rep++) {
  for (let q = 0; q < Math.min(args.queries, QUERIES.length); q++) plan.push({ q, rep })
}

console.log(
  `[bench] ${args.base} depth=${args.depth} queries=${Math.min(args.queries, QUERIES.length)} reps=${args.reps} -> ${plan.length} runs, concurrency=${args.concurrency}`,
)

const rows: RunRow[] = []
let cursor = 0
const workers = Array.from({ length: Math.max(1, args.concurrency) }, async () => {
  for (;;) {
    const idx = cursor++
    const item = plan[idx]
    if (!item) return
    const t0 = Date.now()
    const row = await runOne(args, secret, item.q, item.rep)
    rows.push(row)
    console.log(
      `[${rows.length}/${plan.length}] q${item.q} rep${item.rep} ${row.ok ? 'ok' : 'FAIL'} ` +
        `${fmt((Date.now() - t0) / 1000, 0)}s $${fmt(row.totalUsd ?? 0, 4)} ` +
        `searches=${row.searchCalls} citations=${row.citations} pages=${row.pagesRetrieved}` +
        (row.error ? ` err=${row.error.slice(0, 80)}` : ''),
    )
    if (args.out) await Bun.write(args.out, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  }
})
await Promise.all(workers)

summarize(rows)
if (args.out) console.log(`\nrows -> ${args.out}`)
