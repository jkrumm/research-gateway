# Decisions

The settled calls, each with what superseded it. The README describes the system as it is; this
file is why it is that way and which earlier answer was replaced. The pre-build PRD
(2026-07-17, "grilled, decided") was folded in here once every one of its open questions had
a measured answer — most of them a different answer than the one it shipped with.

## Why this service exists

Research logic used to live only inside the sideclaw `/research` MCP tool — a `claude -p`
worker driven by a markdown prompt, reachable only from Claude Code on the Mac mini. Hermes and
any other client could not use it. One research brain on the VPS, callable by every client with
provider keys centralized server-side, replaced it; the sideclaw `research` handler and skill
prompt were retired (the same way `implement` was retired for the native `@implementer`).

It is **agentic, not a pipeline**: a model decides which providers to call, goes deeper when
unknowns surface, cross-verifies, and stops when confident — bounded by hard ceilings. Real
research is non-uniform; every query needs a different number of calls and depths.

## The decision log

| Question | Decision | Superseded / refined by |
|-|-|-|
| Framework | **Vercel AI SDK**, not Mastra — 4 deps vs 29, thin and stateless-agent-shaped | started on `ai@6`; now `ai@7` (`@ai-sdk/openai-compatible@3`). Its own OTel telemetry stays **off**: in v7 it records prompts and outputs by default |
| Loop | ~~`ToolLoopAgent` with a `stopWhen` budget~~ | **2026-07-17: `generateText` + `stopWhen`, and one loop became plan → parallel worker fan-out → synthesize** (see below). The done-tool pattern (a terminal tool with no `execute`, read from `result.toolCalls`) survives at every stage |
| Token budget | a cumulative per-step sum | **removed** — every step re-sends the conversation, so the sum grew quadratically and fired at ~step 9-13, making `deep` never deeper than `standard`. Now a context guard on the LAST step's `inputTokens` |
| LLM | IU unified endpoint, called directly from the VPS (the Mac-local bridge is unreachable there) | unchanged; the gateway holds its own `IU_API_KEY` |
| Models | DeepSeek-V4-Pro leads, V4-Flash works | → **Flash for both** once synthesis became the wall-clock long pole → **`gpt-5.6-luna` for both** (2026-08-20): 3-8x faster to first token, 100% tool-calling reliability, comparable reports; rationale and numbers in `src/env.ts` and modelpick |
| Depth | no separate `/research/deep` endpoint; the `depth` hint scales one profile (workers, rounds, steps, context guard, search depth, timeouts) | unchanged; **search depth is profile-driven, not a tool parameter** — the model downgraded to `basic` 42/75 times when it could choose |
| Search | Tavily | → **Perplexity Sonar over the IU endpoint** (2026-08-02): ~20 dated sources per call vs 5, billed to the work key; Tavily stays as fallback and the only Extract path. A dual-backend merge was built, measured, and turned off |
| Extraction | Readability → Tavily Extract on thin content; heavier extractors only on a real gap | → site adapters ahead of everything, a **self-hosted lightpanda sidecar** ahead of Tavily, Jina Reader **retired** (third party learning every URL read), Wayback as the last rescue, yt-dlp for YouTube |
| Exa | later, on recall gaps | never needed |
| Auth | single shared bearer, per-client tokens deferred | unchanged; the tailnet is the gate, the bearer is defense-in-depth, compared constant-time |
| Delivery | async job: submit → jobId → poll | unchanged; MCP `job_wait` blocks for the whole job (2026-09-08 — the old 50s cap was a guess at a transport budget that does not exist, and cost a model turn every 50s) |
| Job store | in-memory v1 | → **`bun:sqlite`, status-only durability, heartbeat-reaped** — a restart no longer 404s every job; a job caught mid-run comes back as a terminal `error`. Heartbeat, not "everything running at boot is dead", because rollhook's overlap runs two replicas on the same file |
| Caching | deferred TTL cache on `(query, depth)` | still deferred; the field notes' `context` parameter is the cheaper lever |
| Ingress | ~~public subdomain behind Cloudflare Tunnel~~ | **Tailscale-only**: grey-cloud A record → Traefik, same as argo / audio-gateway |
| MCP shim | "later, only if an MCP-only client needs it — HTTP is the foundation" | **the primary path.** Claude Code is the main client and speaks MCP; `/mcp` mirrors sideclaw's submit → wait → read contract |
| Telemetry | argo `POST /usage/records` as `source: research-gateway` | unchanged, grown to seven records per job; plus OTLP traces/logs to ClickStack, SDK-free |
| Grounding | (not in the PRD) | the retrieval ledger, after issue #1: a rate-limited run cited unfetched URLs at `high`. Code counts evidence; the model never asserts verification |

## The fan-out architecture (2026-07-17)

The old single-loop agent worked **33% of the time**: 67 prod jobs → 22 `submit_report`, 23
`salvaged`, **22 `fallback` with `citations: 0`**. It became `plan.ts` → `worker.ts` (N in
parallel) → `synthesize.ts` (digests only), orchestrated by `run.ts`. The non-obvious parts,
in the order they bit:

1. **The old token budget measured the wrong thing** (above). Deep was never deeper than standard.
2. **`prepareStep` replaced salvage entirely.** It returns `activeTools` + `toolChoice`, so the
   done-tool is forced *in-loop* before any ceiling. The old salvage replayed the whole context
   into a second call and could not have worked: 7-14k tokens needs 175-350s against a
   90/180s ceiling.
3. **The deterministic fallback is the keystone — do not remove it.** If synthesis fails,
   `run.ts` assembles the report from digests (`assemble.ts`). `citations: 0` is unreachable
   while any digest exists. An anti-regression test exists.
4. **A missing `try/catch` on `searchWeb` was killing 60% of workers.** Any tool that can throw
   takes a worker down with it, and every digest it gathered — the highest-leverage invariant
   in the codebase.
5. **`openGaps` are fed back as the next round's sub-questions, so they must be QUESTIONS.**
   Workers wrote failure notes ("could not fetch X, paywall"), spawning workers to research a
   paywall.
6. **More searching is worse research.** 175 searches → 110 pages, 57 citations; 60 forced-
   `advanced` searches → 154 pages, 63 citations, $0.079. Pages-read predicts citations
   (r=+0.78); searches-issued only +0.52.
7. **Timeouts are safety nets, not budgets.** Throughput swings ~2.5x. Use `timeout: { totalMs }`;
   a bare `abortSignal` does not bound retries.
8. **Prompt-cache hits are worth ~30x** and were invisible (hardcoded 0) while the fan-out
   sustains ~60-68%. No `metadataExtractor` for cache tokens: the IU endpoint uses the OpenAI
   convention and the provider maps it natively.

## Standing rules that came out of it

- **Adding a source-of-truth API is cheap; adding a *tool* is not.** Definitions are re-sent
  every step, every worker, every job, against `workerMaxSteps` 5/7/9. Nine tools.
- **A new lookup is not done until a live worker's citations survive the ledger.** Run a real
  job, read `worker.ungrounded` and `grounding.citationsDropped`, and read the cited URLs.
- **`mem_limit` and `RESEARCH_MAX_CONCURRENCY` are one decision** (wedged at 512 MiB
  2026-08-06, OOM-killed at 1 GiB 2026-09-04).
- **The sidecar has no auth on purpose** — the private compose network is the control.
- **Modules importing `env.ts` are not unit-tested.** Factor pure logic out; do not mock env.
- **`proc.signalCode`, not `proc.killed`, says a spawn deadline fired** on Bun 1.3.
- **Never promote a fetch failure to a negative claim** (field notes, 2026-08-06) — the
  pipeline must not treat "we couldn't get it" as "it isn't there".

## Non-goals, still

No deterministic pipeline, no per-client tokens, no query caching, no streaming, no
conversational memory (stateless request → report), no Argo proxying for clients.
