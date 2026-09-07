# research-gateway — Claude Code Instructions

Elysia/Bun service on the VPS: one research brain behind bearer HTTP + an MCP facade at
`/mcp`. A lead model plans, a fan-out of workers researches in parallel (web search + page
fetch + source-of-truth lookups), the lead synthesizes one cited report. **README.md is the
contract** (endpoints, env vars, grounding model, stack) — this file is what a dispatched
agent needs before touching code; don't restate what README already owns.

| Doc | Holds |
|-|-|
| `README.md` | Contract, Grounding, Environment, Stack, Restarts, Deploy — read this first |
| `docs/decisions.md` | Why AI SDK not Mastra, why `gpt-5.6-luna`, the fan-out shape |
| `docs/measurements.md` | Every number, with the run it came from (search backend, fetch chain, cost) |
| `docs/field-notes.md` | Consumer-side observations, open backlog (now GitHub issues) |
| `docs/hyperdx-dashboard.md` | Span model + dashboard SQL |
| `deploy/DEPLOY.md` | VPS deploy steps; **the vps repo owns compose + `.env.tpl`, this repo has no copy** |

## Async job contract

Everything is submit-then-poll — never expect a synchronous result.

- HTTP: `POST /research` → `{ jobId, status }`; poll `GET /research/:jobId` until
  `status: "done"` (tens of seconds to ~28 min at `depth: deep`).
- MCP (`/mcp`, bearer): tools `research`, `job_status`, `job_wait` — same submit → poll
  contract, `job_wait` blocks ~50s per call. This is the primary client path (Claude Code's
  `/research` skill, sideclaw); plain bearer HTTP is for everything else.
- `result.status` can be `"partial"` — evidence was lost and the report prepends a banner.
  A text-only MCP client sees only the prose, so **always surface `unverified` and a
  non-`ok` status to the human**, never just the `report` string.
- `RESEARCH_MAX_CONCURRENCY` / `RESEARCH_MAX_QUEUE` cap jobs; past it, submit returns 429.

## Models

`gpt-5.6-luna` is the default for **both** lead and worker roles (`IU_LEAD_MODEL` /
`IU_WORKER_MODEL`, prod sets neither — the default in `src/env.ts` is the real
configuration). Measured 3-8x faster to first token than DeepSeek-V4-Flash with equal
tool-calling reliability; rationale in `docs/decisions.md`. Don't "fix" a slow run by
switching models without re-reading that file — it's already the measured winner.

## Grounding — the one invariant that must never regress

A retrieval ledger (`src/agent/ledger.ts`) is the only thing allowed to back a citation:
`retrieved` / `snippet` can cite, `failed` / `unseen` cannot. Gating runs in code at the
worker boundary and the job boundary — never in a prompt alone (prompt-only citation rules
did not hold, twice, before this existed). If you touch `src/agent/ground.ts`,
`src/agent/tools.ts`, or add a new tool: run `src/agent/ground.test.ts` and don't merge a
regression against issue #1's case. Full model: README § Grounding.

## Deploy-on-push, and what it costs

Push to `master` deploys via rollhook (label-driven, OIDC) unless the diff is
markdown-only (`paths-ignore`). **A deploy kills every running job** — status-only job
durability means in-flight work is not resumed; the reap terminal-errors anything whose
heartbeat is >90s stale. Before pushing code: check `GET /health/render` shows `active: 0`
and the job store has nothing running long. `deploy/DEPLOY.md` § Traps has the rest
(`make research-gateway-redeploy`, never `down && up` — that rolls back to `:latest`).

## Memory watchdog

The VPS container runs at `mem_limit: 1g` (vps repo's compose). `src/lib/memory-watch.ts`
logs `process.memory_pressure` at **error** severity when cgroup `memory.current` crosses
85% of that limit — the only in-process warning a SIGKILL allows, since an OOM kill leaves
no application log line (`docker inspect` reports the *restarted* container's `ExitCode: 0`).
Two confirmed OOM kills (2026-07-31, 2026-09-04) both first looked like a mystery clean
exit; `ssh vps sudo journalctl -k | grep oom` is the actual record. `GET /health` carries
`lastRestartAt` / `reaped` / `interrupted` for a keyword monitor with no log access.

## Local dev

```bash
bun install
bun run dev        # secrets-run injects .env.local.tpl (op on the MacBook, sealed cache on the mini)
bun run typecheck  # tsc --noEmit, strict
bun test           # pure-function tests only — needs no secrets
```

Anything importing `env.ts` is untested by design — factor pure logic out instead
(`ledger`, `extract`, `archive`, `site-adapters`, `response-kind`, `youtube-captions`,
`otel-format` are the pattern). Do not mock `env`. `scripts/smoke.ts` runs one
`runResearch()` end to end without the HTTP server.

## File map

- `src/routes/{research,mcp,health,probe}.ts` — the four surfaces, one engine
- `src/agent/{plan,worker,synthesize,run}.ts` — the fan-out: lead plans → workers dig →
  lead synthesizes
- `src/agent/ledger.ts` + `ground.ts` — the grounding invariant above
- `src/agent/tools.ts` — the nine tools (source-of-truth lookups + `searchWeb`/`fetchPage`);
  adding a source to an existing tool is cheap, a new tool definition is not (README §
  Source-of-truth lookups)
- `src/agent/fetch-chain.ts` + `site-adapters.ts` + `lightpanda.ts` + `archive.ts` — the
  5-step `fetchPage` chain (Readability → site adapter → lightpanda sidecar → Tavily
  Extract → Wayback)
- `src/lib/job-store.ts` + `job-db.ts` — sqlite job durability + heartbeat reaping
- `src/lib/otel.ts` + `otel-format.ts` — SDK-free OTLP export, job id = trace id
- `src/lib/cost.ts` + `usage.ts` — per-job spend, reported to argo
- `lightpanda/` — the rendering sidecar, its own Dockerfile and deploy workflow

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
