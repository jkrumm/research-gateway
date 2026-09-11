# research-gateway

One research brain, hosted on the VPS, callable by every client on the tailnet (Claude Code,
Hermes, any tailnet machine) — **Tailscale-only**, not exposed to the public internet. A lead
model decomposes the query into independent sub-questions, a fan-out of **parallel workers**
researches them (web search + page fetch + source-of-truth lookups) and returns a compact
digest each, and the lead synthesizes one cited report from the digests.

It is consumed two ways over the same engine: the **MCP facade at `/mcp`** — the primary path,
what Claude Code's `/research` skill and the `research-gateway` MCP registration in dotfiles
talk to — and plain bearer HTTP for everything else (Hermes, scripts, curl).

| Doc | What it holds |
|-|-|
| [`docs/decisions.md`](./docs/decisions.md) | the settled decisions and what superseded them — framework, models, fan-out, job store |
| [`docs/measurements.md`](./docs/measurements.md) | every number the design rests on, with the run it came from |
| [`docs/field-notes.md`](./docs/field-notes.md) | dated observations from the calling side, the open backlog, and the traps |
| [`docs/hyperdx-dashboard.md`](./docs/hyperdx-dashboard.md) | the span model and the dashboard tiles built on it, with SQL |
| [`deploy/DEPLOY.md`](./deploy/DEPLOY.md) | VPS deploy — the compose file and prod `.env.tpl` live in the **vps** repo |

## Stack

- **Elysia + Bun**, `@elysiajs/openapi` typed contract, bearer `authGuard` (argo patterns;
  constant-time token compare).
- **Vercel AI SDK 7** (`ai@7`) — `generateText` tool loops using the **done-tool pattern** (a
  terminal tool with no `execute`, whose input is the structured result: `submit_plan`,
  `submit_digest`, `submit_report`). `prepareStep` forces the done-tool in-loop before any
  ceiling is hit, so a run always banks its result instead of being cut off empty-handed.
- **LLM:** IU unified endpoint via `@ai-sdk/openai-compatible`. **`gpt-5.6-luna` for both** the
  lead (plan + synthesis) and the workers — measured 3-8x faster to first token than
  DeepSeek-V4-Flash with equal tool-calling reliability, and synthesis is every job's
  wall-clock long pole (`src/env.ts` carries the numbers). Override with `IU_LEAD_MODEL` /
  `IU_WORKER_MODEL`; prod sets neither.
- **Tools:** two kinds, and the split is the point.
  - *Source-of-truth lookups* — `packageInfo` (npm, PyPI, crates.io, the Go module proxy,
    Docker Hub), `githubFile`, `githubRepo`, `findPackages`, `academicSearch` (OpenAlex,
    PubMed), `findVideos` (YouTube via a bundled `yt-dlp`), `libraryDocs` (Context7, when
    `CONTEXT7_API_KEY` is set). These answer a question exactly instead of approximately, and
    workers are told to reach for them first.
  - *Open-web research* — `searchWeb` (Perplexity Sonar over the IU endpoint by default, Tavily
    as the per-call fallback) plus `fetchPage`, for everything the lookups cannot answer.
- **Grounding:** a retrieval ledger records what each tool actually returned; findings and
  citations are gated against it in code at both the worker and job boundary, so a page the
  run could not fetch can never back a claim. See [Grounding](#grounding).
- **Job store:** `bun:sqlite`, status-only durability with heartbeat-based reaping — a `done`
  result survives a redeploy; a job caught mid-run comes back as a terminal `error`.
- **Telemetry:** per-job spend to argo, traces and logs to ClickStack over OTLP — SDK-free.

## Contract

| Endpoint | Auth | Body / Params | Returns |
|-|-|-|-|
| `GET /` | public | — | discovery: the public route list, `/openapi`, the MCP tools |
| `GET /health` | public | — | `{ status: "ok", lastRestartAt, reaped, interrupted }` — only `status` gates anything (Docker healthcheck, rollhook); the counts show an unclean restart to a keyword monitor. See [Restarts](#restarts-and-what-they-cost) |
| `GET /health/render` | public | — | `{ renderer, active, queued, error }` — the sidecar. **Deliberately not part of `/health`**: the renderer is optional, and a broken one must not block deploys of a gateway that is otherwise fine |
| `GET /health/tavily` | public | — | live account state from `api.tavily.com/usage` incl. `overPlan` — crossing into pay-as-you-go was otherwise silent |
| `GET /health/ytdlp` | public | — | `{ ytdlp, version, error }` — `yt-dlp --version` inside the container |
| `GET /openapi`, `/openapi/json` | public | — | Scalar UI, raw spec |
| `POST /research` | bearer | `{ query, depth? }` (`quick \| standard \| deep`) | `{ jobId, status }` (async) |
| `GET /research/:jobId` | bearer | — | `{ status, result?, error? }` — a **poll**: returns current state at once, never blocks |
| `POST /mcp` | bearer | streamable-http (stateless, 2026-07-28) | tools `research`, `job_wait`, `job_status` — same engine. `job_wait` blocks for the whole job, so one call is normally the whole interaction |
| `POST /probe/fetch` | bearer | `{ url }` | one URL through the real fetch chain, no LLM — which step terminated it, chars and ms per step. Drives `scripts/fetch-bench.ts` |

`result` shape: `{ report, citations: [{ claim, url, confidence }], sources, unverified,
status, warnings, grounding, cost }` — `report` is the narrative cited answer, `citations` ties
claims to URLs, `sources` is the pages actually read, `unverified` is what could not be
checked, and `status` / `grounding` are the code-counted evidence accounting. `cost` is what
this one run spent — `{ wallMs, totalUsd, llmUsd, searchUsd, searchCalls, tavilyCredits,
tavilyExtractCalls }` — read from the same per-job meters that feed argo, so the result and the
dashboard report one number. `tavilyCredits` counts **search only**; extraction is billed but
invisible at this call shape ([measurements](./docs/measurements.md#what-tavilycredits-cannot-see)).

Runs are **async**: submit returns a `jobId` immediately (measured p50: quick 38s, standard
111s, deep 366s —
[full distribution](./docs/measurements.md#job-duration-by-depth--the-30-day-span-record)).
`RESEARCH_MAX_CONCURRENCY` caps concurrent jobs and `RESEARCH_MAX_QUEUE` the backlog.

**How you then wait differs per door, and only one of them blocks:**

| Door | Consumer | How to wait |
|-|-|-|
| REST `GET /research/:jobId` | Hermes, sideclaw, anything on the tailnet | **Poll it.** Each call returns the current state immediately. There is no blocking variant — a client that calls it once and stops has only read `queued` |
| MCP `job_wait` | Claude Code | **One call.** It blocks until the job is terminal over a kept-alive stream; call it again only if it returns `stillRunning` |

Do not port the MCP shape onto the REST door. They are different endpoints on purpose: the
REST poll is a cheap read any HTTP client can drive, while the blocking wait needs a stream the
client keeps open.

Submission is admission-controlled (`lib/admission.ts`, one pure decision function), and the
refusal says which of three reasons it was, with a `Retry-After`:

| Reason | Status | Meaning |
|-|-|-|
| `queue_full` | 429 | `running + queued >= RESEARCH_MAX_QUEUE` |
| `memory_pressure` | 503 | the cgroup crossed 85% of the container limit — new work is shed so the jobs already running survive |
| `draining` | 503 | SIGTERM arrived; this process is finishing what it has and starting nothing |

Polling a job already submitted is never refused — only new work is.

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
A job that retrieved **nothing at all** is not a `partial` report: it is a terminal
`status: "error"` whose message names the upstream cause (e.g. an IU-endpoint 403/503), one
retry already spent trying to recover it.
An archived (Wayback) page is `retrieved` but the worker is told to cap it at `medium` and
name the snapshot date.

Regression-tested in `src/agent/ground.test.ts` against the run that motivated it
([#1](https://github.com/jkrumm/research-gateway/issues/1)). **A new lookup is not done until a
live worker's citations survive the ledger** — `academicSearch` shipped working and useless
twice before that rule existed ([measurements](./docs/measurements.md#why-a-new-tool-needs-two-live-runs-not-one)).

## Local development

```bash
bun install
bun run dev        # secrets-run injects .env.local.tpl (op on the MacBook, the sealed cache on the mini), then bun --hot
bun run typecheck  # tsc --noEmit (strict)
bun test           # pure-function tests; needs no secrets
```

Modules that import `env.ts` are not unit-tested — factor pure logic out instead (`ledger`,
`extract`, `archive`, `site-adapters`, `response-kind`, `youtube-captions`, `otel-format`);
do not mock env. `scripts/smoke.ts` runs one `runResearch()` end to end without the server.

## Environment

| Var | Required | Notes |
|-|-|-|
| `PORT` | no (7780) | listen port |
| `API_SECRET` | yes | the gateway's own bearer token |
| `IU_BASE_URL` / `IU_API_KEY` | yes | IU unified endpoint |
| `IU_LEAD_MODEL` / `IU_WORKER_MODEL` | no (`gpt-5.6-luna`) | plan + synthesis / the fan-out. The defaults are the real configuration — prod sets neither |
| `SEARCH_PROVIDER` | no (`sonar`) | `sonar` \| `tavily` — which backend `searchWeb` uses |
| `SONAR_MODEL` | no (`sonar`) | pinned; not a menu — see `env.ts` before changing it |
| `TAVILY_API_KEY` | yes | required even on `sonar`: the Extract fallback inside `fetchPage` and the per-call search fallback |
| `LIGHTPANDA_URL` | no (off) | the JavaScript-rendering sidecar, e.g. `http://research-gateway-lightpanda:7781`. Unset takes the renderer out of the chain — the gateway must run without it |
| `CONTEXT7_API_KEY` | no | enables `libraryDocs` |
| `GITHUB_TOKEN` | no | anonymous GitHub is **60 req/h per IP** shared across all jobs; a no-scope token raises it to 5000/h. Empty is treated as unset |
| `ARGO_USAGE_URL` / `ARGO_API_SECRET` | no | spend telemetry → argo `POST /usage/records`; no-op if either is unset |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | no (off) | ClickStack collector, e.g. `http://clickstack:4319` (the unauthed receiver). Unset keeps `log()` console-only and exports no traces |
| `OTEL_SERVICE_NAME` | no (`research-gateway`) | `service.name` on exported spans and logs |
| `RESEARCH_MAX_CONCURRENCY` / `RESEARCH_MAX_QUEUE` | no (3 / 50) | concurrent *jobs* / accepted backlog |
| `WORKER_MAX_CONCURRENCY` | no (8) | concurrent *workers within one job* |
| `JOB_DB_PATH` | no (`./data/jobs.sqlite`) | `/app/data` in the container, a named volume |
| `SHUTDOWN_DRAIN_MS` | no (1 800 000) | how long SIGTERM waits for RUNNING jobs before force-exiting. **Must stay below the compose `stop_grace_period` (1860s)** or SIGKILL wins and the drain buys nothing. Sized off the 30-day span record, not a guess — see Restarts |
| `YTDLP_PATH` / `YTDLP_MAX_CONCURRENCY` / `YTDLP_TIMEOUT_MS` | no | bundled binary; concurrency 2 because YouTube rate-limits the datacenter IP under burst |

Production values come from `vps/apps/research-gateway/.env.tpl` via `op inject`, which
**resolves `op://` refs inside comments too** — never park an unused ref behind a `#`.

## Web search backend

`searchWeb` runs on **Perplexity Sonar over the IU endpoint** by default: ~$0.005 per call
like Tavily, but 17-20 dated sources instead of 5, billed to the work key. Tavily stays as the
per-call fallback (a 429 is retried once first) and the only Extract path. **Sonar's
synthesized answer is discarded** — only URLs and snippets enter the ledger, at the `snippet`
tier, so nothing Perplexity asserts can be cited as verified; `max_tokens` is pinned at the
API's floor of 16 to pay for as little discarded prose as possible.

Three settings are pinned against measurement: `search_context_size: low` at every depth
(higher tiers return the same URLs with longer snippets, and snippets are triage only), hits
trimmed per depth (`maxSearchResults` 5 / 12 / 20), and a hard per-worker search budget
(`maxSearches` 2 / 4 / 6) enforced in the tool — prompts asking for fewer searches did not
hold, the same way citation instructions did not hold before the ledger. Sonar and Tavily
overlap on only 14 of ~80 domains; a dual-backend merge exists behind `dualSearchFirstRound`
and is **off**, because extra candidates produced no extra reading — the worker's ceiling is
`workerMaxSteps`, not candidate supply. Numbers: [measurements](./docs/measurements.md#web-search-backend--why-sonar-and-the-two-pinned-settings).

## Source-of-truth lookups

| Question | Tool | Reads |
|-|-|-|
| current version, dist-tags, deps, deprecation | `packageInfo` + `npm` / `pypi` / `crates` / `go` | registry.npmjs.org · pypi.org · crates.io · proxy.golang.org |
| which tags an image publishes, and when | `packageInfo` + `docker` | hub.docker.com (deliberately no `latestVersion` — `latest` is a mutable pointer) |
| a repo file, verbatim | `githubFile` | api.github.com |
| is a project alive, latest release, archived | `githubRepo` | api.github.com |
| which library for X | `findPackages` | npm search · GitHub search |
| who published what, what year, how many citations | `academicSearch` + `openalex` / `pubmed` | api.openalex.org · eutils.ncbi.nlm.nih.gov (Semantic Scholar 429s unauthenticated) |
| what a practitioner said, at length, out loud | `findVideos` | `yt-dlp` search, keyless; `fetchPage` on a watch URL returns the transcript |
| current API surface of a library | `libraryDocs` | Context7 |

**Nine tools, not twelve.** Definitions are re-sent every step, every worker, every job against
a `workerMaxSteps` of 5 / 7 / 9, so new *ecosystems* go on existing tools (`packageInfo`,
`academicSearch`) rather than becoming new definitions. Adding a source is cheap; adding a
tool is not. Podcasts needed no code: episode pages are ordinary web pages Readability reads.

## Fetching pages

`fetchPage` walks a chain and stops at the first step that yields real text:

| Step | Handles | Notes |
|-|-|-|
| 1. `@mozilla/readability` | ordinary article pages | serves the large majority; 404/410 short-circuit here (`response-kind.ts`) |
| 2. site adapter | pages the generic path structurally cannot read | `site-adapters.ts`: Reddit (`old.reddit.com`), dpreview forum threads, YouTube (yt-dlp transcript) |
| 3. lightpanda sidecar | pages whose text is not in the HTML at all | self-hosted browser, own container and memory budget; on when `LIGHTPANDA_URL` is set |
| 4. Tavily Extract | static pages Readability could not parse | costs a credit |
| 5. Wayback Machine | origins that refuse this crawler outright | `archive.ts`; free; only after every live step failed, never for a 404 |

Every renderer reports failure by not failing — Reddit's 200 + JS shell, lightpanda's `exit 0`
on a dead domain, a Medium paywall that returns the lede above the 200-char floor — and each
shape is detected and unit-tested against the measured bytes. The fetch-level bench
(`scripts/fetch-bench.ts`) is the instrument here; a job-level A/B cannot resolve fetch
effects (`pagesFailed` cv 1.00). Everything the chain recovers, and why the third-party
renderer was retired: [measurements](./docs/measurements.md#fetching-pages).

## Telemetry

Each job reports spend to argo `POST /usage/records` as `source: "research-gateway"`, up to
seven records per job, `source_id` scoped `${jobId}:<sub_tool>`:

| `sub_tool` | `cost_source` | Why |
|-|-|-|
| `lead` / `worker` | `computed` | local rate table, cache-aware — the endpoint bills a cache read ~30x below a miss and the fan-out sustains ~60% hits |
| `sonar` | `reported` | Perplexity returns the USD; the cost is a per-request search fee, not tokens |
| `tavily` | `none` | credits travel in `raw`; no verified USD-per-credit rate exists |
| `lightpanda` / `ytdlp` / `wayback` | `none` | self-hosted or free — no marginal cost; `raw` carries calls, failures, `totalMs` (and the oldest snapshot age for Wayback) |

Search records are debounced per job; telemetry failure never fails a job.

**Traces and structured `log()` calls ship to ClickStack over OTLP when
`OTEL_EXPORTER_OTLP_ENDPOINT` is set** (`lib/otel.ts`, SDK-free: OTLP/HTTP JSON over `fetch`,
spans parented through `AsyncLocalStorage`; the AI SDK's own telemetry is deliberately off
because it records prompts). **A job's trace id is its job id** with dashes stripped, so a
trace joins its argo rows and its log lines with no correlation column, and a log line in
HyperDX is clickable into its trace. Container logs rotate away inside 72h; this is the record.
Dashboard tiles and SQL: [`docs/hyperdx-dashboard.md`](./docs/hyperdx-dashboard.md).

## Restarts, and what they cost

Status-only durability: the agent's in-flight work is never resumed, so a job that loses its
process is lost. Two mechanisms keep that from being the normal case.

**A deploy drains rather than kills.** SIGTERM stops admitting new jobs, rejects the ones still
queued behind the concurrency semaphore with "never started — resubmit", and then waits up to
`SHUTDOWN_DRAIN_MS` for the running ones to finish before flushing OTel and exiting. This is
free because of the rollout order: rollhook starts the new container and waits for it to be
healthy *before* stopping the old one, and both replicas write through to the same sqlite job
store — so a client polling through the new container still sees the old replica's job reach
`done`. The cost is a longer deploy tail when a job is in flight.

The window is sized off the measured distribution, not a guess:
[docs/measurements.md § Job duration](./docs/measurements.md#job-duration-by-depth--the-30-day-span-record)
is the single source for those numbers and the place to re-derive them. The short version is
why the first value was wrong — 600s came from one fast deep run, and the span record says it
would have missed 39% of deep jobs. At 1800s the observed maximum clears with headroom, and the
ceiling stops being this number: a deep job's own summed phase timeouts cap it near 34 minutes
anyway. A job that still outruns the window gets cut — `process.drained` logs `remaining` at
**error** level when that happens, which is the number to re-read before anyone argues for
agent-loop checkpointing.

**Memory pressure sheds instead of dying.** `lib/memory-watch.ts` samples the cgroup every 5 s;
at 85% of the limit it logs `process.memory_pressure` *and* flips admission to refuse new jobs,
re-arming (`process.memory_recovered`) below 75%. A watchdog that only logged is what the
2026-09-04 OOM kill exposed — all three concurrent jobs died with the process because nothing
upstream ever stopped admitting more.

What survives neither is a SIGKILL. The next boot reaps any job whose heartbeat is >90s stale to
a terminal `error` ("lost, resubmit"), and that reap is the thing to watch:

- `job.reaped` is logged at **error** level with a `count` — the HyperDX alert fires on it,
  and on `job.reaped_on_read` too. Four more alerts cover the failures that are not a hard
  kill: `job.error`, an `worker.failed`/`plan.fallback` burst, memory pressure, and a drain
  that cut live jobs. Thresholds and the reasoning: `docs/hyperdx-dashboard.md` § Alerts.
- `GET /health` carries `lastRestartAt`, `reaped` (this boot), `interrupted` (this process
  lifetime), `draining`, `jobs.running` / `jobs.queued` and the cgroup `memory` ratio — enough
  for a keyword monitor with no log access to see load, shedding and shutdown state. Only
  `status` gates anything; a draining container still serves polls correctly, so it stays `ok`.
- **A kernel OOM kill leaves no container log line, and `docker inspect` on the restarted
  container reports `ExitCode: 0` / `OOMKilled: false`** — both describe the *current* run.
  That is how 2026-07-31 and 2026-09-04 both read as "mystery exit 0"; the VPS kernel journal
  (`journalctl -k | grep oom`) held the 2026-09-04 answer: SIGKILL at exactly the 1 GiB
  `mem_limit`, 15 jobs reaped. `lib/memory-watch.ts` now logs `process.memory_pressure` at
  error level when the cgroup's `memory.current` crosses 85% of its limit (sampled every
  5 s, with the `memory.events` counters) — the only in-process warning a SIGKILL allows. `process.exit` / `beforeExit` / `uncaughtException` / `unhandledRejection`
  are logged too, for every exit that *is* in-process.
- Markdown-only pushes do not deploy (`paths-ignore`); everything else does. With the drain in
  place a deploy mid-job is survivable rather than destructive, but `GET /health`'s `jobs`
  counts still tell you whether you are about to add ten minutes to the deploy tail.

## Deploy

VPS, Tailscale-only (grey-cloud A record → VPS Tailscale IP, not the Cloudflare Tunnel) →
Traefik → rollhook on push to `master`. **The compose file and prod `.env.tpl` are owned by
the `vps` repo** (`apps/research-gateway/`); this repo has no copy. [`deploy/DEPLOY.md`](./deploy/DEPLOY.md).

## Clients

| Client | Path |
|-|-|
| Claude Code `/research` (every session, both Macs) | the `research-gateway` MCP at `/mcp`, registered at user scope by dotfiles `make setup` |
| Hermes | direct bearer HTTP — `POST /research` then poll `GET /research/{jobId}`; not an MCP client |
| anything else on the tailnet | bearer HTTP, or the MCP endpoint |

This service replaced the sideclaw `research` tool; the MCP facade that was once "deferred, only
if an MCP-only client needs it" became the main door the moment Claude Code was the main client.

### What an MCP client has to configure

`job_wait` blocks for the entire job, which is only useful if the client is willing to wait that
long. The server holds its side up: `createMcpHandler` runs with `responseMode: 'sse'`, so the
SDK upgrades every response to a stream before the tool body runs and writes a keep-alive frame
every 15s. Nothing in the path — Bun's `idleTimeout` (255s, its maximum), Traefik, a client idle
timer — ever sees an idle connection.

The client side is one setting. In Claude Code, the per-server `timeout` in its MCP entry is a
hard wall-clock cap **and** the floor on its own idle timeout (5 minutes for HTTP by default);
progress notifications do **not** raise that floor, only the `timeout` does. Size it against
**queue wait plus execution**, not execution alone: with `RESEARCH_MAX_CONCURRENCY=3` a fourth
deep job waits for a slot before it starts running, and a budget that only covers the ~34-minute
execution ceiling would abort a perfectly healthy call during a backlog.

```jsonc
"research-gateway": { "type": "http", "url": "https://research.jkrumm.com/mcp", "timeout": 7200000 }
```

A call still running after two minutes moves to a Claude Code background task
(`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`, default 120 000) and its result arrives as a notification,
so a long wait costs no model turns. That is the same benefit the MCP **Tasks** extension is
designed to give, which is why Tasks is not adopted here: the installed SDK marks its task
vocabulary `@deprecated … with no SDK runtime`, never emits `resultType: "task"`, and its 2026
codec strips `execution.taskSupport` / `capabilities.tasks` as deleted fields.
