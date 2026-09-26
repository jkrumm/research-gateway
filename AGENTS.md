# research-gateway — Agent Instructions

Elysia/Bun service, native on the Mac mini: one research brain behind bearer HTTP + an MCP facade at
`/mcp`. A lead model plans, a fan-out of workers researches in parallel (web search + page
fetch + source-of-truth lookups), the lead synthesizes one cited report. **README.md is the
contract** (endpoints, env vars, grounding model, stack) — this file is what a dispatched
agent needs before touching code; don't restate what README already owns.

| Doc | Holds |
|-|-|
| `README.md` | Contract, Grounding, Environment, Stack, Restarts, Deploy — read this first |
| `docs/decisions.md` | Why AI SDK not Mastra, the model history (DeepSeek → Luna → DeepSeek), the fan-out shape |
| `docs/measurements.md` | Every number, with the run it came from (search backend, fetch chain, cost) |
| `docs/field-notes.md` | Consumer-side observations, open backlog (now GitHub issues) |
| `docs/architecture-review-2026-09.md` | End-to-end architecture challenge: the nine-point verdict and the phased plan in flight |
| `docs/hyperdx-dashboard.md` | Span model + dashboard SQL |
| `deploy/MINI.md` | The mini's native instance: layout, secrets overlays, the deploy poller, operating targets |

## Async job contract

Everything is submit-then-poll — never expect a synchronous result.

- HTTP (Hermes's and sideclaw's lane): `POST /research` → `{ jobId, status }`; **poll**
  `GET /research/:jobId` — it returns current state at once and never blocks — until
  `status: "done"` — measured p50 quick 38s / standard 111s / deep 366s, full distribution in
  `docs/measurements.md` § Job duration.
- MCP (`/mcp`, bearer): tools `research`, `job_status`, `job_wait`, `job_cancel` — same submit → poll
  contract — but `job_wait` blocks for the WHOLE job, not a 50s slice, so one call is normally
  the entire interaction. `responseMode: 'sse'` is what makes that safe: the SDK writes a
  keep-alive frame every 15s. `src/lib/wait.ts`'s header is the canonical explanation of why
  that makes an unbounded wait safe — read it there rather than re-deriving it. A client still
  needs a generous per-server `timeout`, sized for queue wait PLUS execution. This is the
  primary client path (Claude Code's
  `/research` skill, sideclaw); plain bearer HTTP is for everything else.
- `result.status` can be `"partial"` — evidence was lost and the report prepends a banner.
  A text-only MCP client sees only the prose, so **always surface `unverified` and a
  non-`ok` status to the human**, never just the `report` string.
- `RESEARCH_MAX_CONCURRENCY` / `RESEARCH_MAX_QUEUE` cap jobs; past it, submit returns 429.
- Terminal statuses are `done`, `error` and `cancelled` (`isTerminalStatus` in `schema.ts` — use
  it, never a hand-written `done || error`). Cancel is `DELETE /research/:jobId`, MCP
  `job_cancel`, `research cancel`; the job's `AbortSignal` reaches every LLM call through its idle
  watchdog, and `run.ts` re-checks it at each phase boundary because plan/worker/synthesis/
  consistency all degrade instead of throwing.
- A finished job is retained 7 days in sqlite (`JOB_TTL_MINUTES`, default 10080) — the `jobId`
  is the durable handle a client comes back to, not a session token. Memory holds queued/running
  jobs only (plus a terminal one until the next sweep). `POST /research` and the MCP `research`
  tool accept an optional `idempotencyKey` (1..200 chars): a retried submit with the same key
  returns the original job, and the dedupe runs before admission so it is never shed.
- The CLI (`bin/research.ts`, `make install-cli`) talks the same REST door with no session
  state: `research "<query>"` submits and polls, `research wait <jobId>` resumes a known id,
  `research batch <file.jsonl>` / `research wait-all <ids…>` are the fan-out pair. It
  is the door for Codex/OpenCode/Hermes/cron and the fallback when the MCP tools are missing.

## Models

`deepseek-v4.1-flash` is the default for **both** lead and worker roles (`IU_LEAD_MODEL` /
`IU_WORKER_MODEL`, prod sets neither — the default in `src/env.ts` is the real
configuration), `reasoning_effort: "high"`. 2026-09-13 estate-wide model decision — supersedes
the 2026-08-20 move to `gpt-5.6-luna` recorded in `docs/decisions.md`; DeepSeek has no
prompt-cache discount on this route, an accepted cost. Effort and the per-call-role output
budget (plan / worker step / synthesis each need a different one — synthesis writes the whole
report inside its tool call) are applied in one place, `src/lib/llm.ts`
(`wrapLanguageModel` + `defaultSettingsMiddleware`), not scattered across call sites. A Luna
override is forced to `"none"` (`reasoningEffortFor`) — Luna rejects function tools with any
other effort on `/chat/completions`, unset included — which is why gpt-6-luna was reverted
after a one-day deploy on 2026-09-23. Don't
"fix" a slow run by switching models without re-reading `docs/decisions.md` first.

## Grounding — the one invariant that must never regress

A retrieval ledger (`src/agent/ledger.ts`) is the only thing allowed to back a citation:
`retrieved` / `missing` / `snippet` can cite, `failed` / `unseen` cannot. `missing` (a 404/410
answer from the origin) is the only tier that carries an absence claim at `high` — an absence
claim citing a merely `retrieved` page caps at `medium` (issue #3's false negatives). Gating
runs in code at the worker boundary and the job boundary — never in a prompt alone (prompt-only
citation rules did not hold, twice, before this existed). If you touch `src/agent/ground.ts`,
`src/agent/tools.ts`, or add a new tool: run `src/agent/ground.test.ts` and don't merge a
regression against issue #1's case. A quoted number that is not in the page text `fetchPage`
delivered for the cited URL caps that citation at `low` (`numbers.ts`) — also in code, for the
same reason. Full model: README § Grounding.

## One instance — the mini

Native LaunchAgents from a deploy clone at `~/.research-gateway/app` (`deploy/MINI.md`). The VPS
container was retired 2026-09-26 — every consumer already ran against the mini, which carries a
strict superset (human solve, brain search, higher concurrency); no fallback instance remains.
See `docs/decisions.md` for the retirement rationale and history/pre-2026-09-26 commits for the
two-instance era (rollhook, compose, cgroup memory limits). Defaults now only need to be safe
for local dev/tests — the mini opts in via `.env.mini.tpl` (`HOST`, `MACHINE`,
`MEMORY_LIMIT_MB`, OTLP auth, `BRAIN_BASE_URL`) and `scripts/launch.sh` (`BRAIN_DIR`, which a
template can't express since it needs `$HOME` expansion — same reasoning as `JOB_DB_PATH`/
`YTDLP_PATH`). `launchd/` template changes need `make launchd-install` by hand. Usage goes to
the local usage-tracker via JSONL (`USAGE_SINK=jsonl` + `USAGE_JSONL_PATH` in `scripts/launch.sh`).

## Deploy-on-push, and what it costs

Push to `master` reaches the mini within 2 minutes via `scripts/mini-deploy.sh`'s git poller
(`deploy/MINI.md`), which gates on `.github/workflows/ci.yml`'s `check` job for that SHA before
touching anything: pending/failing/unreachable all skip the tick and retry on the next one, only
a green check-run deploys. A deploy no longer kills running jobs outright: SIGTERM **drains** —
stops admitting, fails the still-queued ones with "never started, resubmit", and waits up to
`SHUTDOWN_DRAIN_MS` (1800s) for the running ones. There is no second replica to overlap onto (the
rollhook/compose rollout this relied on was VPS-only, since retired) — the poller's own idle gate
does the equivalent job instead: it defers the whole tick while `GET /health` reports any running
or queued job. The cost is a longer deploy tail, so `GET /health`'s `jobs` counts are still worth
a look. A job that outlives the window is still cut — `process.drained` with `remaining > 0` is
the error-level line that says so. **Size this off `docs/measurements.md` § Job duration, never
off one run** — the first value was 600s, taken from a single fast deep run, and the span record
says it missed 39% of deep jobs.

## Memory watchdog, and load shedding

`src/lib/memory-watch.ts` samples every 5s — process RSS against `MEMORY_LIMIT_MB` on the mini
(no cgroup on macOS; the VPS container's `mem_limit: 2g` cgroup sampling is history, see git log
pre-2026-09-26). At 85% of the limit it logs `process.memory_pressure` at **error** severity
*and* calls `setMemoryPressure(true)`, which makes `admission()` refuse new jobs with a 503
until it re-arms below 75% (`process.memory_recovered`). The log line is the only in-process
warning a SIGKILL allows. `GET /health` carries `lastRestartAt` / `reaped` / `interrupted` /
`draining` / `jobs` / `memory` (`memory.source: "rss"` on the mini) for a keyword monitor with no
log access.

## Local dev

```bash
bun install
bun run dev        # secrets-run injects .env.local.tpl (op on the MacBook, sealed cache on the mini)
bun run typecheck  # tsc --noEmit, strict
bun test           # pure-function tests only — needs no secrets
```

Anything importing `env.ts` is untested by design — factor pure logic out instead
  (`ledger`, `extract`, `archive`, `site-adapters`, `response-kind`, `youtube-captions`,
  `otel-format`, `brain`, `karakeep` are the pattern). Do not mock `env`. `scripts/smoke.ts` runs one
`runResearch()` end to end without the HTTP server.

## File map

- `src/routes/{research,mcp,health,probe}.ts` — the four surfaces, one engine
- `bin/research.ts` — the REST-door CLI (`research` / `research wait|status`); pure argv→request
  and exit-code mapping, only fetch (plus the Keychain read) is I/O — see `bin/research.test.ts`
- `src/agent/{plan,worker,synthesize,run}.ts` — the fan-out: lead plans → workers dig →
  lead synthesizes
- `src/agent/ledger.ts` + `ground.ts` — the grounding invariant above
- `src/agent/tools.ts` — the ten tools (source-of-truth lookups + `searchWeb`/`fetchPage`);
  adding a source to an existing tool is cheap, a new tool definition is not (README §
  Source-of-truth lookups)
- `src/agent/brain.ts` + `brain-search.ts` — `brainNotes`, mini-only (`BRAIN_DIR` +
  `BRAIN_BASE_URL`): ripgrep over the vault roots `wiki/`, `Projects/`, `Areas/` and `Inbox/`
  (owner decision 2026-09-25 — health and finance notes in scope, journals never),
  realpath-checked against symlink escape (a note symlinked to a file outside every root is
  dropped, not followed); journals are excluded by path and frontmatter, vault-root files and
  `docs/` are never roots. `brainNotes({ path })` (and `fetchPage` on a reader URL) reads one
  note in full under the same scope, charged to the worker's page-text budget. Ranking/excerpting is pure (brain.ts); the spawn+fs boundary is
  brain-search.ts.
- `src/agent/challenge.ts` + `host-gate.ts` + `host-policy.ts` + `impersonate.ts` — block
  classification (webcmd's decisive/corroborating rule), the process-wide per-host gate
  (concurrency, interval, cooldown), static per-host overrides, and the `impit` TLS-impersonation
  rung. All pure except `impersonate.ts`'s native client.
- `src/agent/human-solve.ts` + `human-solve-state.ts` + `bin/solver.ts` — mini-only human solve:
  MacBook dialog over ssh, solve over Screen Sharing in the mini's solver Chrome, stealth CDP
  polling; `deploy/MINI.md` § Human solve.
- `src/agent/karakeep.ts` + `karakeep-search.ts` — the owner's Karakeep bookmarks, folded into
  the same `brainNotes` tool (no eleventh tool definition), mini-only and optional
  (`KARAKEEP_URL` + `KARAKEEP_API_KEY`). Pure parsing/ranking/excerpting in karakeep.ts; the
  fetch boundary never throws and degrades to brain-only results.
- `src/agent/fetch-chain.ts` + `site-adapters.ts` + `lightpanda.ts` + `archive.ts` — the
  `fetchPage` chain (Readability, or `pdftotext` for a PDF (`pdf.ts`) → site adapter → `impit`
  impersonation on a 401/403/503 → lightpanda sidecar → Tavily Extract → human solve (mini) →
  Wayback), every origin hit behind the per-host gate. Readability/site-adapter parsing runs off the event loop in a worker
  pool (`html-parse.ts` + `parse-worker.ts`); the whole chain is bounded by a per-fetch
  budget (`FETCH_CHAIN_BUDGET_MS`).
- `src/lib/job-store.ts` + `job-db.ts` — sqlite job durability + heartbeat reaping; also owns
  the drain (`beginDraining` / `waitForDrain`) and the admission state
- `src/lib/admission.ts` — the pure "may a new job start" decision (draining > memory pressure
  > queue full); `memory-watch.ts` feeds it, `index.ts`'s SIGTERM path flips it
- `src/lib/otel.ts` + `otel-format.ts` — SDK-free OTLP export, job id = trace id
- `src/lib/cost.ts` + `usage.ts` — per-job spend, reported to argo
- `evals/` + `scripts/eval.ts` — golden-set answer-quality eval (`evals/golden.jsonl`,
  regex + live-registry resolvers, results in `evals/results/`); `bun scripts/eval.ts`,
  see `docs/measurements.md` § Answer-quality eval
- `lightpanda/` — the rendering sidecar, run on the mini as its own LaunchAgent
  (`scripts/launch-lightpanda.sh`); `Dockerfile` stays only because `boundary.test.ts` reads it
  as a self-containment guard, no image is built or deployed from it any more

## Gotchas that change a decision

- **Nine tools, not twelve.** New ecosystem support goes on an existing tool
  (`packageInfo`, `academicSearch`), not a new tool definition — definitions are re-sent
  every step, every worker, every job.
- **`SEARCH_PROVIDER=sonar` is the default, Tavily is the fallback** — `TAVILY_API_KEY` is
  still required either way (Extract path). Don't treat Tavily as removable.
- **`op inject` resolves `op://` refs inside comments too** — never park an unused ref
  behind a `#` in a `.env.tpl`, it fails the whole injection.
- **The renderer sidecar deploys separately** (own workflow) so a browser bump doesn't
  restart the gateway mid-job. `LIGHTPANDA_URL` unset takes it out of the chain cleanly.
- **`docs/field-notes.md`'s ranked backlog is filed as GitHub issues** (#3-#7) — check
  there before re-discovering the same failure mode from a fresh session.
