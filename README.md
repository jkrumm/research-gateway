# research-gateway

One research brain, hosted natively on the Mac mini, callable by every client on the tailnet (Claude Code,
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
| [`deploy/MINI.md`](./deploy/MINI.md) | The mini's native instance — layout, secrets, deploy poller, operating targets |

## Stack

- **Elysia + Bun**, `@elysiajs/openapi` typed contract, bearer `authGuard` (argo patterns;
  constant-time token compare).
- **Vercel AI SDK 7** (`ai@7`) — `generateText` tool loops using the **done-tool pattern** (a
  terminal tool with no `execute`, whose input is the structured result: `submit_plan`,
  `submit_digest`, `submit_report`). `prepareStep` forces the done-tool in-loop before any
  ceiling is hit, so a run always banks its result instead of being cut off empty-handed.
- **LLM:** IU unified endpoint via `@ai-sdk/openai-compatible`. **`deepseek-v4.1-flash` for
  both** the lead (plan + synthesis) and the workers, `reasoning_effort: "high"` (2026-09-13
  estate-wide model decision, superseding the earlier `gpt-5.6-luna` pick — `src/env.ts` and
  `docs/decisions.md` carry the history). Effort and the per-call-role output budget (plan
  16000 / worker step 16000 / synthesis 32000 — synthesis writes the whole report inside its
  tool call) are applied in one place, `src/lib/llm.ts`, via `wrapLanguageModel` +
  `defaultSettingsMiddleware`. Override the model with `IU_LEAD_MODEL` / `IU_WORKER_MODEL`;
  prod sets neither.
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
| `GET /health` | public | — | `{ status: "ok", lastRestartAt, reaped, interrupted }` — only `status` gates anything (the mini's deploy poller, a keyword monitor); the counts show an unclean restart. See [Restarts](#restarts-and-what-they-cost) |
| `GET /health/render` | public | — | `{ renderer, active, queued, error }` — the sidecar. **Deliberately not part of `/health`**: the renderer is optional, and a broken one must not block deploys of a gateway that is otherwise fine |
| `GET /health/tavily` | public | — | live account state from `api.tavily.com/usage` incl. `overPlan` — crossing into pay-as-you-go was otherwise silent |
| `GET /health/ytdlp` | public | — | `{ ytdlp, version, error }` — `yt-dlp --version` inside the container |
| `GET /openapi`, `/openapi/json` | public | — | Scalar UI, raw spec |
| `POST /research` | bearer | `{ query, depth?, context?, idempotencyKey? }` (`quick \| standard \| deep`; `context` = free-text background treated as given — not re-searched, never cited; `idempotencyKey` = optional 1..200-char key — a retried submit with the same key returns the original job) | `{ jobId, status, warnings? }` (async). `warnings` flags an input that is unexpanded shell syntax (`$(…)`, `$VAR`, backticks) or the CLI's `@file` syntax — the job still runs; cancel it if the warning is right (`lib/input-lint.ts`) |
| `GET /research/:jobId` | bearer | — | `{ status, result?, error?, depth, submittedAt, startedAt, finishedAt, queuePosition, progress, typicalDurationMs }` — a **poll**: returns current state at once, never blocks. `queuePosition` (1 = next) while queued, `progress: { phase, round, workers: { done, total } }` while running, `typicalDurationMs: { p50, p90 }` for the depth — a range to judge "stuck" against, not an ETA. MCP `job_status`/`job_wait` carry the same fields |
| `DELETE /research/:jobId` | bearer | — | `{ jobId, status }` — **cancel**: a queued job never starts, a running one is aborted and its slot freed; `status: "cancelled"` (terminal). Idempotent — an already-terminal job comes back unchanged. A cancelled job's `idempotencyKey` is released for a corrected resubmit |
| `POST /mcp` | bearer | streamable-http (stateless, 2026-07-28) | tools `research`, `job_wait`, `job_status`, `job_cancel` — same engine. `job_wait` blocks for the whole job, so one call is normally the whole interaction |
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

A finished job is retained **7 days** (`JOB_TTL_MINUTES`, default 10080) in sqlite, so the
`jobId` is a durable handle: a client whose wait was cut — a closed session, a restart, a
dropped stream — can still fetch the result later, and a retried submit carrying an
`idempotencyKey` resolves to the original job. The in-memory store holds queued/running jobs
only, so the long window costs no memory.

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
| `retrieved` | full page/file/registry response was obtained | yes, up to `high` confidence — except an absence claim ("X does not exist"), capped at `medium` |
| `missing` | the origin itself answered 404/410 | yes, up to `high` — the one code-verifiable basis for a negative claim |
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
A run whose every evidence is a 404/410 answer (`pagesMissing > 0`, nothing retrieved) is NOT
partial: the origin's answer is the evidence, and absence claims citing it stay `high`.
A job that retrieved **nothing at all** is not a `partial` report: it is a terminal
`status: "error"` whose message names the upstream cause (e.g. an IU-endpoint 403/503), one
retry already spent trying to recover it.
An archived (Wayback) page is `retrieved` but the worker is told to cap it at `medium` and
name the snapshot date.
A number a citation quotes (a percentage, or any other number ≥ 100) must occur in the text
the model was actually handed for that URL by `fetchPage` (`src/agent/numbers.ts`, recorded
per URL in the ledger). One that does not — invented, carried over from another page, or
computed — caps the citation at `low`, adds an `unverified` entry naming the number, and counts
in `grounding.citationsNumberUnmatched`; at the worker boundary the finding's text is tagged
`[unverified number: …]` so synthesis leaves it out. It catches invented figures (the
2026-09-26 Pyke report's "~5,565 matches"), not a real figure read with the wrong meaning —
that is fixed at the source, e.g. the wrchina.gg reader labelling win rate vs presence.

Regression-tested in `src/agent/ground.test.ts` against the run that motivated it
([#1](https://github.com/jkrumm/research-gateway/issues/1)), and against the false-negative
run that motivated the absence-claim gate
([#3](https://github.com/jkrumm/research-gateway/issues/3): two `high`-confidence "does not
exist" claims, each citing a page the run really did retrieve — a sparse archive listing and
a revision timestamp). **A new lookup is not done until a
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
| `IU_LEAD_MODEL` / `IU_WORKER_MODEL` | no (`deepseek-v4.1-flash`) | plan + synthesis / the fan-out. The defaults are the real configuration — prod sets neither. Effort + per-role budget live in `src/lib/llm.ts` |
| `SEARCH_PROVIDER` | no (`sonar`) | `sonar` \| `tavily` — which backend `searchWeb` uses |
| `SONAR_MODEL` | no (`sonar`) | pinned; not a menu — see `env.ts` before changing it |
| `TAVILY_API_KEY` | yes | required even on `sonar`: the Extract fallback inside `fetchPage` and the per-call search fallback |
| `LIGHTPANDA_URL` | no (off) | the JavaScript-rendering sidecar, e.g. `http://research-gateway-lightpanda:7781`. Unset takes the renderer out of the chain — the gateway must run without it |
| `CONTEXT7_API_KEY` | no | enables `libraryDocs` |
| `GITHUB_TOKEN` | no | anonymous GitHub is **60 req/h per IP** shared across all jobs; a no-scope token raises it to 5000/h. Empty is treated as unset |
| `ARGO_USAGE_URL` / `ARGO_API_SECRET` | no | spend telemetry → argo `POST /usage/records`; no-op if either is unset |
| `USAGE_SINK` | no (`argo`) | `argo` \| `jsonl` — `jsonl` appends each record to `USAGE_JSONL_PATH` for the mini's local usage-tracker instead of POSTing (it syncs to argo; posting to both duplicates rows) |
| `USAGE_JSONL_PATH` | for `jsonl` | absolute JSONL path; no code default — the mini's launcher sets it. Unset with `USAGE_SINK=jsonl` logs `usage.sink_failed` and falls back to argo |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | no (off) | ClickStack collector, e.g. `http://clickstack:4319` (the unauthed receiver). Unset keeps `log()` console-only and exports no traces |
| `OTEL_SERVICE_NAME` | no (`research-gateway`) | `service.name` on exported spans and logs |
| `RESEARCH_MAX_CONCURRENCY` / `RESEARCH_MAX_QUEUE` | no (3 / 50) | concurrent *jobs* / accepted backlog |
| `WORKER_MAX_CONCURRENCY` | no (8) | concurrent *workers within one job* |
| `JOB_DB_PATH` | no (`./data/jobs.sqlite`) | `/app/data` in the container, a named volume |
| `SHUTDOWN_DRAIN_MS` | no (1 800 000) | how long SIGTERM waits for RUNNING jobs before force-exiting. **Must stay below the compose `stop_grace_period` (1860s)** or SIGKILL wins and the drain buys nothing. Sized off the 30-day span record, not a guess — see Restarts |
| `YTDLP_PATH` / `YTDLP_MAX_CONCURRENCY` / `YTDLP_TIMEOUT_MS` | no | bundled binary; concurrency 2 because YouTube rate-limits the datacenter IP under burst |
| `HUMAN_SOLVE_SSH_HOST` | no (off) | mini only: ssh alias of the owner's MacBook, used **only** to show the "solve this challenge?" dialog. Unset takes the human stage out of the chain |
| `HUMAN_SOLVE_VIEW_URL` | no | what the dialog's **Open** runs on the MacBook — `vnc://mini` (Screen Sharing into the mini, where the solver Chrome is) |
| `HUMAN_SOLVE_WAIT_MS` | no (300 000) | hang guard for one human solve — a wait for a person, not an agent budget |

Production values come from `.env.local.tpl` + `.env.mini.tpl` via `secrets-run` (`scripts/launch.sh`),
which **resolves `op://` refs inside comments too** — never park an unused ref behind a `#`.

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
and is **off**, because extra candidates produced no extra reading — the worker reads as much
as it decides to (there is no step cap since 2026-09-12), not as much as it is given. Numbers: [measurements](./docs/measurements.md#web-search-backend--why-sonar-and-the-two-pinned-settings).

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
| what the owner already concluded or decided | `brainNotes` (mini only — `BRAIN_DIR` + `BRAIN_BASE_URL`, optionally Karakeep via `KARAKEEP_URL` + `KARAKEEP_API_KEY`) | the owner's notes across `wiki/`, `Projects/`, `Areas/` and `Inbox/` via ripgrep, cited as brain-reader URLs; journals and vault-root files are excluded. Karakeep bookmarks are folded into the same tool, cited as Karakeep preview URLs |

**Ten tools on the mini, nine elsewhere — not twelve.** Definitions are re-sent every step, every worker, every job, so
new *ecosystems* go on existing tools (`packageInfo`,
`academicSearch`) rather than becoming new definitions. Adding a source is cheap; adding a
tool is not. Podcasts needed no code: episode pages are ordinary web pages Readability reads.

## Fetching pages

`fetchPage` walks a chain and stops at the first step that yields real text:

| Step | Handles | Notes |
|-|-|-|
| 1. `@mozilla/readability` | ordinary article pages | serves the large majority; 404/410 short-circuit here (`response-kind.ts`) |
| 1a. browser impersonation | origins that 403 our bot request at the TLS layer | `impersonate.ts` (`impit`, Chrome TLS/HTTP2 fingerprint + its UA). Only after a plain 401/403/503, never a 429; a host where it worked goes straight to it for 24h. Measured: idealo.de 403 → 200 |
| 1b. `pdftotext` | a PDF (by Content-Type or `%PDF-` magic) | `pdf.ts`, poppler, bytes never decoded as text; skips the renderer; a scanned PDF below the floor falls to Tavily Extract |
| 2. site adapter | pages the generic path structurally cannot read | `site-adapters.ts`: Reddit (`old.reddit.com`), dpreview forum threads, YouTube (yt-dlp transcript) |
| 3. lightpanda sidecar | pages whose text is not in the HTML at all | self-hosted browser, own container and memory budget; on when `LIGHTPANDA_URL` is set |
| 4. Tavily Extract | static pages Readability could not parse | costs a credit |
| 5. human solve (mini) | Cloudflare/anti-bot challenges nothing automated passes | `human-solve.ts` + `bin/solver.ts`: a dialog on the MacBook, **Open** → Screen Sharing into the mini, solve in the mini's dedicated solver Chrome; the page comes back from that browser. Only when this chain saw a block. A solved host is re-read through the same browser (no dialog) for 12h, so the clearance stays on the mini's IP |
| 6. Wayback Machine | origins that refuse this crawler outright | `archive.ts`; free; only after every live step failed, never for a 404 |

Every renderer reports failure by not failing — a PDF decoded as UTF-8 (1.98M chars of binary recorded as a `readability` success until 2026-09-23; `looksBinary` now fails any such body), Reddit's 200 + JS shell, lightpanda's `exit 0`
on a dead domain, a Medium paywall that returns the lede above the 200-char floor — and each
shape is detected and unit-tested against the measured bytes. The fetch-level bench
(`scripts/fetch-bench.ts`) is the instrument here; a job-level A/B cannot resolve fetch
effects (`pagesFailed` cv 1.00). Everything the chain recovers, and why the third-party
renderer was retired: [measurements](./docs/measurements.md#fetching-pages).

**Blocks and politeness.** `challenge.ts` classifies a response as an anti-bot block (adapted
from webcmd's two-tier rule: a decisive marker — `cf-mitigated: challenge`, "Just a moment…" —
counts at any status, a corroborating one only on 403/429/503; CSP and `report-to` headers are
never evidence). Every origin hit — plain, impersonated, rendered — passes a process-wide
per-host gate (`host-gate.ts`: 2 concurrent, 1s between starts) and a block puts the host in
cooldown (`Retry-After`, else 10 min → 30 min → 2 h), during which the chain goes straight to
Tavily/human/Wayback instead of spending the IP's reputation on a certain miss. Static per-host
overrides (skip origin/render for measured fingerprint-blocked hosts) live in `host-policy.ts`.

## Telemetry

Each job reports spend as `source: "research-gateway"`, up to seven records per job,
`source_id` scoped `${jobId}:<sub_tool>`. The default sink is argo `POST /usage/records`; on
the mini (`USAGE_SINK=jsonl`) the same records go to the local usage-tracker's JSONL file
instead — the tracker prices and syncs them to argo itself, so the gateway does not POST there
(doing both would duplicate rows). The record set:

| `sub_tool` | `cost_source` | Why |
|-|-|-|
| `lead` / `worker` | `reported` when every call in the snapshot returned the gateway's own `usage.cost` (DeepSeek ids do); `computed` (local rate table, cache-aware) otherwise — GPT/Gemini ids and any call the gateway priced at $0 or left unpriced | the gateway re-prices this route often enough that its own per-call cost beats a rate table whenever it's available; the table is the fallback, not the default |
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
`SHUTDOWN_DRAIN_MS` for the running ones to finish before flushing OTel and exiting. On the mini
(the only instance since the VPS was retired 2026-09-26) there is no second replica to overlap
onto, so `scripts/mini-deploy.sh`'s idle gate does the equivalent job from the other side: it
defers the whole tick — no reset, no restart — while `GET /health` reports any running or queued
job, and only restarts once the gateway is genuinely idle. The drain itself still matters for a
job that starts between that check and the restart, or for `make launchd-restart`/a reboot.

The window is sized off the measured distribution, not a guess:
[docs/measurements.md § Job duration](./docs/measurements.md#job-duration-by-depth--the-30-day-span-record)
is the single source for those numbers and the place to re-derive them. The short version is
why the first value was wrong — 600s came from one fast deep run, and the span record says it
would have missed 39% of deep jobs. At 1800s the observed maximum clears with headroom, and the
ceiling stops being this number: a deep job's own summed phase timeouts cap it near 34 minutes
anyway. A job that still outruns the window gets cut — `process.drained` logs `remaining` at
**error** level when that happens, which is the number to re-read before anyone argues for
agent-loop checkpointing.

**Memory pressure sheds instead of dying.** `lib/memory-watch.ts` samples every 5 s — the cgroup
on the retired VPS container, process RSS against `MEMORY_LIMIT_MB` on the mini (no cgroup on
macOS; see [`deploy/MINI.md`](./deploy/MINI.md)); at 85% of the limit it logs
`process.memory_pressure` *and* flips admission to refuse new jobs,
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
  lifetime), `draining`, `jobs.running` / `jobs.queued` and the `memory` ratio (`memory.source`
  says whether it's cgroup- or RSS-based) — enough for a keyword monitor with no log access to
  see load, shedding and shutdown state. Only `status` gates anything; a draining process still
  serves polls correctly, so it stays `ok`.
- **On the retired VPS container, a kernel OOM kill left no container log line, and
  `docker inspect` on the restarted container reported `ExitCode: 0` / `OOMKilled: false`** —
  both described the *current* run. That is how 2026-07-31 and 2026-09-04 both read as "mystery
  exit 0"; the VPS kernel journal (`journalctl -k | grep oom`) held the 2026-09-04 answer:
  SIGKILL at exactly the 1 GiB `mem_limit`, 15 jobs reaped. `lib/memory-watch.ts`'s
  `process.memory_pressure` at 85% (see above) is the same in-process warning on the mini,
  where a SIGKILL (OOM or otherwise) is a launchd crash-loop row instead of a silent restart.
- Markdown-only changes never restart the gateway — `scripts/mini-deploy.sh` classifies the
  diff per path and skips the restart entirely for `*.md`/`docs/*`; everything else does. With
  the drain in place a deploy mid-job is survivable rather than destructive, but `GET /health`'s
  `jobs` counts still tell you whether you are about to add ten minutes to the deploy tail.

## Deploy

Native on the **mini** — no Docker, no container registry. [`deploy/MINI.md`](./deploy/MINI.md):
LaunchAgents (`:7780` gateway, `:7781` lightpanda sidecar) plus an idle-gated deploy poller that
fetches `origin/master` every 2 minutes, checks GitHub Actions' `check` job for that SHA before
deploying (`scripts/mini-deploy.sh`), then resets, installs and restarts only what changed. The
VPS instance was retired 2026-09-26 — every consumer already ran against the mini, which carries
a strict superset (human solve, brain search, higher concurrency); see
[`docs/decisions.md`](./docs/decisions.md) for why.

## Clients

| Client | Path |
|-|-|
| Claude Code `/research` (every session, both Macs) | the `research-gateway` MCP at `/mcp`, registered at user scope by dotfiles `make setup` |
| Codex, OpenCode, Hermes, cron, scripts | the `research` CLI (`bin/research.ts`, `make install-cli`) — submits over REST and polls; no MCP client and no session state |
| Hermes | direct bearer HTTP — `POST /research` then poll `GET /research/{jobId}`; not an MCP client |
| anything else on the tailnet | bearer HTTP, or the MCP endpoint |

This service replaced the sideclaw `research` tool; the MCP facade that was once "deferred, only
if an MCP-only client needs it" became the main door the moment Claude Code was the main client.

The CLI is also the fallback when the MCP tools are missing: a session whose MCP connection
failed at **startup** has no `research`/`job_wait` for its whole lifetime, while
`research "<query>"` reaches the same REST door with no session state to lose. It reads
`RESEARCH_GATEWAY_URL` (default `http://127.0.0.1:7780`) and `RESEARCH_GATEWAY_TOKEN` (falling
back to the macOS Keychain generic password `research-gateway-token`). `research wait <jobId>`
resumes a job submitted earlier — the id is a durable handle, not a session token. The report
markdown goes to stdout, `status`/`warnings`/`unverified` to stderr; `--json` prints the full
job, `--no-wait` the id alone. `research cancel <jobId>` is the DELETE door.

For fan-out (one shared fact block, N per-entity questions): `research batch q.jsonl --context
@facts.md` submits one job per `{ query, depth?, key?, context? }` line (the whole file is
validated first; a line without `key` gets one derived from its query/depth/context, so
re-running the same file never double-submits), and `research wait-all
<ids…>` prints one line per job the moment each finishes — `batch … --json | jq -r .jobId |
xargs research wait-all`.

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
deep job waits for a slot before it starts running. There is no server-side execution ceiling
to size against any more — depth (`src/agent/depth.ts`) controls breadth (workers, sources,
rounds), not a time budget, and the only per-call bound left is an idle watchdog
(`RESEARCH_IDLE_TIMEOUT_MS`) that aborts a single LLM call gone silent, not the job. Size the
client `timeout` generously against the measured distribution
([job duration](./docs/measurements.md#job-duration-by-depth--the-30-day-span-record)) plus
queue wait, not a promised maximum.

```jsonc
"research-gateway": { "type": "http", "url": "https://research.mini.jkrumm.com/mcp", "timeout": 7200000 }
```

A call still running after two minutes moves to a Claude Code background task
(`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`, default 120 000) and its result arrives as a notification,
so a long wait costs no model turns. That is the same benefit the MCP **Tasks** extension is
designed to give, which is why Tasks is not adopted here: the installed SDK marks its task
vocabulary `@deprecated … with no SDK runtime`, never emits `resultType: "task"`, and its 2026
codec strips `execution.taskSupport` / `capabilities.tasks` as deleted fields.
