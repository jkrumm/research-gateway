# Architecture review — 2026-09

A fresh-eyes challenge of the whole service, written 2026-09-25, two days after the move to the
mini. Every number below is from production telemetry or a live job run that day; research
facts came from this gateway itself (three dogfooded jobs, cited where used).

## 1. Verdict

The engine is the right shape and should not be swapped: plan → parallel workers → synthesize,
with the retrieval ledger at the tool boundary, is exactly what the open-source field converged
on, and nothing surveyed (pi, DBOS, Inngest, Temporal, Absurd, the open deep-research repos)
buys enough to justify a rewrite. What is **not** mature is everything that tells you whether an
answer is good. Since 2026-09-23 the `partial` rate went from ~13% to 66–92%, nobody noticed for
two days, and the cause is a grounding heuristic that now caps most citations of every large
report to `low` (148 of 182 citations on one deep job run for this review, 30 of 37 and 16 of 38 on two others — all three `partial`) — so
`partial` has stopped meaning anything to a consumer. There is no answer-quality eval at all;
`scripts/bench.ts` measures cost and citation *counts*, not correctness. The next month should
go to the quality signal and a golden-set eval, then to simplifying operations: retire the VPS
instance, add a CLI door, keep results longer. Durable execution and an agent-harness engine are
explicitly not worth doing now.

## 2. The nine points

| # | Point | Recommendation | Why | Cost | Risk |
|-|-|-|-|-|-|
| 1 | Stability / client contract | **The `jobId` is the durable handle; every door is a resumable read of it.** Keep results 7 days in sqlite (not 30 min), keep memory for running jobs only; let a client-supplied `idempotencyKey` make a retried submit return the same job. | The "annoying after redeploy" symptom is Claude Code's MCP client, not the server: a server unreachable at **session start** leaves its tools missing for the whole session (no auto-retry); mid-session drops get 5 reconnects over ~31 s, then it is marked failed ([code.claude.com/docs/en/mcp.md](https://code.claude.com/docs/en/mcp.md), Automatic Reconnection). A VPS rollout or the mini's 2026-09-24 01:05 DNS outage both hit that. Meanwhile `JOB_TTL_MINUTES=30` deletes a finished result 30 min later, so a wait lost to a closed session is unrecoverable. | S — TTL + memory eviction + one optional field | Low; sqlite growth is ~50–100 KB/job, trivial |
| 2 | MCP vs CLI vs skill vs direct call | **Several doors, one engine.** Keep MCP as the primary door for Claude Code (it drives active use, and calls >2 min auto-background with no model turns). Add a `research` CLI over the REST door, modeled on `sideclaw/bin/sideclaw.ts` (submit, wait with transport-retry backoff, `--json`, exit codes). Update the global `/research` skill to name the CLI as the fallback when the MCP tools are missing. | The CLI has no session state, so it is immune to every failure mode in row 1, and it is the door Codex, OpenCode, Hermes, cron and scripts actually want (today each hand-rolls curl + poll). "Direct function calls" (importing `runResearch`) is rejected: it drags the engine's secrets, binaries and sidecar into every caller — `scripts/smoke.ts` already covers the one legitimate use. A skill is instructions, not a door. | S — ~150 lines + tests | Low |
| 3 | Durable execution | **No framework. Keep status-only durability; add per-round checkpointing only if a trigger fires** (below). | Every candidate needs infrastructure this service does not have, and none resumes the expensive part. DBOS TS is **Postgres-only** (SQLite PR #1288 open and idle since 2026-08-12), officially Node ≥20, with no Bun job in CI. Inngest's server is SSPL and runs each step as an HTTP request. Temporal workers are officially Node-only (Bun "experimental"). Absurd (0.5.0) is Postgres + `pg`, 0.x, no Bun mention. pg-boss supports Bun but retries whole jobs with no steps. **All of them re-execute an in-flight step from its start** — and the steps here are minute-long LLM calls, so resume saves only completed rounds. The problem it would solve is already near zero: 31 drains since 2026-09-08, `remaining > 0` in none; idle-gated deploys never interrupt a job; reaps in 30 days were one VPS OOM (11 jobs, 2026-09-04) plus 19 reaped-on-read. Trigger.dev v4 could not be verified (the research run retrieved nothing on it). | none now; ~300–400 LOC if triggered | Checkpointing touches `run.ts` + ledger serialization — the grounding boundary |
| 4 | Deployment simplicity | **The poller already is the minimal model** — it runs only pushed commits from a separate clone, restarts only when idle, restarts only what the diff touched, and writes the marker only after the new process answers. What makes deploys feel heavy is that there are **two** systems (rollhook + CI + image on the VPS, the poller on the mini). Retire the VPS instance after a 14-day soak; deploy then means "push". | "Not compiled, so why deploy": because new code needs a restart, and a restart must not land mid-job. That is the poller's whole job, and it needs nothing else. `bun --hot` in production is rejected — it would reload modules under running jobs. A GitHub webhook is rejected — it needs an inbound path the poller does not. | S for the retirement (vps repo compose, Kuma HTTP monitors, warden docker rows, the rollhook workflow) | Low once soaked; lose the fallback — acceptable, the mini is where every consumer runs |
| 5 | Brain scope | **Widen by allowlist, not denylist**: `wiki/`, `Projects/`, `Areas/`, `Inbox/` — minus `Areas/Health/`, `wiki/health/`, `Areas/Finance/`, `wiki/finance/` (and a per-note `research: false` frontmatter opt-out). Journal exclusion by path (`log.md`, `02_Daily/**`, `journal/**`, `09_Templates/**`, exact `YYYY-MM-DD.md`) **and** by frontmatter (`type`/`tags` matching journal, daily or diary), so a future journal is excluded wherever it lands. | There is no journal in the vault today: `02_Daily/` and `journal/` were deleted in git, and `log.md` is the only thing the vault calls a journal. The real privacy issue is elsewhere: **every brain note a worker reads goes to the IU endpoint — the employer's LLM gateway — and `wiki/health/` (24 notes incl. `labs/`, `peptides/`) is already in scope today.** Prompt injection is the second-order risk: a fetched page can steer a worker to put brain text into a `searchWeb` query, which reaches Sonar (via IU) or Tavily. It cannot be fully prevented in a prompt; the scope boundary is the control. | S — the realpath scope check generalizes to a root list | Medium — privacy; see the one open question |
| 6 | Karakeep | **Yes, folded into `brainNotes`, not a new tool** — "has the owner already looked into this" covers both. `GET /api/v1/bookmarks/search?q=` (Meilisearch full-text over crawled content) + `GET /bookmarks/{id}/highlights`, bearer key, tailnet-only, reachable from the mini. A bookmark cites its **original URL** only if the ledger records the archived copy as a dated snapshot (same "true as of its date" rule the brain notes got in `a70c50e`); otherwise it cites the Karakeep URL. | Curated reading with highlights is a high-signal source, and the owner's bookmarks are less sensitive than the vault. The tool-count rule (definitions are re-sent every step of every worker) forbids an eleventh tool. There is no client code to reuse — only curl recipes in `hermes-agent/skills/karakeep/SKILL.md`. Its own dedicated key belongs in a mini-only overlay that starts the instance degraded if absent, like the GitHub PAT. | M — ~1 day incl. the two-live-run ledger check (`docs/decisions.md` standing rules) | Low |
| 7 | GitHub token | **Push it — this week.** | Measured today, not theoretical: the survey job's `githubRepo` "returned HTTP 403 (rate-limited) on repeated attempts", and the DBOS job logged 6 `api.github.com` 403s. 60 req/h per IP is shared by every worker of every job; one deep job exhausts it. `/health` reports `degraded: ["github"]` right now. Seeding is `make secrets-seed` on the MacBook once the item exists. | XS | None |
| 8 | pi as the engine; OSS research agents | See §2a. **Do not adopt pi as the engine.** Borrow two ideas from the OSS field, not code. | see §2a | — | — |
| 9 | Maturity | **The gap is quality observability, not infrastructure.** In order: (a) fix the subject-degrade over-firing and make `partial` mean "evidence lost" again; (b) alert on the daily partial rate; (c) a golden-set eval; (d) an in-process run test with a fake model; (e) fix the deep-synthesis fallback. | Details in §2b. The 576 unit tests are good and cover the grounding invariant; nothing covers whether an answer is right, and nothing alerted when the headline quality flag broke. | M overall | Low — all additive |

### 2a. pi, and what the open-source field offers

**What pi is today.** `badlogic/pi-mono` now redirects to `earendil-works/pi`; the packages
moved from `@mariozechner/*` (deprecated at 0.73.1, 2026-05-07) to `@earendil-works/*`,
0.87.1 on 2026-09-22 — about 20 releases in the seven weeks before that. MIT. It embeds
in-process ("embeds Pi in a Node.js or Bun process") via `createAgentSession` from
`@earendil-works/pi-coding-agent`, or the bare `Agent` loop from `@earendil-works/pi-agent-core`;
ESM-only, `engines.node >= 22.19.0`. Extensions get `pi.on("tool_call")` (can block, can mutate
input), `pi.on("tool_result")` (can rewrite `content`/`details`/`isError` before the model sees
it) and `pi.registerTool(...)`. Fan-out exists only as the `subagent` **example** extension:
at most 8 tasks, 4 concurrent, each a child `pi --mode json -p` process. Whether it takes an
arbitrary OpenAI-compatible endpoint (the IU endpoint) could not be verified — the run
retrieved the provider docs but extracted nothing from them.

**The previous objection does not hold as stated — but the conclusion does.** "A harness runs
the tool loop inside itself, so we lose the choke point" is wrong for pi, and was never quite
the real constraint anyway: the ledger records inside *our* tools' `execute`, and the two
grounding gates run on the worker's submitted digest and on the job's report — both outside
any loop. Any harness that runs our custom tools and hands back the final structured output
keeps the invariant. So grounding is not the reason. The reasons not to adopt it are:

- **It buys nothing the engine lacks.** Strip pi's coding-agent parts (file tools, sessions,
  settings dirs, resource loader) and what is left is `pi-agent-core`'s loop — the same thing
  as `generateText` + `stopWhen` here, minus what this code depends on: `prepareStep` forcing
  the done-tool in-loop via `activeTools`/`toolChoice`, the last-step context guard, per-role
  output budgets as middleware, the salvage path. Each would be rebuilt against a less-known API.
- **Its fan-out is worse.** Process-per-subagent with a 4-way cap, against in-process workers
  that share one ledger merge, one spend meter and one trace.
- **Churn.** A 0.x API renamed in May and released every few days is a maintenance tax on a
  service whose selling point is being boring. For comparison, LangChain's `open_deep_research`
  — the most-cited orchestrator — was archived on 2026-08-21.

**What the open-source field offers is ideas, not a dependency.** The surveyed projects split
into framework orchestrators (LangChain ODR, GPT Researcher, STORM, Together), minimal loops
(Jina `node-DeepResearch`, `dzhng/deep-research`) and trained models (Tongyi DeepResearch
30B-A3B, MiroThinker, WebThinker). This service's plan → parallel workers → compressed digest
→ synthesize is the same shape as LangChain ODR's supervisor + compression stage, and its
code-side citation ledger is stricter than anything the survey could confirm elsewhere (it
could not find a post-hoc citation verifier in any of them). Two things are worth borrowing:

1. **Ship an eval with the engine.** GPT Researcher keeps `evals/` in-repo — a SimpleQA-style
   accuracy eval plus a hallucination eval, tracking accuracy, cost, latency and source
   coverage; Together self-evaluates on 50-item slices of FRAMES, SimpleQA and HotPotQA with an
   LLM judge. Small, versioned, run on every change — that is Phase 2 below.
2. **A trained research model as a future worker, not an engine.** Tongyi DeepResearch is an
   open 30B-A3B model trained for exactly this loop; if the IU endpoint ever serves one, it
   drops in as `IU_WORKER_MODEL` behind the golden set, with no architectural change.

### 2b. The maturity gap, concretely

**The partial signal is broken.** Code (`src/agent/ground.ts`): a run is `partial` if any
citation was dropped, *or any citation was subject-degraded*, or nothing was retrieved, or
failures outnumber retrievals. From 2026-09-14 to 09-25: 56 partial / 57 ok; by day
09-20..22 13%, 09-23 66%, 09-24 92% (VPS and mini alike, so not a mini effect). ~80% of those
partials had `citationsDropped = 0` and no retrieval failure — i.e. they flipped on the
subject-degrade gate alone. The three jobs run for this review show why:

| Job | citations kept | capped by subject gate | status |
|-|-:|-:|-|
| OSS deep-research survey (standard) | 37 | 30 | partial |
| pi survey (standard, 0 failed fetches) | 38 | 16 | partial |
| durable-execution survey (deep) | 182 | 148 | partial |

The gate caps a citation to `low` when ≥2 distinctive tokens of an `unverified` entry's topic
appear in the claim. It was designed around short topics ("Module:Items wiki page"). The
current model writes long, enumerating `unverified` topics with `url: null` — e.g. "Cross-project
citation-grounding mechanics … for GPT Researcher, STORM, smolagents, Jina, dzhng, Together and
Tongyi" — and any claim naming two of those projects matches. A retrieved, correctly-cited
README claim ends up `low` and the whole report is bannered "evidence was lost", which is
false. The fix is a coverage ratio (the claim must share most of the subject, not two tokens
of a 30-token enumeration) plus not letting a confidence cap alone flip `status` — `status`
should mean evidence was lost, and the banner already says exactly that. This touches the
grounding invariant, so it goes through `ground.test.ts` with the real cases as fixtures.
`citationsDegraded` (commit `c862d5a`) makes the cause countable from now on.

**No answer-quality eval.** `bench.ts` measures cost, citations and pages; `docs/measurements.md`
shows a 10% citation-count effect costs ~80 h and $76 to resolve, and none of it says whether
the answer was *right*. A golden set is cheap because correctness is checkable in code for the
questions this service is mostly asked: pinned versions, release dates, API signatures, EOL
dates, "does X support Y". ~20 questions with expected answers (regex/substring), mostly
`quick`/`standard`, ≈ $2 per run, scored on answer correctness, citation precision (does the
cited page's retrieved text contain the claim — a judge call over the ledger's own text, no
extra fetch), and `ok` rate. Run after every model or grounding change and weekly. The public
benchmarks (SimpleQA-Verified, FRAMES, BrowseComp) exist and small subsets are how GPT
Researcher and Together self-evaluate, but the survey could not verify their licenses or
harness details — an owner-derived set is the faster, more relevant start; add a 50-item
SimpleQA-Verified slice later if a public number is wanted.

**Deep synthesis falls back silently.** 2 of 22 mini jobs ended `reason: "assembled"`
(`synthesis.rejected: no valid submit_report call`) — including the deep job for this review,
whose report shipped with the workers' raw sub-question prompts as section headings. The
fallback is the keystone and must stay; the headings and the rejection rate are the defects.

**Nothing alerts on quality.** The five HyperDX alerts cover reaps, job errors, LLM failures,
memory and drains. A daily partial-rate alert (e.g. > 30% over ≥ 5 jobs) would have caught
2026-09-23 the same day.

**Orchestration is untested by design** (anything importing `env.ts`). An in-process run of
`runResearch` against the AI SDK's mock language model with scripted tool calls would pin the
plan → round → synthesis → fallback → grounding flow without secrets.

## 3. Target architecture

```
 Claude Code ──MCP /mcp──┐                          (mini, LaunchAgents)
 Codex/OpenCode/cron ─┐  │   ┌──────────────── research-gateway (Bun/Elysia) ────────────────┐
 Hermes, scripts ─────┴─CLI/REST──► admission ─► job store (sqlite: status + result, 7 d)    │
                              │        │                                                    │
                              │        ▼                                                    │
                              │   plan ─► workers ×N ─► synthesize ─► consistency ─► ground  │
                              │             │ tools: searchWeb · fetchPage chain ·           │
                              │             │ lookups · brainNotes (vault allowlist +        │
                              │             │ Karakeep)          ▲ retrieval ledger gates    │
                              └─────────────┴──────────────────────┴──every citation─────────┘
   deploy: push → 2-min poller → idle gate → restart touched units → health proves new pid
   quality: golden-set eval (weekly + on change) · partial-rate alert · citationsDegraded
```

One instance, one deploy path, two client doors onto one REST/MCP surface, one engine.

**Explicitly not worth doing**

- A durable-execution framework (DBOS, Inngest, Temporal, Absurd, pg-boss) or a split into
  front door + queue + worker processes on one host — new stateful infrastructure to resume
  completed rounds of a job that deploys already never interrupt.
- Replacing the engine with pi, OpenCode or any agent harness (§2a).
- MCP Tasks — the SDK has no runtime for it (README § What an MCP client has to configure); auto-backgrounding
  already delivers the benefit.
- A second instance for availability; hot reload in production; a webhook-driven deploy.
- An eleventh tool (Karakeep goes into `brainNotes`).
- Tuning anything whose effect is under ~20% before the golden set exists.

## 4. Phased plan

Each phase ends with something measured, not just merged.

**Phase 0 — done 2026-09-25.** `citationsDegraded` on the report, the `research.ground` span and
the `research.done` log line (`c862d5a`).

**Phase 1 — restore the quality signal (start here).**
1. Fixtures: add the two over-firing cases from this review to `src/agent/ground.test.ts`
   (a retrieved README claim vs a long `url: null` enumeration topic → must stay un-degraded;
   the existing Module:Items case → must still degrade).
2. `degradeClaimsOnUnverifiedSources`: require the shared tokens to cover a majority of the
   subject's distinctive tokens (keep the ≥2 floor), so an enumeration is not a subject.
3. `groundReport`: `status: 'partial'` only on lost evidence (dropped citations, nothing
   retrieved, failures > retrievals); a degraded citation keeps its `low` cap and warning but
   no longer flips the status or the "evidence was lost" banner.
4. HyperDX alert: daily partial share > 30% over ≥ 5 `research.done` rows.
5. Seed the GitHub PAT (`op://vps/research-gateway/GITHUB_TOKEN`, already in `headless.refs`).
6. Verify: re-run the two review queries; partial rate on the dashboard back under ~20% over
   the following 3 days; `degraded` gone from `/health`.

**Phase 2 — golden-set eval.** `evals/golden.jsonl` (~20 owner-relevant questions, expected
answer patterns), `scripts/eval.ts` over the REST door, a results table appended to
`docs/measurements.md`, a weekly run. Baseline it before any further model or prompt change.
Fix the assembled-report headings and look at the synthesis rejection rate here, measured
against the baseline.

**Phase 3 — client contract.** Result retention 7 d (sqlite; memory holds running jobs only),
optional `idempotencyKey` on submit, the `research` CLI, the `/research` skill naming the CLI
as its fallback. Verify: kill the gateway mid-`job_wait`; the CLI resumes and gets the result.

**Phase 4 — one instance.** After 14 days without a mini incident: retire the VPS instance
(vps repo compose + `.env.tpl`, Kuma HTTP monitors, warden docker rows, rollhook workflow),
then trim the VPS-only drain/cgroup/rollhook material from README and AGENTS.md.

**Phase 5 — sources.** Brain allowlist per §2 row 5 (after the owner's privacy call), then
Karakeep inside `brainNotes`, each with two live runs whose citations survive the ledger.

**Deferred, with the trigger that reopens it**

| Item | Reopen when |
|-|-|
| Per-round checkpoint/resume in sqlite | > 2 reaped jobs/week on the mini for two weeks, or deep jobs routinely > 30 min |
| Engine or harness swap | the golden set shows a quality ceiling the current loop cannot move |
| Public benchmark slice | a comparable external number is actually needed |
