# research-gateway

One research brain, hosted on the VPS, callable over a typed HTTP contract by every client on
the tailnet (Claude Code, Hermes, any tailnet machine) — it is **Tailscale-only**, not exposed to
the public internet. A lead model decomposes the query into independent sub-questions, a fan-out
of **parallel workers** researches them (web search + page fetch + curated library docs) and
returns a compact digest each, and the lead synthesizes one cited report from the digests.

Consolidates and replaces the sideclaw `/research` MCP tool, with provider keys centralized
server-side. See [`PRD.md`](./PRD.md) for the full rationale and decisions.

## Stack

- **Elysia + Bun**, `@elysiajs/openapi` typed contract, bearer `authGuard` (argo patterns).
- **Vercel AI SDK v6** (`ai@6`) — `generateText` tool loops using the **done-tool pattern** (a
  terminal tool with no `execute`, whose input is the structured result: `submit_plan`,
  `submit_digest`, `submit_report`). `prepareStep` forces the done-tool in-loop before any
  ceiling is hit, so a run always banks its result instead of being cut off empty-handed.
- **LLM:** IU unified endpoint via `@ai-sdk/openai-compatible`. Lead (plan + synthesis):
  DeepSeek-V4-Pro. Workers (fan-out): DeepSeek-V4-Flash.
- **Tools:** two kinds, and the split is the point.
  - *Source-of-truth lookups* — `packageInfo` (npm/PyPI registry: exact version, dist-tags,
    deps, deprecation), `githubFile` (a repo file verbatim), `githubRepo` (release, archived,
    last push), `findPackages` (discovery ranked by npm score / stars), `libraryDocs`
    (Context7, when `CONTEXT7_API_KEY` is set). These answer a question exactly instead of
    approximately, and workers are told to reach for them first.
  - *Open-web research* — `searchWeb` (Perplexity Sonar over the IU endpoint by default;
    Tavily as the per-call fallback), plus `fetchPage`, for everything the lookups cannot
    answer. See [Web search backend](#web-search-backend) and [Fetching pages](#fetching-pages).
- **Grounding:** a retrieval ledger records what each tool actually returned — `retrieved`
  (full text), `snippet` (search result only), `failed` (fetch attempted and lost). Findings
  and citations are gated against it in code at both the worker and job boundary, so a page
  the run could not fetch can never back a claim. See [Grounding](#grounding).

## Contract

| Endpoint | Auth | Body / Params | Returns |
|-|-|-|-|
| `GET /` | public | — | discovery (links to `/openapi`) |
| `GET /health` | public | — | `{ status: "ok" }` |
| `POST /research` | bearer | `{ query, depth? }` (`depth`: `quick \| standard \| deep`) | `{ jobId, status }` (async) |
| `GET /research/:jobId` | bearer | — | `{ status, result?, error? }` |

`result` shape: `{ report, citations: [{ claim, url, confidence }], sources, unverified,
status, warnings, grounding, cost }` — `report` is the narrative cited answer, `citations`
ties claims to URLs, `sources` is the pages actually read, `unverified` is what could not be
checked, and `status` / `grounding` are the code-counted evidence accounting.

`cost` is what this one run actually spent: `{ wallMs, totalUsd, llmUsd, searchUsd,
searchCalls, tavilyCredits }`. `searchUsd` is Perplexity's own per-call figure, `llmUsd` is
computed from the local rate table (null if the configured model has no entry), and
`tavilyCredits` is left unpriced — no verified USD-per-credit rate exists. It is read from
the same per-job meters that feed argo, so the result and the dashboard report one number
rather than two accountings that can drift.

Runs are **async**: submit returns a `jobId` immediately; poll `GET /research/:jobId` until
`status` is `done` (agentic runs take tens of seconds to minutes). A global concurrency cap
(`RESEARCH_MAX_CONCURRENCY`) protects the single IU backend.

## Grounding

A model must never be able to assert that its own output was verified. It isn't asked to:
`SubmittedReport` (what the synthesis model fills in) and `ResearchReport` (what the caller
gets) are different types, and everything in the gap is counted in code.

The retrieval ledger (`src/agent/ledger.ts`) records what each tool actually returned:

| Tier | Meaning | Can back a citation? |
|-|-|-|
| `retrieved` | full page/file/registry response was obtained | yes, up to `high` confidence |
| `snippet` | URL appeared in a search result with content, never read | yes, capped at `medium` |
| `failed` | a fetch was attempted and lost (rate limit, error, refusal) | **no** |
| `unseen` | no tool in this run ever returned this URL | **no** |

Retrieval sets the confidence **ceiling**; the model sets the value beneath it (a `low` on a
fully-read page is information and is kept). Gating runs at two boundaries:

- **worker** — a finding citing a page that worker never retrieved is stripped before the
  digest reaches the synthesis prompt, so the invented claim never reaches the report *prose*
  either. A digest that loses every finding gets its summary marked unverified.
- **job** — the merged ledger gates the synthesized citations, `sources` becomes the pages
  genuinely read, and dropped claims are restated in `unverified`.

A URL in `unverified` is structurally ineligible as a `citations[].url`, so the two can never
contradict each other. When evidence was lost the report comes back `status: "partial"` with a
banner prepended to the markdown — text-only MCP clients read the prose and nothing else.

Regression-tested in `src/agent/ground.test.ts` against the run that motivated it
([#1](https://github.com/jkrumm/research-gateway/issues/1)).

## Local development

```bash
bun install
bun run dev        # wraps `secrets-run` (drop-in op shim) to inject secrets from .env.local.tpl, then bun --hot
```

`bun run dev` needs the 1Password CLI (`op`, account `tkrumm`).

```bash
bun run typecheck  # tsc --noEmit (strict)
bun test           # pure-function tests; needs no secrets
```

## Environment

| Var | Required | Notes |
|-|-|-|
| `PORT` | no (7780) | listen port |
| `API_SECRET` | yes | the gateway's own bearer token |
| `IU_BASE_URL` / `IU_API_KEY` | yes | IU unified endpoint |
| `IU_LEAD_MODEL` | no (`DeepSeek-V4-Pro`) | plans + synthesizes |
| `IU_WORKER_MODEL` | no (`DeepSeek-V4-Flash`) | the parallel fan-out |
| `SEARCH_PROVIDER` | no (`sonar`) | `sonar` \| `tavily` — which backend `searchWeb` uses. See [Web search backend](#web-search-backend) |
| `SONAR_MODEL` | no (`sonar`) | pinned; not a menu — see the note in `env.ts` before changing it |
| `TAVILY_API_KEY` | yes | required even on `sonar`: it is the Extract fallback inside `fetchPage` and the per-call search fallback. Credits are hard-limited |
| `JINA_ENABLED` | no (off) | turns on the JavaScript-rendering step in `fetchPage`. **This is the switch, not the key** — it makes fetched URLs visible to a third party |
| `JINA_API_KEY` | no | rate-limit lever only: anonymous is 20 RPM, a key raises it to 500. A key on an unfunded account returns 402 on every request, so the gateway retries anonymously and logs it |
| `CONTEXT7_API_KEY` | no | enables the `libraryDocs` tool when set. Free, and the best source for library questions |
| `GITHUB_TOKEN` | no | the `githubFile`/`githubRepo`/`findPackages` tools work without it, but anonymous GitHub is **60 req/h per IP** shared across all jobs; a no-scope token raises it to 5000/h |
| `ARGO_USAGE_URL` / `ARGO_API_SECRET` | no | telemetry → argo `POST /usage/records`; no-op if unset |
| `RESEARCH_MAX_CONCURRENCY` | no (3) | concurrent *jobs* |
| `WORKER_MAX_CONCURRENCY` | no (8) | concurrent *workers within one job* |

## Web search backend

`searchWeb` runs on **Perplexity Sonar over the same IU endpoint as the LLMs** by default,
with Tavily as a per-call fallback. Set `SEARCH_PROVIDER=tavily` to take Perplexity out of the
loop entirely.

Why Sonar is the default (all figures measured against the live endpoint, 2026-08-02):

| | Sonar | Tavily (`basic`) |
|-|-|-|
| Cost per search | $0.005 (`low`, what we send) | ~1 credit ($0.005–0.008) |
| Sources available | 17–20, trimmed per depth | 5 |
| Publication dates | on every result | none |
| Latency | ~1.7–2.3s | ~1.9s |
| Billed to | the IU work key | the personal Tavily plan |

**Two settings are pinned against measurement, not intuition** — both live-probed 2026-08-02:

- **`search_context_size` is `low` at every depth.** Across two queries at all three tiers the
  result *count* was identical (17/17/17, 20/20/20) and the URL set identical to within one
  hit. The higher tiers buy longer snippets (2613 → 3555 chars), and snippets are triage only
  — the ledger caps a snippet-backed claim at `medium` no matter what. Paying 2.4x for text
  that may not serve as evidence is waste.
- **Hits are trimmed per depth** (`maxSearchResults`: quick 5, standard 12, deep 20). This
  dial costs nothing on the search side — the per-request fee is flat — but it drives worker
  tokens and wall-clock, because every extra candidate is a page a worker may fetch. Handing a
  `standard` job all 20 produced a better report (50 citations / 35 pages) at 545s and $0.16;
  trimming to 8 gave 247s and $0.031 but only 15 citations; the shipped 12 gives 213s, $0.080
  and 39 citations — faster than the 8-hit config *and* 2.6x its citations, so it is not a
  midpoint but a better operating point than either. (n=1 per config on one broad query.)

There is also a **hard per-worker search budget** (`maxSearches`: quick 2, standard 4, deep 6),
enforced in the tool rather than requested in the prompt. The worker prompt has long said "1–3
searches should be enough" and "re-searching with reworded queries is the least effective thing
you can do"; a measured deep job issued **74 searches across 11 workers** (~6.7 each), and
search was 65% of that job's $0.57. Prompts do not hold here, the same way citation
instructions did not hold before the retrieval ledger. Exhausting the budget returns the same
tool-visible error shape a failed search returns — behaviour the prompt already teaches a
response to — and cache hits do not count against it.

Two properties of this route are load-bearing and were established by probing, not from docs:

- IU exposes Sonar as `owned_by: "Perplexity direct"` — a **real passthrough**. `citations` and
  `search_results` sit outside the OpenAI-standard `choices` array, and normalizing gateways
  drop them (LiteLLM #5313/#13777, Portkey's strict-compliance mode, API7). Here they survive.
  If that ever changes, `search_results` comes back empty; `sonar-parse.ts` treats an empty
  result set as a failure precisely so the Tavily fallback engages instead of the worker being
  told the web has nothing. A 429 is retried once (honouring `Retry-After`, capped at 5s)
  before falling back — Perplexity is 50 RPM at tier 0 on IU's *shared* account, so a rate
  limit is likely transient and not worth moving spend onto the personal key over.
- `usage.cost` carries Perplexity's own per-call USD, which is why this is the one backend whose
  telemetry can report real money (see below).

**Sonar's synthesized answer is discarded.** It is an answer engine and it does hallucinate
under confidence; letting that prose into a worker's context would launder Perplexity's
assertions into the report attached to URLs we never retrieved. Only the URLs and snippets are
kept, and they enter the ledger at the `snippet` tier like any other search hit — so nothing
Sonar asserts can be cited as verified. `max_tokens` is pinned at 16 (the API's floor; it 400s
below that) to pay for as little discarded generation as possible.

## Measured baseline

`standard`, 15 runs — 5 heterogeneous queries x 3 repetitions via
[`scripts/bench.ts`](./scripts/bench.ts) against the live gateway, 2026-08-02:

| metric | mean | sd | cv | min | max |
|-|-|-|-|-|-|
| wall (s) | 354 | 223 | 0.63 | 131 | 777 |
| total ($) | 0.0891 | 0.0257 | 0.29 | 0.0363 | 0.1212 |
| search ($) | 0.0523 | 0.0186 | 0.36 | 0.0151 | 0.0754 |
| searches | 10.4 | 3.7 | 0.36 | 3 | 15 |
| citations | 38.4 | 16.9 | 0.44 | 14 | 66 |
| pages | 24.7 | 8.0 | 0.32 | 10 | 37 |

**Read the within-query spread, not the table, before believing a config change.** Per query
(n=3): wall cv 0.11–0.77, cost cv 0.08–0.33, citations cv 0.06–0.47. Cost is the trustworthy
metric — a >25% difference is probably real. Citations are usable with care. **Wall-clock is
not usable for config decisions**: one query spanned 206s to 779s on identical configuration.
Several tuning claims in this repo's history were made from single runs and did not survive
being measured properly; that is what the harness exists to prevent.

Three findings that outlast the tuning:

- **Search is 59% of a standard job's cost** ($0.052 of $0.089). LLM is 41%.
- **Tavily is dormant** — 12 credits across all 15 runs, touched by only 5 of them. That is
  the Sonar migration's real result: search left the personal key, and Tavily is back to
  being the Extract fallback it was meant to be.
- **13.4% of page fetches fail** (41% worst case), ~3.9 wasted fetches per run — and each one
  costs a worker step, the resource that actually buys citations. One host dominated: 6 of 13
  unverified entries in a sampled deep run were `www.reddit.com`, which answers a bot with
  HTTP 200 and an 8 KB JavaScript shell. `fetch-url.ts` now fetches those through
  `old.reddit.com` (267 KB of real HTML for the same thread) while the ledger keeps the
  original URL, so citations still ground. The remaining failures are genuine — dead domains,
  404s, paywalls. A 15-run re-measurement after the fix: fetch failure rate 13.4% → 10.8%,
  **Tavily credits 12 → 7 across the whole matrix** (the predicted mechanism — no more
  Extract calls wasted on shells), cost unchanged, and no resolvable change in citations.

## Fetching pages

`fetchPage` walks a chain and stops at the first step that yields real text:

| Step | Handles | Notes |
|-|-|-|
| 1. `@mozilla/readability` | ordinary article pages | serves the large majority |
| 2. site adapter | pages the generic path structurally cannot read | `site-adapters.ts`; Reddit today |
| 3. lightpanda sidecar | pages whose text is not in the HTML at all | self-hosted browser; on when `LIGHTPANDA_URL` is set |
| 4. Jina Reader | same, via a third party | rollback for step 3; `JINA_ENABLED` |
| 5. Tavily Extract | static pages Readability could not parse | costs a credit |

The ordering is the point. A site adapter runs first because it is deterministic and free.
Rendering sits ahead of Tavily because it handles the one failure Tavily cannot — text that was
never sent — while Tavily remains better for a page that *is* static but awkwardly structured.

### Rendering JavaScript

Step 3 runs [lightpanda](https://github.com/lightpanda-io/browser) 0.3.6 in a sidecar container
(`lightpanda/`), reached over a private Docker network. On the page that motivated this — 
`techempower.com/benchmarks`, which serves a 2,003-byte shell to a plain fetch — it returns
**4,626 chars where Jina returns 1,030**, and it does so without showing a third party which
URLs this service reads and without a per-minute quota. Jina stays wired behind it as a
one-env-var rollback.

It is a **separate container**, and that is the measured part. Peak RSS is 100–205 MB per
render, and **479 MB** on a real page (`bun.com/docs`) without a heap cap. The gateway runs at
~151 MiB under a 512 MiB limit, so one uncapped render inside it is an OOM kill of the service
— which, with the job store it has, takes every in-flight research job with it. In its own
cgroup the same event costs one fetch, which falls through to Tavily. (The binary is also
glibc-linked and cannot execute on the gateway's alpine base at all.) Sizing: `mem_limit: 768m`
against 3 concurrent renders × 205 MB + ~50 MB of wrapper.

`--v8-max-heap-mb 64` is the flag that makes that sizing hold. Measured across 8 real pages at
32 / 64 / uncapped:

| cap | content vs uncapped | worst RSS | worst wall |
|-|-|-|-|
| 32 | **lossy** — 2,517 chars where uncapped gives 4,627 | 90 MB | 5.4s |
| 64 | byte-identical on all 8 | 205 MB | 9.3s |
| none | — | 479 MB | 32.2s |

Capping at 32 would have silently dropped 45% of the techempower page while landing well above
the 200-char floor, so nothing downstream would have noticed. 64 costs nothing and buys a 2.3×
memory bound and a 3.5× speedup, because V8 spends the difference growing a heap nothing reads.

Concurrency is bounded **in the sidecar**, not the gateway: the sidecar owns the memory budget,
and the gateway has 8 workers × 3 jobs with no single place that could enforce it. A request
that waits more than 20s for a slot is failed fast — the fallback costs a Tavily credit and
answers in ~2s, and the scarce resource on the gateway side is the worker step, not the credit.

### Success-shaped failures

Every renderer in this chain reports failure by not failing, and each shape had to be found by
running it:

| Source | What it does |
|-|-|
| Reddit | HTTP 200 with an 8 KB JavaScript shell |
| Jina | HTTP 200 with `Warning: Target URL returned error 403` in the body |
| lightpanda | **exit 0** on a dead domain, with a synthetic `# Navigation failed` markdown page as the content, and `http_status: 0` |
| lightpanda | **exit 0** on HTTP 404 |
| lightpanda | uncaught page-JS exceptions written to **stdout**, after the JSON — `JSON.parse` of the stream throws `Extra data` (deterministic on techempower) |

Taking any of them at face value files un-retrieved text as page content and lets a citation
rest on it. All are detected and treated as errors; the rules are unit-tested in
`lightpanda/parse.test.ts` and `src/agent/lightpanda.test.ts` against the exact shapes measured.

One more, from Bun rather than the browser: `proc.killed` is **true after a clean `exit 0`**,
not only after a timeout kill (Bun 1.3.14). Gating the timeout branch on it turned every
successful render into "render timed out". `proc.signalCode` is the discriminator that holds.

### What the rendering stage actually recovers

Measured against the real failure set — the URLs that were unverifiable across the 45
benchmark runs — by replaying each through the deployed chain (2026-08-02):

| URL | raw bytes | rendered chars | |
|-|-|-|-|
| `techempower.com/benchmarks` | 2,003 | 4,626 | recovered |
| `web-frameworks-benchmark.netlify.app` | 3,326 | 28,960 | recovered |
| `x.com/…/status/…` | 4,285 | 5,497 | recovered |
| `app.daily.dev/posts/…` | 169 | — | auth wall |
| `medium.com/…` | 5,784 | — | paywall |
| `justdigitaldrafts.com/…` | 87 | — | dead |
| `devstract.site/…` | 0 | — | DNS dead |

**3 of 7 recovered.** The four that remain fail on authentication, a paywall and two dead
domains — none of which any renderer fixes. That is the ceiling, not a shortfall.

This is deliberately a *fetch-level* measurement rather than another job-level A/B. The 45
runs established that fetch-stage effects land below the job-level resolution floor
(within-query citation cv 0.09–0.43), so a 15-run comparison could not have resolved this
either way — while replaying the actual failing URLs answers it directly, in minutes.

### What this harness can and cannot resolve

At 3 repetitions per query, the resolvable effect size (2 × standard error, as a share of that
query's mean) is **±7% to ±55% for citations** and **±10% to ±38% for cost**, depending on the
query. So: a 20%+ cost change is measurable, a 5% citation change is not — and a single run
resolves nothing at all. Raise `--reps` before trying to defend a small effect, and expect the
occasional degenerate run (one q0 run did 3 searches and 7 pages where its siblings did 14–15
and 29–51); report those rather than dropping them silently.
- **Pages predict citations far better than searches do.** Pages-read correlates with citations
  at r=+0.78; searches-issued reaches only +0.52, and does so *through* pages (searches→pages
  r=+0.49). Yield decays with volume: 3.8 pages per search on the query that searched least,
  1.7 on the one that searched most.

That last finding argued for a tighter search budget, so it was tested rather than assumed —
and the test refuted it. A 14-run arm at `maxSearches: 3` cut cost 13.6% but cut citations
9.0%, **down on 5 of 5 queries** (individually inside the noise; a 5/5 sign agreement is not).
One query lost 17.9% of its citations while its cost rose 6.3%. So it is a trade, not a
saving — and the wrong way round here, since search bills the IU work key while report quality
is the product. `maxSearches` stayed at 4. Revisit if IU spend ever becomes binding.

## Telemetry

Each job reports spend to argo `POST /usage/records` as `source: "research-gateway"`,
`billing: "iu"` — **up to four records per job**: two LLM records, one per model bucket
(`sub_tool: lead | worker`), since the two run on different models, plus one search record per
backend the job actually used (`sub_tool: sonar` and/or `sub_tool: tavily`). argo upserts on
`(source, source_id, machine)`, so `source_id` is scoped `${jobId}:lead` / `${jobId}:worker` /
`${jobId}:sonar` / `${jobId}:tavily` or a later record would overwrite an earlier one.

The three `cost_source` values are distinct provenances, not decoration:

| Record | `cost_source` | Why |
|-|-|-|
| `lead` / `worker` | `computed` | our rate table, cache-aware — the endpoint bills a cache-read ~30x below a miss and the fan-out sustains a ~60% hit rate, so billing all input at the miss rate overstates cost several-fold |
| `sonar` | `reported` | Perplexity prices the call and returns the USD; pricing it from its token counts would under-report by ~100x, since the cost is almost entirely a per-request search fee |
| `tavily` | `none` | credit count travels in `raw` — no verified USD-per-credit rate exists to convert it honestly |

Search records are debounced per job (a deep run makes 100+ billed calls that all upsert the
same row), so argo sees one trailing cumulative POST rather than a flood. Telemetry failure
never fails a job.

## Deploy

VPS, **Tailscale-only** (grey-cloud DNS-only A record → VPS Tailscale IP, *not* behind the
Cloudflare Tunnel; same pattern as `audio-gateway`) → Traefik, deployed via rollhook. The bearer
token is defense-in-depth on top of the tailnet gate. See [`deploy/DEPLOY.md`](./deploy/DEPLOY.md)
— **start with the gating IU-reachability pre-check.**

## Clients & migration order

1. Build gateway (verify IU reachability from the VPS first).
2. Cut Claude Code `/research` over to curl the gateway (async submit + poll).
3. Wire Hermes research tool → gateway (direct HTTP).
4. Retire the sideclaw `research` tool + handler + skill prompt.

Other chatbots/machines → plain bearer HTTP. An MCP shim is deferred — HTTP is the foundation.
