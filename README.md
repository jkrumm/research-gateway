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
    Tavily as the per-call fallback), plus fetch + `@mozilla/readability` (→ Tavily Extract
    fallback on thin content), for everything the lookups cannot answer. See
    [Web search backend](#web-search-backend).
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
status, warnings, grounding }` — `report` is the narrative cited answer, `citations` ties
claims to URLs, `sources` is the pages actually read, `unverified` is what could not be
checked, and `status` / `grounding` are the code-counted evidence accounting.

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

| | Sonar (`low`/`medium`/`high`) | Tavily (`basic`) |
|-|-|-|
| Cost per search | $0.005 / $0.008 / $0.012 | ~1 credit ($0.005–0.008) |
| Sources returned | 18–20 | 5 |
| Publication dates | on every result | none |
| Latency | ~2.0–2.3s | ~1.9s |
| Billed to | the IU work key | the personal Tavily plan |

Two properties of this route are load-bearing and were established by probing, not from docs:

- IU exposes Sonar as `owned_by: "Perplexity direct"` — a **real passthrough**. `citations` and
  `search_results` sit outside the OpenAI-standard `choices` array, and normalizing gateways
  drop them (LiteLLM #5313/#13777, Portkey's strict-compliance mode, API7). Here they survive.
  If that ever changes, `search_results` comes back empty; `sonar.ts` treats an empty result set
  as a failure precisely so the Tavily fallback engages instead of the worker being told the web
  has nothing.
- `usage.cost` carries Perplexity's own per-call USD, which is why this is the one backend whose
  telemetry can report real money (see below).

**Sonar's synthesized answer is discarded.** It is an answer engine and it does hallucinate
under confidence; letting that prose into a worker's context would launder Perplexity's
assertions into the report attached to URLs we never retrieved. Only the URLs and snippets are
kept, and they enter the ledger at the `snippet` tier like any other search hit — so nothing
Sonar asserts can be cited as verified. `max_tokens` is pinned at 16 (the API's floor; it 400s
below that) to pay for as little discarded generation as possible.

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
