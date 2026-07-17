# research-gateway — PRD

> **Status:** grilled, decided. Greenfield. Ready for `/ralph setup`.
> All original open questions are resolved in the **Decisions** log below.

## Why

Research logic today lives **only** inside the sideclaw `/research` MCP tool — so only
Claude Code can use it, and only on the Mac Mini (it's a `claude -p` worker driven by a
markdown prompt that shells out to providers via the local LiteLLM bridge). Hermes and
any other chatbot can't reach it. We want **one research brain**, hosted on the VPS,
callable by every client (Claude Code, Hermes, future chatbots, any machine), with
provider keys centralized server-side.

This service **consolidates and replaces** sideclaw's `research` tool — once it's live,
the sideclaw `research` handler + skill prompt are retired (mirrors how `implement` was
retired in favour of the native `@implementer` subagent).

## What it is

A small standalone HTTP service — **`research-gateway`** — on the VPS, exposing a typed
OpenAPI contract. It is **not** a fixed pipeline: it is an **agentic research service**.
An agent runs a multi-step, tool-calling loop — it decides which providers to call, goes
deeper when unknowns surface, cross-verifies, and stops when confident — bounded by a
hard budget ceiling. The agentic loop lives here **once**; clients just call it.

This is a deliberate architecture change from the thing it replaces: the routing judgment
that today lives in an LLM-driven prompt is preserved as an LLM-driven loop (not rewritten
as deterministic code), because real research is non-uniform — every query needs a
different number of calls and depths.

## Architecture

- **Framework: Vercel AI SDK v6** (`ai@^6`, `@ai-sdk/openai-compatible@^3`). Chosen over
  Mastra: 4 deps vs 29, thin and stateless-agent-shaped, no workflow/memory/RAG batteries
  we don't need. (Researched, high confidence — Mastra is built on AI SDK anyway and can
  be introduced later if multi-agent/stateful needs appear.)
- **Loop:** ~~AI SDK `ToolLoopAgent` with a `stopWhen` budget (step count + token + wall-clock
  ceiling)~~ — **superseded 2026-07-17.** `generateText` (not `ToolLoopAgent`), and the single
  loop became **plan → parallel worker fan-out → synthesize**. The **"done tool" pattern** (a
  terminal tool with no `execute`) survives and is used at every stage. The *token* budget was
  removed: it summed each step's usage, but every step re-sends the conversation, so the sum grew
  quadratically and measured billed throughput rather than context size — it fired long before
  `maxSteps`, capping deep at ~13 steps of a configured 28. See `research-gateway-fanout-redesign`.
- **LLM: IU unified endpoint, called directly from the VPS** via
  `createOpenAICompatible({ baseURL, apiKey })`. The Mac-local LiteLLM bridge is
  unreachable from the VPS, so the gateway holds its own `IU_API_KEY` and talks to the IU
  gateway directly. **Resolved 2026-07-17:** both models are used — **DeepSeek-V4-Pro** leads
  (plan + synthesis), **DeepSeek-V4-Flash** runs the worker fan-out. Flash's tool-calling proved
  sufficient for the bounded extract-and-distill work a worker does, and it is faster; Pro's
  judgment is reserved for decomposition and synthesis.

## Tools (what the agent can call)

- **Context7** — curated library/framework docs. First-class: the dominant caller is the
  `research-first` "what's the current API/version of X" question, where curated docs beat
  web search. The agent reaches for it when the query is library-shaped.
- **Tavily search** — fresh keyword web search.
- **Fetch + readability extract** — default content extraction (`@mozilla/readability` or
  equivalent); escalates inside the tool to Tavily Extract when readability returns thin/
  empty content. Heavier extractors (Jina/Firecrawl) only if a real gap shows.
- **Exa** — neural recall. **Deferred:** start Tavily + Context7; add Exa when recall gaps
  appear on real queries.

## Contract

- **`POST /research`** — submit. Body `{ query, depth? }`. Returns `{ jobId, status }`
  immediately (async — agentic runs take tens of seconds to minutes; the old `<30s` sync
  target is dropped).
- **`GET /research/:jobId`** — poll. Returns `{ status, result? }`; `result` on `done`.
- **Auth: bearer token** (the service holds provider keys + LLM access — must not be open).
  Single shared token v1; per-client tokens deferred.
- **Result shape:** `{ report, citations[], sources[] }` — `report` is the narrative cited
  answer, `citations[]` ties claims to source URLs, `sources[]` is the deduped URL list.
  (New shape; clients are updated to it rather than preserving the old sideclaw
  `findings/confidence` schema.)

## Depth & budget (hybrid)

- `depth` is an **optional hint** from the caller (`quick | standard | deep`). It scales the whole
  profile: worker count, gap-filling rounds, steps, context guard, search depth, and timeouts.
- The agent self-determines depth **within** a profile, bounded by max steps, a **context-size**
  guard (the last step's real input size — not a cumulative sum), and wall-clock. **Ceilings no
  longer cut a run off empty-handed:** `prepareStep` forces the done-tool *before* any ceiling, so
  a run banks its result. Timeouts are deliberately generous safety nets — hitting one costs a
  whole job, and the endpoint's throughput varies ~2.5x run to run.
- **Search depth is profile-driven, not model-chosen.** When exposed as a tool parameter the model
  downgraded to `basic` and halved the sources a `deep` pass found.
- Two concurrency caps: `RESEARCH_MAX_CONCURRENCY` (jobs) and `WORKER_MAX_CONCURRENCY` (workers
  within a job) protect the single IU backend from stampede.

## Stack & deploy

- Elysia + Bun (matches argo), `@elysiajs/openapi` for the typed contract, bearer
  `authGuard` (argo's `onTransform`/`as: 'scoped'` pattern).
- Two-stage `oven/bun` Dockerfile (argo pattern). Public subdomain behind **Cloudflare
  Tunnel**; Caddyfile/DNS entry; deployed via **rollhook** (label-driven, OIDC, zero-downtime).
- Secrets via 1Password `op://` refs → gitignored `.env` (`op inject`, the argo-on-VPS
  pattern): `TAVILY_API_KEY`, `IU_API_KEY` (+ `IU_BASE_URL`), the gateway bearer secret,
  `EXA_API_KEY` (later). Context7 needs no key.
- **Job store:** in-memory v1 (jobs are short-lived). Caveat: rollhook's brief 2-replica
  overlap during a rolling deploy means an in-flight job's poll could miss — acceptable for
  v1; revisit with a shared store only if it bites.

## Telemetry

Report LLM + provider spend **directly to argo `POST /usage/records`** with a bearer token,
as a new `source: "research-gateway"`. (It is *not* a usage-tracker "collector" — collectors
read **local** artifacts on the Mac; a VPS service can't be one.) Add IU DeepSeek model
rates to central pricing if missing.

## Clients & migration order

1. Build gateway (verify IU reachability from the VPS first — see Risks).
2. Cut **Claude Code** `/research` skill over to curl the gateway (async submit + poll).
3. Wire **Hermes** research tool → gateway (direct HTTP, no Argo proxy).
4. Retire the sideclaw `research` tool + handler + skill prompt.
- **Other chatbots / machines** → plain bearer HTTP.
- **MCP shim** → thin adapter over the same endpoint, added later *only if* an MCP-only
  client needs it. HTTP is the foundation; MCP is not.

## Decisions (resolving the original open questions)

| Question | Decision |
|-|-|
| Deep tier? | **No separate endpoint.** Adaptive agentic loop + `depth` hint *is* the depth mechanism. |
| Direct vs Argo-proxied (Hermes) | **Direct** HTTP. Argo proxy optional later. |
| Extraction escalation | readability default → **Tavily Extract** fallback on thin/empty content; heavier extractors only on real gaps. |
| Flash vs Pro | **Pro** drives the loop (tool-calling quality). Re-evaluate Flash as a cost optimization after measuring. |
| Exa now or later | **Later.** Tavily + Context7 first; add Exa on recall gaps. |
| Auth model | **Single shared bearer** v1; per-client tokens deferred. |
| Caching | **Deferred.** Optional TTL cache on `(query, depth)` later if repeated agent calls justify it. |
| Pipeline vs agentic | **Agentic** (AI SDK `ToolLoopAgent`), not deterministic. |
| Delivery | **Async job** (submit → jobId → poll). |
| Framework | **Vercel AI SDK v6**, not Mastra. |

## Risks / pre-build verification

- **IU endpoint reachability from the VPS** is a *gating assumption* — verify the IU gateway
  is publicly reachable with `IU_API_KEY` (cloud URL, not VPN/localhost-bound) before
  building the agent core. If not reachable, the LLM-path decision reopens.
- **Loop-driver tool-calling quality** — agentic research is only as good as the model's
  multi-step tool use. Validate DeepSeek-V4-Pro on real multi-tool queries early; a weak
  tool-caller turns "adaptive" into "expensive flailing."
- **Runaway cost** — the budget ceiling (steps/tokens/wall-clock) is load-bearing, not
  optional, since anything with the bearer token can trigger a loop.

## Non-goals (v1)

- No deterministic pipeline, no separate `/research/deep` endpoint.
- No Exa, no MCP shim, no per-client tokens, no query caching, no streaming (async poll only).
- No conversational/multi-turn research memory — stateless request → report.
- No Argo proxying for clients.
