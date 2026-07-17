# research-gateway

One research brain, hosted on the VPS, callable over a typed HTTP contract by every client on
the tailnet (Claude Code, Hermes, any tailnet machine) — it is **Tailscale-only**, not exposed to
the public internet. A lead model decomposes the query into independent sub-questions, a fan-out
of **parallel workers** researches them (Tavily search + page fetch + curated library docs) and
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
- **Tools:** Tavily search, fetch + `@mozilla/readability` (→ Tavily Extract fallback on thin
  content), Context7 curated docs (optional — only when `CONTEXT7_API_KEY` is set).

## Contract

| Endpoint | Auth | Body / Params | Returns |
|-|-|-|-|
| `GET /` | public | — | discovery (links to `/openapi`) |
| `GET /health` | public | — | `{ status: "ok" }` |
| `POST /research` | bearer | `{ query, depth? }` (`depth`: `quick \| standard \| deep`) | `{ jobId, status }` (async) |
| `GET /research/:jobId` | bearer | — | `{ status, result?, error? }` |

`result` shape: `{ report, citations: [{ claim, url }], sources: string[] }` — `report` is the
narrative cited answer, `citations` ties claims to URLs, `sources` is the deduped URL list.

Runs are **async**: submit returns a `jobId` immediately; poll `GET /research/:jobId` until
`status` is `done` (agentic runs take tens of seconds to minutes). A global concurrency cap
(`RESEARCH_MAX_CONCURRENCY`) protects the single IU backend.

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
| `TAVILY_API_KEY` | yes | search + extract. Credits are hard-limited — a deep job costs ~120 |
| `CONTEXT7_API_KEY` | no | enables the `libraryDocs` tool when set. Free, and the best source for library questions |
| `ARGO_USAGE_URL` / `ARGO_API_SECRET` | no | telemetry → argo `POST /usage/records`; no-op if unset |
| `RESEARCH_MAX_CONCURRENCY` | no (3) | concurrent *jobs* |
| `WORKER_MAX_CONCURRENCY` | no (8) | concurrent *workers within one job* |

## Telemetry

Each job reports LLM spend to argo `POST /usage/records` as `source: "research-gateway"`,
`billing: "iu"` — **two records per job**, one per model bucket (`sub_tool: lead | worker`), since
the two run on different models. argo upserts on `(source, source_id, machine)`, so `source_id` is
scoped `${jobId}:lead` / `${jobId}:worker` or the second would overwrite the first. `cost_usd` is
cache-aware: the endpoint bills a cache-read ~30x below a miss, and the fan-out sustains a ~60%
hit rate, so billing all input at the miss rate overstates cost several-fold. Telemetry failure
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
