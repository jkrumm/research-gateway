# research-gateway

One research brain, hosted on the VPS, callable over a typed HTTP contract by every client on
the tailnet (Claude Code, Hermes, any tailnet machine) — it is **Tailscale-only**, not exposed to
the public internet. It is **not** a fixed pipeline — an agent runs a
multi-step, tool-calling loop (Tavily search + page fetch + curated library docs), decides how
deep to go, cross-verifies, and stops when confident, bounded by a hard budget ceiling.

Consolidates and replaces the sideclaw `/research` MCP tool, with provider keys centralized
server-side. See [`PRD.md`](./PRD.md) for the full rationale and decisions.

## Stack

- **Elysia + Bun**, `@elysiajs/openapi` typed contract, bearer `authGuard` (argo patterns).
- **Vercel AI SDK v6** (`ai@6`) — a `generateText` tool loop with `stopWhen` (step + token +
  wall-clock ceilings) and the **done-tool pattern** (`submit_report`, a terminal tool with no
  `execute`, whose input is the final structured report).
- **LLM:** IU unified endpoint, called directly via `@ai-sdk/openai-compatible`. Loop driver:
  DeepSeek-V4-Pro.
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

`bun run dev` needs the 1Password CLI (`op`, account `tkrumm`). Fill in / verify the `op://`
refs in `.env.local.tpl` first — they are inferred from argo's conventions.

```bash
bun run typecheck  # tsc --noEmit (strict)
```

## Environment

| Var | Required | Notes |
|-|-|-|
| `PORT` | no (7780) | listen port |
| `API_SECRET` | yes | the gateway's own bearer token |
| `IU_BASE_URL` / `IU_API_KEY` | yes | IU unified endpoint |
| `IU_MODEL` | no (`DeepSeek-V4-Pro`) | loop-driver model |
| `TAVILY_API_KEY` | yes | search + extract |
| `CONTEXT7_API_KEY` | no | enables the `libraryDocs` tool when set |
| `ARGO_USAGE_URL` / `ARGO_API_SECRET` | no | telemetry → argo `POST /usage/records`; no-op if unset |
| `RESEARCH_MAX_CONCURRENCY` | no (3) | concurrent-run cap |

## Telemetry

Each run reports LLM spend directly to argo `POST /usage/records` as `source: "research-gateway"`,
`billing: "iu"`, with `cost_usd` computed from DeepSeek rates. Telemetry failure never fails a job.

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
