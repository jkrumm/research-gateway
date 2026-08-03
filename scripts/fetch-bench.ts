// Fetch-level benchmark — replays a fixed URL corpus through the DEPLOYED fetch chain and
// reports which step terminated each one.
//
// Why this and not scripts/bench.ts: the job benchmark measures research jobs, and fetch
// effects do not survive that measurement. Over 15 runs and 487 fetchPage outcomes,
// `pagesFailed` moved 10.8% → 11.3% with a coefficient of variation of 1.00 — the job-level
// noise floor is wider than any plausible change to one step of the chain. That benchmark
// costs ~90 minutes and ~$1.35 per configuration and STILL cannot decide whether the
// renderer earns its container.
//
// This runs in minutes, is deterministic, spends nothing unless the chain reaches Tavily
// Extract, and answers exactly that question. It replaces the hand-built table in README
// ("What the rendering stage actually recovers") — that table is now generated.
//
//   API_SECRET=$(secrets-run read op://vps/research-gateway/API_SECRET) \
//     bun run scripts/fetch-bench.ts
//   bun run scripts/fetch-bench.ts --base http://localhost:7780 --only surfline,reddit
//   bun run scripts/fetch-bench.ts --out /tmp/fetch-bench.jsonl --concurrency 1
//
// It drives the gateway's `POST /probe/fetch` rather than importing the chain, for the same
// reason bench.ts drives the HTTP API: the sidecar lives on a private compose network and the
// egress IP is the VPS's. A local run would measure a different machine's access to the
// internet, which is not the thing in question.

interface Case {
  /** Short stable key for `--only` and for reading the output table. */
  name: string
  url: string
  /**
   * What this URL is in the corpus to prove. Printed with the results, because a row that
   * says `tavily-extract 0 chars` is a PASS for a dead domain and a FAIL for a surf report.
   */
  expect: string
}

// Chosen so the corpus spans every distinct failure the chain was built for, plus the
// success-shaped failures that have burned this project before. Do not trim it to the ones
// that pass.
const CORPUS: Case[] = [
  // ── JavaScript rendering: the case the sidecar exists for ──
  {
    name: 'techempower',
    url: 'https://www.techempower.com/benchmarks/#section=data-r23',
    expect: 'SPA shell (2,003 B) to a plain fetch — needs rendering or a data-file adapter',
  },
  {
    name: 'web-frameworks',
    url: 'https://web-frameworks-benchmark.netlify.app/result',
    expect: 'client-rendered results table',
  },
  {
    name: 'x-status',
    url: 'https://x.com/elonmusk',
    expect: 'plain fetch gets ~3.7 KB of shell; a real client gets ~287 KB',
  },

  // ── Bot walls: fingerprint-scored, not IP-scored ──
  {
    name: 'surfline',
    url: 'https://www.surfline.com/surf-report/foz-do-lizandro/5842041f4e65fad6a7708bbd?camId=5f735c16aa84e851dd91d5b0&view=table',
    expect: 'Cloudflare 403 "Just a moment..." to plain fetch AND to lightpanda',
  },
  {
    name: 'surfline-api',
    url: 'https://services.surfline.com/kbyg/spots/reports?spotId=5842041f4e65fad6a7708bbd',
    expect: 'the same report as JSON — 8 KB instead of 775 KB, if it can be reached at all',
  },

  // ── Origins that refuse bots, where the alternate origin is the answer ──
  {
    name: 'reddit-thread',
    url: 'https://www.reddit.com/r/selfhosted/comments/1vdepgr/the_3_stages_of_self_hosting/',
    expect: 'site adapter rewrites to old.reddit.com and reads the comment tree, not just the submission',
  },
  {
    name: 'reddit-old',
    url: 'https://old.reddit.com/r/selfhosted/comments/1vdepgr/the_3_stages_of_self_hosting/',
    expect: 'no rewrite needed, comment-tree extractor still applies',
  },

  // ── Success-shaped failures: the reason `chars` alone is not a verdict ──
  {
    name: 'ticketmaster',
    url: 'https://www.ticketmaster.com/',
    expect: 'REAL content (~28 KB) behind a "browser not supported" banner — must NOT be rejected',
  },
  {
    name: 'walmart',
    url: 'https://www.walmart.com/',
    expect: 'short error page (~243 chars) — must BE rejected',
  },

  // ── Walls that are the ceiling, not a gap ──
  {
    // A REAL member-only post. The URL this row used to carry (`medium.com/@ai/some-post`)
    // named no post at all, so it tested a 404 dressed as a paywall — and for months it was
    // the row that justified keeping a third-party renderer, on 5,014 chars of nav chrome.
    //
    // Measured 2026-08-03: step one terminates at ~1,068 chars — the lede, ABOVE the 200-char
    // floor, so nothing in the chain calls it a failure. The full text is ~14,911 chars.
    // That gap IS the row: this is a success-shaped failure the chain does not catch, not a
    // clean miss. Read `chars`, not `via`.
    //
    // If this ever reports 0 chars, the post was deleted — replace the URL rather than
    // reading it as a fixed paywall.
    name: 'medium-paywall',
    url: 'https://medium.com/skillstuff/tailwind-css-vs-css-why-so-many-developers-never-go-back-9db828aac70a',
    expect: 'member-only post — step 1 returns ~1,068 chars of lede and STOPS; full text is ~14,911',
  },
  { name: 'daily-dev-auth', url: 'https://app.daily.dev/', expect: 'auth wall — expected to fail' },

  // ── Definitive negatives: these should fail FAST and cheaply ──
  {
    name: 'hard-404',
    url: 'https://github.com/torvalds/linux/blob/master/this-file-does-not-exist',
    expect: '404 — should short-circuit, not be dragged through every remaining step',
  },
  {
    name: 'dead-domain',
    url: 'https://this-domain-does-not-exist-research-gateway.example',
    expect: 'DNS failure — should short-circuit',
  },
]

interface Args {
  base: string
  only: string[] | null
  out: string | null
  concurrency: number
}

function parseArgs(argv: string[]): Args {
  const args: Args = { base: 'https://research.jkrumm.com', only: null, out: null, concurrency: 2 }
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (value === undefined) throw new Error(`missing value for ${flag}`)
    if (flag === '--base') args.base = value.replace(/\/+$/, '')
    else if (flag === '--only') args.only = value.split(',').map((s) => s.trim()).filter(Boolean)
    else if (flag === '--out') args.out = value
    else if (flag === '--concurrency') args.concurrency = Number(value)
    else throw new Error(`unknown flag ${flag}`)
  }
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1) {
    throw new Error('--concurrency must be a positive integer')
  }
  return args
}

interface Attempt {
  step: string
  ok: boolean
  chars?: number
  error?: string
  ms: number
}

interface ProbeResponse {
  url: string
  fetchUrl: string
  via: string | null
  chars: number
  preview: string | null
  error: string | null
  attempts: Attempt[]
  tavilyCredits: number
  totalMs: number
}

type Row = ProbeResponse & { name: string; expect: string }

async function probe(base: string, secret: string, c: Case): Promise<Row> {
  const res = await fetch(`${base}/probe/fetch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
    body: JSON.stringify({ url: c.url }),
    // Every step of the chain has its own timeout; the sum is the worst case. Generous
    // enough that a slow render is a measurement, not a client-side timeout.
    signal: AbortSignal.timeout(180_000),
  })
  if (!res.ok) {
    throw new Error(`probe failed for ${c.name}: HTTP ${res.status} ${await res.text().catch(() => '')}`)
  }
  const body = (await res.json()) as ProbeResponse
  return { ...body, name: c.name, expect: c.expect }
}

/** Runs `tasks` with at most `limit` in flight, preserving input order in the output. */
async function pooled<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i]!)
    }
  })
  await Promise.all(workers)
  return out
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length)
}

function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const secret = process.env['API_SECRET']
  if (!secret) {
    throw new Error(
      'API_SECRET is required. Run:\n' +
        '  API_SECRET=$(secrets-run read op://vps/research-gateway/API_SECRET) bun run scripts/fetch-bench.ts',
    )
  }

  const cases = args.only ? CORPUS.filter((c) => args.only!.includes(c.name)) : CORPUS
  if (cases.length === 0) throw new Error(`--only matched nothing. Known: ${CORPUS.map((c) => c.name).join(', ')}`)

  return run(args, secret, cases)
}

async function run(args: Args, secret: string, cases: Case[]): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(`fetch-bench → ${args.base}  (${cases.length} urls, concurrency ${args.concurrency})\n`)

  const started = Date.now()
  const rows = await pooled(cases, args.concurrency, (c) =>
    probe(args.base, secret, c).catch(
      (err): Row => ({
        name: c.name,
        expect: c.expect,
        url: c.url,
        fetchUrl: c.url,
        via: null,
        chars: 0,
        preview: null,
        error: `probe error: ${String(err)}`,
        attempts: [],
        tavilyCredits: 0,
        totalMs: 0,
      }),
    ),
  )
  const elapsed = ((Date.now() - started) / 1000).toFixed(1)

  // ── The table this script exists to produce ──
  const w = { name: 12, via: 15, chars: 9, ms: 7 }
  const line = (a: string, b: string, c: string, d: string, e: string) =>
    `${pad(a, w.name)}  ${pad(b, w.via)}  ${pad(c, w.chars)}  ${pad(d, w.ms)}  ${e}`

  // eslint-disable-next-line no-console
  console.log(line('url', 'terminated at', 'chars', 'ms', 'chain'))
  // eslint-disable-next-line no-console
  console.log('-'.repeat(96))
  for (const r of rows) {
    // The whole chain, so a row shows what was TRIED, not only what worked. This is what
    // makes a wasted step visible: a definitive 404 dragged through render + a billed
    // Extract call reads as `readability✗ → lightpanda✗ → tavily-extract✗` at a glance.
    const chain = r.attempts.map((a) => `${a.step}${a.ok ? '✓' : '✗'}`).join(' → ') || '(none)'
    // eslint-disable-next-line no-console
    console.log(line(r.name, r.via ?? 'FAILED', String(r.chars), String(r.totalMs), chain))
  }

  const recovered = rows.filter((r) => r.via !== null)
  const credits = rows.reduce((sum, r) => sum + r.tavilyCredits, 0)
  const byStep = new Map<string, number>()
  for (const r of recovered) byStep.set(r.via!, (byStep.get(r.via!) ?? 0) + 1)

  // eslint-disable-next-line no-console
  console.log(
    `\n${recovered.length}/${rows.length} recovered in ${elapsed}s · ${credits} Tavily credits · ` +
      ([...byStep.entries()].map(([s, n]) => `${s} ${n}`).join(', ') || 'nothing recovered'),
  )

  // ── Detail, because `chars` is not a verdict ──
  // Every row that failed, and every row whose preview needs a human eye to separate real
  // content from a success-shaped failure.
  // eslint-disable-next-line no-console
  console.log('\n--- detail ---')
  for (const r of rows) {
    // eslint-disable-next-line no-console
    console.log(`\n[${r.name}] ${r.url}`)
    // eslint-disable-next-line no-console
    console.log(`  expect: ${r.expect}`)
    if (r.fetchUrl !== r.url) {
      // eslint-disable-next-line no-console
      console.log(`  dialled: ${r.fetchUrl}`)
    }
    for (const a of r.attempts) {
      // eslint-disable-next-line no-console
      console.log(`  ${a.ok ? 'OK  ' : 'MISS'} ${pad(a.step, 15)} ${pad(String(a.chars ?? ''), 8)} ${a.ms}ms ${a.error ?? ''}`)
    }
    if (r.error) {
      // eslint-disable-next-line no-console
      console.log(`  error: ${r.error}`)
    }
    if (r.preview) {
      // eslint-disable-next-line no-console
      console.log(`  preview: ${r.preview.replace(/\s+/g, ' ').slice(0, 200)}`)
    }
  }

  if (args.out) {
    await Bun.write(args.out, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
    // eslint-disable-next-line no-console
    console.log(`\nwrote ${rows.length} rows to ${args.out}`)
  }
}

await main()
