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
- **Job store:** `bun:sqlite`, an owner LEASE per job (heartbeat-renewed) plus a resumable
  checkpoint — a `done` result survives a redeploy, and a job whose owner's lease goes stale
  (a crash, a SIGKILL, an unclean restart) is CLAIMED by whichever process notices next and
  resumed from its last completed round, not reaped to a terminal error. A poison job — one
  that crashes `MAX_JOB_ATTEMPTS` processes in a row — still ends terminal, so this is a
  superset of the old reap-on-restart behaviour, not a replacement of its safety net. See
  [Restarts](#restarts-and-what-they-cost).
- **Telemetry:** per-job spend to argo, traces and logs to ClickStack over OTLP — SDK-free.

## Contract

| Endpoint | Auth | Body / Params | Returns |
|-|-|-|-|
| `GET /` | public | — | discovery: the public route list, `/openapi`, the MCP tools |
| `GET /health` | public | — | `{ status: "ok", lastRestartAt, resumed, failedAfterRestarts }` — only `status` gates anything (Docker healthcheck, rollhook); the counts show adoption/crash-loop activity to a keyword monitor. Also carries `draining`, `jobs`, the cgroup `memory` ratio and `eventLoopLagMs` / `eventLoopLagPeakMs`. See [Restarts](#restarts-and-what-they-cost) |
| `GET /health/render` | public | — | `{ renderer, active, queued, error }` — the sidecar. **Deliberately not part of `/health`**: the renderer is optional, and a broken one must not block deploys of a gateway that is otherwise fine |
| `GET /health/tavily` | public | — | live account state from `api.tavily.com/usage` incl. `overPlan` — crossing into pay-as-you-go was otherwise silent |
| `GET /health/ytdlp` | public | — | `{ ytdlp, version, error }` — `yt-dlp --version` inside the container |
| `GET /health/pdf` | public | — | `{ pdftotext, version, error }` — `pdftotext -v` inside the container |
| `GET /openapi`, `/openapi/json` | public | — | Scalar UI, raw spec |
| `POST /research` | bearer | `{ query, depth?, context? }` (`quick \| standard \| deep`; `context` = free-text background treated as given — not re-searched, never cited) | `{ jobId, status }` (async) |
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
| `JOB_TTL_MINUTES` | no (240) | how long a finished job's result stays readable after it completes. Stored in sqlite, so it survives restarts and is readable through either replica. Raised from 30: a fan-out caller reads its jobs one at a time, more slowly than the workers finish them |
| `SHUTDOWN_DRAIN_MS` | no (1 800 000) | how long SIGTERM waits for RUNNING jobs before force-exiting. **Must stay below the compose `stop_grace_period` (1860s)** or SIGKILL wins and the drain buys nothing. Sized off the 30-day span record, not a guess — see Restarts |
| `YTDLP_PATH` / `YTDLP_MAX_CONCURRENCY` / `YTDLP_TIMEOUT_MS` | no | bundled binary; concurrency 2 because YouTube rate-limits the datacenter IP under burst |
| `PDFTOTEXT_PATH` | no (`pdftotext`) | poppler-utils, an apk package in the image (Dockerfile) rather than a pinned binary download — PATH lookup by default |
| `ACADEMIC_CONTACT_EMAIL` | no | enables `academicSearch`'s `unpaywall` source — unpaywall requires a real contact address on every request and blocklists `@example.com`; also sent to Crossref's "polite pool" `mailto` param when set |
| `CORE_API_KEY` | no | raises `academicSearch`'s `core` source above the keyless 100 tokens/day, 10/min |
| `S2_API_KEY` | no | enables `academicSearch`'s `semanticscholar` source — unauthenticated Semantic Scholar 429s on the very first call (measured), so the source is not offered at all without a key |

Production values come from `vps/apps/research-gateway/.env.tpl` via `op inject`, which
**resolves `op://` refs inside comments too** — never park an unused ref behind a `#`. The vps
repo's `.env.tpl` needs `ACADEMIC_CONTACT_EMAIL` / `CORE_API_KEY` / `S2_API_KEY` added
alongside the existing keys for those sources to be offered in prod — not done here, since this
repo has no copy of that file.

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
| who published what, what year, how many citations, is there a paper on X | `academicSearch` + `openalex` / `pubmed` / `arxiv` / `crossref` / `core` (`unpaywall` when `ACADEMIC_CONTACT_EMAIL` is set, `semanticscholar` when `S2_API_KEY` is set) | api.openalex.org · eutils.ncbi.nlm.nih.gov · export.arxiv.org · api.crossref.org · api.core.ac.uk · api.unpaywall.org · api.semanticscholar.org (429s unauthenticated) |
| best open-access location for a DOI | `academicSearch` + `unpaywall` | api.unpaywall.org — read it, then `fetchPage` the OA URL to earn a `high`-confidence citation |
| what a practitioner said, at length, out loud | `findVideos` | `yt-dlp` search, keyless; `fetchPage` on a watch URL returns the transcript |
| current API surface of a library | `libraryDocs` | Context7 |

**Nine tools, not twelve.** Definitions are re-sent every step, every worker, every job, so
new *ecosystems* go on existing tools (`packageInfo`,
`academicSearch`) rather than becoming new definitions. Adding a source is cheap; adding a
tool is not. Podcasts needed no code: episode pages are ordinary web pages Readability reads.
`academicSearch`'s `source` enum is itself built from what is configured (`unpaywall` /
`semanticscholar` only appear when their env var is set), so a worker is never offered a source
that would fail on every call.

## Fetching pages

`fetchPage` walks a chain and stops at the first step that yields real text:

| Step | Handles | Notes |
|-|-|-|
| 1. `@mozilla/readability` | ordinary article pages | serves the large majority; 404/410 short-circuit here (`response-kind.ts`) |
| 1b. PDF | `application/pdf` (by content-type or `%PDF-` magic bytes) | `agent/pdf.ts`: `pdftotext` (poppler-utils) streamed via stdin/stdout, default layout mode (not `-layout` — measured, see the file's header), 25 MB cap. Never buffered whole; over-cap or a thin/scanned extraction is `recordFailed`, never a negative claim |
| 2. site adapter | pages the generic path structurally cannot read | `site-adapters.ts`: Reddit (`old.reddit.com`), dpreview forum threads, YouTube (yt-dlp transcript), arXiv (`/abs/`, `/pdf/` rewritten to the LaTeXML `/html/` build, with the PDF as an automatic fallback on a 404/410) |
| 3. lightpanda sidecar | pages whose text is not in the HTML at all | self-hosted browser, own container and memory budget; on when `LIGHTPANDA_URL` is set — skipped for a PDF, a browser cannot read one any better |
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

A job's status, query/depth, terminal result, and enough of the agent's own progress to RESUME
it all survive a process restart — the lease/checkpoint model below. A job whose owning
process disappears is not lost; it is ADOPTED by whichever process notices next and continued
from its last completed round. Three mechanisms make that the normal case, and a fourth is the
backstop for the job it still cannot save.

**Ownership is a lease, not a fact recorded once.** Every job row carries an `owner` (a
per-process id) and a heartbeat, renewed every 15s for the job's ENTIRE lifetime — queued and
running alike, since a deep job can legitimately wait 30+ minutes behind others for a
concurrency slot. `put()`'s writes are fenced to the CURRENT owner (`WHERE job.owner IS
excluded.owner`), so a process that has lost its lease cannot overwrite the adopter's row even
if it has not yet noticed — its own heartbeat tick discovers this independently and logs
`job.lease_lost`. Whenever a heartbeat goes stale (>90s, six missed ticks) — a crash, a
SIGKILL, an unclean restart — `claimStale` (one `UPDATE … RETURNING` statement; SQLite
serializes writers across the two replicas a rolling deploy briefly runs against the same
sqlite file, so this alone is the compare-and-set that stops two processes from both claiming
one job) reassigns the row and resets it to `queued`. After every completed round, `run.ts`
saves a checkpoint (the next round's questions, every digest and ledger gathered so far, usage
so far) to that same row; the adopter resumes from it (`job.resumed`) instead of re-planning
and re-researching from scratch. A poison job — one that crashes `MAX_JOB_ATTEMPTS` (3)
processes in a row — is given up on rather than resurrected forever (`job.crash_loop_guard`,
terminal `error`). The one gap: the per-job SEARCH-spend meters (`agent/tools.ts`) are
in-memory and reset on every boot, so a resumed job's reported search cost covers only its
post-adoption portion — LLM usage has no such gap, since it travels inside the checkpoint.

**A deploy drains rather than kills, and now hands off rather than fails.** SIGTERM stops
admitting new jobs. Every job still queued behind the concurrency semaphore has its lease
RELEASED and its heartbeat silenced (`job.drain_handed_off`) rather than being failed with
"resubmit" — a sibling replica (or this same container's next boot) claims it immediately,
since a released lease is claimable with no staleness wait at all. Jobs already RUNNING get up
to `SHUTDOWN_DRAIN_MS` to finish before the process falls through to flushing OTel and exiting;
if that window elapses with jobs still running, THEIR leases are released too
(`releaseAllOwnedLeases`, `index.ts`) so the next replica adopts them within moments rather
than waiting out the full 90s staleness window after this process is already gone. None of this
needs the sibling replica to be new: rollhook starts the new container and waits for it healthy
*before* stopping the old one, and both write through to the same sqlite file, so a client
polling through the new container sees whichever replica's job reaches `done`.

The `SHUTDOWN_DRAIN_MS` window itself is sized off the measured distribution, not a guess:
[docs/measurements.md § Job duration](./docs/measurements.md#job-duration-by-depth--the-30-day-span-record)
is the single source for those numbers and the place to re-derive them. The short version is
why the first value was wrong — 600s came from one fast deep run, and the span record says it
would have missed 39% of deep jobs. At 1800s the observed maximum clears with headroom — there
is no wall-clock ceiling on a job's own duration any more (depth controls breadth, not a time
budget, since 2026-09-12), so this window is purely about how long a deploy is willing to wait
before handing a still-running job to the next replica instead. `process.drained` logs
`remaining` at **error** level when the window elapses with jobs still running — read alongside
`job.resumed` on whichever replica claims them next.

**Memory pressure sheds instead of dying, with a softer warning first.** `lib/memory-watch.ts`
samples the cgroup every 5 s. At 70% it HOLDS dispatch (`process.memory_hold`) — a queued job
simply waits for a free slot, never refused — releasing at 65%; at 85% it logs
`process.memory_pressure` and flips admission to refuse NEW submissions outright, re-arming
(`process.memory_recovered`) below 75%. A watchdog that only logged (no shedding at all) is
what the 2026-09-04 OOM kill exposed — all three concurrent jobs died with the process because
nothing upstream ever stopped admitting more.

**Event-loop stalls are measured, not inferred — and the one that motivated this is now fixed
structurally.** `lib/loop-watch.ts` samples timer drift every 5 s; a lag over 1 s logs
`process.loop_lag` at error level, and `GET /health` exposes both the latest sample
(`eventLoopLagMs`) and the worst of the last 60 s (`eventLoopLagPeakMs`) — the latest alone is
not enough, because a monitor polling every 30-60 s usually reads the quiet interval that
followed the stall. 2026-09-20: a deep job's synchronous HTML parse (linkedom + Readability)
blocked this one shared event loop long enough to starve heartbeats, the idle watchdog, and the
HTTP listener together — a LIVE process that looked dead to everything polling it. Three
things now prevent a repeat: `MAX_BODY_BYTES` bounds what `fetch-chain.ts` DOWNLOADS (a
byte-counting reader that cancels the response once it is over), `PARSE_INPUT_CAP` bounds what
it PARSES, and — the structural fix PR #23's own header conceded was still missing — the parse
itself now runs on a small pool of Bun Workers (`agent/parse-pool.ts`), not this loop, with its
own 60s per-parse hang guard. A worker that hangs or crashes is replaced; the fetch chain sees
that as an ordinary step-1 miss and falls through to lightpanda/Tavily Extract exactly as any
other parse failure always has.

What the lease above still cannot save is a POISON job — see `job.crash_loop_guard` above — and
that guard, plus a lost-process's own diagnostics, are what to watch:

- `job.lease_lost` / `job.resumed` / `job.crash_loop_guard` are the three lifecycle events —
  `job.crash_loop_guard` is the one at **error** level worth alerting on; `job.resumed` is the
  routine, expected shape of adoption after any unclean restart. Four more alerts cover
  failures that are not this: `job.error`, a `worker.failed`/`plan.fallback` burst, memory
  pressure, and a drain that cut live jobs. Thresholds and the reasoning:
  `docs/hyperdx-dashboard.md` § Alerts.
- `GET /health` carries `lastRestartAt`, `resumed` (this process lifetime), `failedAfterRestarts`,
  `draining`, `jobs.running` / `jobs.queued`, the cgroup `memory` ratio and `eventLoopLagMs` /
  `eventLoopLagPeakMs` — enough for a keyword monitor with no log access to see load, adoption
  and shutdown state. Only `status` gates anything; a draining container still serves polls
  correctly, so it stays `ok`.
- **A kernel OOM kill leaves no container log line, and `docker inspect` on the restarted
  container reports `ExitCode: 0` / `OOMKilled: false`** — both describe the *current* run.
  That is how 2026-07-31 and 2026-09-04 both read as "mystery exit 0"; the VPS kernel journal
  (`journalctl -k | grep oom`) held the 2026-09-04 answer: SIGKILL at exactly the 1 GiB
  `mem_limit`, 15 jobs lost (this was still the reap-to-error era — the same event today would
  be adopted, not lost). `lib/memory-watch.ts` logs `process.memory_pressure` at error level
  when the cgroup's `memory.current` crosses 85% of its limit (sampled every 5 s, with the
  `memory.events` counters) — the only in-process warning a SIGKILL allows. `process.exit` /
  `beforeExit` / `uncaughtException` / `unhandledRejection` are logged too, for every exit
  that *is* in-process.
- Markdown-only pushes do not deploy (`paths-ignore`); everything else does. With the drain and
  hand-off in place a deploy mid-job is survivable rather than destructive, but `GET /health`'s
  `jobs` counts still tell you whether you are about to add minutes to the deploy tail.

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
deep job waits for a slot before it starts running. There is no server-side execution ceiling
to size against any more — depth (`src/agent/depth.ts`) controls breadth (workers, sources,
rounds), not a time budget, and the only per-call bound left is an idle watchdog
(`RESEARCH_IDLE_TIMEOUT_MS`) that aborts a single LLM call gone silent, not the job. Size the
client `timeout` generously against the measured distribution
([job duration](./docs/measurements.md#job-duration-by-depth--the-30-day-span-record)) plus
queue wait, not a promised maximum.

```jsonc
"research-gateway": { "type": "http", "url": "https://research.jkrumm.com/mcp", "timeout": 7200000 }
```

A call still running after two minutes moves to a Claude Code background task
(`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`, default 120 000) and its result arrives as a notification,
so a long wait costs no model turns. That is the same benefit the MCP **Tasks** extension is
designed to give, which is why Tasks is not adopted here: the installed SDK marks its task
vocabulary `@deprecated … with no SDK runtime`, never emits `resultType: "task"`, and its 2026
codec strips `execution.taskSupport` / `capabilities.tasks` as deleted fields.
