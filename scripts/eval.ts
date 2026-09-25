// Answer-quality eval over the golden set — one bounded run of fixed questions against a
// RUNNING gateway, scored on whether the report actually contains the right answer.
//
// Why this exists: bench.ts measures cost, citations and pages, and none of that says
// whether the answer was right. Correctness is checkable in code for the questions this
// service is mostly asked (pinned versions, release dates, API facts), so this drives the
// REST door with questions whose answer is deterministic — a regex for the static facts, a
// live registry lookup for the versions that move. It is a regression signal, not a
// distribution: one run answers "did this change break anything", and the caution in
// docs/measurements.md against n=1 A/B applies here too.
//
//   API_SECRET=<bearer> bun scripts/eval.ts
//   API_SECRET=<bearer> bun scripts/eval.ts --base-url http://127.0.0.1:7780 --concurrency 3
//   API_SECRET=<bearer> bun scripts/eval.ts --filter crates --concurrency 1
//
// API_SECRET is the gateway's bearer, as in scripts/bench.ts. RESEARCH_BASE_URL overrides
// the default base URL. Do NOT run the full set against production as part of a change
// review: it costs money and competes with real jobs (docs/architecture-review-2026-09.md § 2b).

import { matchExpect, parseGolden, resolverFor, type GoldenItem } from '../evals/lib.js'
import type { Depth } from '../src/agent/schema.js'

interface Args {
  baseUrl: string
  concurrency: number
  filter: string | null
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  return {
    baseUrl: get('--base-url') ?? process.env['RESEARCH_BASE_URL'] ?? 'http://127.0.0.1:7780',
    concurrency: Number(get('--concurrency') ?? 3),
    filter: get('--filter') ?? null,
  }
}

interface GroundingRow {
  pagesRetrieved: number
  pagesFailed: number
  citationsKept: number
  citationsDropped: number
  confidenceCapped: number
  /** Optional: absent on a gateway older than the commit that added it (c862d5a). */
  citationsDegraded: number | null
}

interface EvalRow {
  index: number
  id: string
  query: string
  depth: Depth
  pass: boolean
  /** The regex text or live value that matched; null when nothing did. */
  matched: string | null
  /** Present for live items; `value` is null when resolution failed. */
  live: { resolver: string; value: string | null } | null
  /** Report status ('ok'/'partial'), or null when the job did not produce one. */
  status: string | null
  grounding: GroundingRow | null
  costUsd: number | null
  wallMs: number | null
  /** Job or resolver failure; a row with an error is not scored. */
  error: string | null
}

interface JobPoll {
  status: string
  error?: string
  result?: {
    report: string
    status: string
    grounding: {
      pagesRetrieved: number
      pagesFailed: number
      citationsKept: number
      citationsDropped: number
      confidenceCapped: number
      citationsDegraded?: number
    }
    cost?: { wallMs: number; totalUsd: number | null }
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function baseRow(index: number, item: GoldenItem): EvalRow {
  return {
    index,
    id: item.id,
    query: item.query,
    depth: item.depth,
    pass: false,
    matched: null,
    live: null,
    status: null,
    grounding: null,
    costUsd: null,
    wallMs: null,
    error: null,
  }
}

async function runOne(args: Args, secret: string, item: GoldenItem, index: number): Promise<EvalRow> {
  const base = baseRow(index, item)
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` }
  const started = Date.now()

  // Resolve the expected value before spending a job on it — if the registry is
  // unreachable the item is an error to report, not a wrong answer to record.
  let liveValue: string | null = null

  if ('live' in item.expect) {
    try {
      const spec = resolverFor(item.expect.live, process.env['GITHUB_TOKEN'])
      const response = await fetch(spec.url, { headers: spec.headers })
      if (!response.ok) throw new Error(`${spec.url} -> HTTP ${response.status}`)
      liveValue = spec.parse(await response.json())
      base.live = { resolver: item.expect.live, value: liveValue }
    } catch (err) {
      base.live = { resolver: item.expect.live, value: null }
      base.error = `resolver ${item.expect.live}: ${message(err)}`
      return base
    }
  }

  const submit = await fetch(`${args.baseUrl}/research`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query: item.query, depth: item.depth }),
  })
  if (!submit.ok) {
    base.error = `submit ${submit.status}: ${(await submit.text()).slice(0, 200)}`
    return base
  }
  const { jobId } = (await submit.json()) as { jobId: string }

  // Poll, never long-poll, and with no overall deadline: a job runs as long as it takes
  // (agent-limits), and the 5s tick only quantises the wall clock, which is reported from
  // the server anyway.
  for (;;) {
    await new Promise((r) => setTimeout(r, 5_000))
    const poll = await fetch(`${args.baseUrl}/research/${jobId}`, { headers })
    if (!poll.ok) {
      base.error = `poll ${poll.status}`
      return base
    }
    const job = (await poll.json()) as JobPoll
    if (job.status === 'error') {
      base.error = job.error ?? 'job error'
      return base
    }
    if (job.status !== 'done' || !job.result) continue

    const result = job.result
    const grounding = result.grounding
    const match = matchExpect(result.report, item.expect, liveValue)
    return {
      ...base,
      pass: match.pass,
      matched: match.matched,
      status: result.status,
      grounding: {
        pagesRetrieved: grounding.pagesRetrieved,
        pagesFailed: grounding.pagesFailed,
        citationsKept: grounding.citationsKept,
        citationsDropped: grounding.citationsDropped,
        confidenceCapped: grounding.confidenceCapped,
        citationsDegraded: typeof grounding.citationsDegraded === 'number' ? grounding.citationsDegraded : null,
      },
      costUsd: result.cost?.totalUsd ?? null,
      wallMs: result.cost?.wallMs ?? Date.now() - started,
    }
  }
}

function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—'
  return String(value).replace(/\|/g, '\\|')
}

function pct(numerator: number, denominator: number): string {
  if (denominator === 0) return 'n/a'
  return `${((numerator / denominator) * 100).toFixed(1)}%`
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? null
}

function gitSha(): string {
  try {
    const proc = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'])
    if (proc.exitCode === 0) {
      const sha = proc.stdout.toString().trim()
      if (sha.length > 0) return sha
    }
  } catch {
    // fall through to the sentinel
  }
  return 'nogit'
}

function printTable(rows: EvalRow[]): void {
  console.log('\n| id | depth | pass | matched | status | cit | drop | cap | degr | $ | wall |')
  console.log('|-|-|-|-|-|-|-|-|-|-|-|')
  for (const row of rows) {
    const g = row.grounding
    console.log(
      `| ${cell(row.id)} | ${cell(row.depth)} | ${row.pass ? 'PASS' : 'FAIL'} | ${cell(row.matched)} | ` +
        `${cell(row.status ?? row.error)} | ${cell(g?.citationsKept)} | ${cell(g?.citationsDropped)} | ` +
        `${cell(g?.confidenceCapped)} | ${cell(g?.citationsDegraded)} | ` +
        `${row.costUsd === null ? '—' : `$${row.costUsd.toFixed(4)}`} | ${row.wallMs === null ? '—' : `${(row.wallMs / 1000).toFixed(0)}s`} |`,
    )
  }
}

const args = parseArgs(process.argv)
const secret = process.env['API_SECRET']
if (!secret) {
  console.error('API_SECRET is required (the gateway bearer).')
  process.exit(1)
}

const goldenPath = `${import.meta.dir}/../evals/golden.jsonl`
const allItems = parseGolden(await Bun.file(goldenPath).text())
const items = allItems.filter((item) => args.filter === null || item.id.includes(args.filter))
if (items.length === 0) {
  console.error(`No golden items match --filter ${JSON.stringify(args.filter)}.`)
  process.exit(1)
}

console.log(
  `[eval] ${args.baseUrl} concurrency=${args.concurrency} items=${items.length}` +
    (args.filter === null ? '' : ` filter=${args.filter}`),
)

const startedAt = new Date()
const rows: EvalRow[] = []
let cursor = 0
const workers = Array.from({ length: Math.max(1, args.concurrency) }, async () => {
  for (;;) {
    const index = cursor++
    const item = items[index]
    if (!item) return
    const row = await runOne(args, secret, item, index)
    rows.push(row)
    const g = row.grounding
    console.log(
      `[${rows.length}/${items.length}] ${row.id} ${row.pass ? 'PASS' : 'FAIL'}` +
        (row.status === null ? '' : ` status=${row.status}`) +
        (row.matched === null ? '' : ` matched=${row.matched}`) +
        (g === null ? '' : ` cit=${g.citationsKept} drop=${g.citationsDropped} cap=${g.confidenceCapped} degr=${g.citationsDegraded ?? 'n/a'}`) +
        (row.costUsd === null ? '' : ` $${row.costUsd.toFixed(4)}`) +
        (row.error === null ? '' : ` err=${row.error.slice(0, 100)}`),
    )
  }
})
await Promise.all(workers)
rows.sort((a, b) => a.index - b.index)

printTable(rows)

const scored = rows.filter((row) => row.error === null)
const passed = scored.filter((row) => row.pass)
const completed = rows.filter((row) => row.status !== null)
const okRuns = completed.filter((row) => row.status === 'ok')
const totalUsd = rows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0)
const p50 = median(completed.map((row) => row.wallMs).filter((wall): wall is number => wall !== null))

console.log(
  `\nAccuracy: ${passed.length}/${scored.length} (${pct(passed.length, scored.length)})   ` +
    `ok-rate: ${okRuns.length}/${completed.length} (${pct(okRuns.length, completed.length)})   ` +
    `total: $${totalUsd.toFixed(4)}   p50 wall: ${p50 === null ? 'n/a' : `${(p50 / 1000).toFixed(0)}s`}`,
)
for (const row of rows.filter((r) => r.error !== null)) console.log(`  ERROR ${row.id}: ${row.error}`)

const finishedAt = new Date()
const result = {
  startedAt: startedAt.toISOString(),
  finishedAt: finishedAt.toISOString(),
  baseUrl: args.baseUrl,
  concurrency: args.concurrency,
  filter: args.filter,
  gitSha: gitSha(),
  summary: {
    total: rows.length,
    scored: scored.length,
    passed: passed.length,
    completed: completed.length,
    okRuns: okRuns.length,
    accuracy: scored.length === 0 ? null : passed.length / scored.length,
    okRate: completed.length === 0 ? null : okRuns.length / completed.length,
    totalUsd,
    p50WallMs: p50,
  },
  rows,
}

const stamp = finishedAt.toISOString().slice(0, 10)
const outPath = `${import.meta.dir}/../evals/results/${stamp}-${gitSha()}.json`
await Bun.write(outPath, JSON.stringify(result, null, 2) + '\n')
console.log(`\nresults -> ${outPath}`)
