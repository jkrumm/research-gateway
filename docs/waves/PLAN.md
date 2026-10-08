# Research-gateway hardening: faster, simpler, more useful reports

**Goal:** The gateway runs at or below the documented job durations again. Reports lead with the answer. `partial`/`unverified` mean real evidence loss. Fetching wastes no budget on guessed or duplicate URLs. The eval can catch these regressions. Docs match the code. Everything is deployed to the mini and verified live.

**Gate (every wave):**
- `make check` is green. If you touch `src/agent/ground.ts`, `tools.ts` or a tool, also run `bun test src/agent/ground.test.ts`, with no regression on issue #1's case.
- `/review` (sideclaw) findings are resolved or explicitly deferred in **Left behind**.
- One commit per logical concern, pushed to `master`. A push deploys via the CI-gated poller, and it waits for idle; that is expected and authorized for this plan.

**Mode:** orchestrated. A wave ends at its committed, pushed close-out and spawns nothing. The orchestrator tab reviews it and starts the next wave.

**Standing rules for every wave:**
- Read `AGENTS.md` first. `README.md` is the contract.
- **No wall-clock caps on LLM calls.** Only the idle watchdog applies; see `~/.claude/rules/agent-limits.md`. "Make it faster" means less work, not a timeout.
- Pure logic goes in env-free modules with tests. Never mock `env`.
- Simplify as you go. Delete what a change makes dead. Don't add speculative knobs.
- Update `AGENTS.md`, `README.md` and `docs/measurements.md` in the same commit as the code they describe.

## Evidence base (audit 2026-10-08, logs 2026-09-23..10-08, 161 jobs)

Sources: `~/Library/Logs/research-gateway.log` (JSON lines), `~/.research-gateway/data/jobs.sqlite`.

**Job durations against `docs/measurements.md`**

| depth | p50 | doc p50 |
|-|-|-|
| quick | 100s | 38s |
| standard | 362s | 111s |
| deep | 770s | 366s |

**Consistency pass (`consistency.done.ms`)**
- p50 119s, p90 387s, max 682s. The baseline was 2-7s, measured 2026-09-23 on gpt-6-luna at effort `none`.
- It takes 54-65% of quick and standard wall time.
- Output is 16-53k tokens per call. It corrected 58% of jobs, usually with 1-2 trivial edits.
- 16 `consistency.failed` events (500/503 after 3 attempts).
- The call has no role budget (`leadModel` in `src/lib/llm.ts`).

**DeepSeek probe (2026-10-08, IU endpoint, deepseek-v4.1-flash)**
- `reasoning_effort` `none` and `low` both STILL reason: about 175-230 reasoning tokens on a trivial prompt.
- A forced `tool_choice` is rejected at every effort ("Thinking mode does not support this tool_choice").
- So lowering effort is not a proven lever. Measure before relying on it.

**Synthesis**
- 6 `synthesis.rejected: no valid submit_report call` events: 5 of 17 deep jobs and 1 standard (jobs dcff3804, ce3f4889, 0b078279, 2b98691a, 0b08a22b, 4e36497b).
- These fall back to `assembled`: no summary, first-person process narration.
- Deep synthesis outputs run 36-65k tokens against `ROLE_BUDGETS.synthesis` of 32k.

**Partial rate**
- 22% overall: deep 65%, standard 24%.
- 22 of 35 partials were caused only by `scrubbed.annotated > 0` (`ground.ts` `degradedRun`). Typical triggers are a bare homepage mention (`https://www.bike24.de/`) or a sentence that already says "could not be read".
- Issue #7 is why scrub notes count as evidence loss. Keep that intent: an ASSERTION resting on an unverified source must still flag.

**Unverified lists**
- Up to 91 entries per job.
- They are padded with guessed-URL 404s and "page-text budget exhausted" housekeeping.

**Subject-match cap is over-strict**
- Citations are capped `low` when they share a subject with an unverified entry, even when a different retrieved page backs them.
- Examples: job 0bd2566e (9 of 52 capped) and job b9b24998 (15 of 61).

**Guessed URLs**
- 11% of fetches are `via:"missing"` (404): specialized.com 47, bike-discount.de 42, github.com 38.
- Workers construct product/doc URLs instead of using search hits.

**Duplicate fetches**
- 1,037 repeated (job, url) pairs against 6,204 unique.
- One URL was fetched 11 times in 7s (job d5a8ada9). A blocked thread was retried 11 times (job 8f011bff).
- No per-job single-flight exists.

**Locale**
- US/AU pages back German-market price claims at `high` (job b9b24998).

**Tool logging gaps**
- `githubRepo` fails 39% with no status/error logged.
- `ytdlp` shows 24× `Broken pipe`.

**Eval**
- Last run 2026-09-25, 20/20 passing. 18 quick lookups, 0 deep, no commerce/German/multi-part cases.
- It is saturated, so it cannot see any of the above.

**Already fixed (2026-10-08)**
- `7e93267`: human solve escalates to the dialog only on positive challenge evidence.
- `c4aaea3`: `JOB_TTL_MINUTES` default restored to 7 days.

## Wave 1 — Consistency pass: stop paying 2 minutes for 2 edits            <!-- status: done -->
- [x] Diagnose from the logs and spans where the 16-53k output tokens go: reasoning vs. the `submit_review` arguments. Check whether the reviewer echoes the whole report into `replace` spans. Record the finding in `docs/measurements.md`.
- [x] Give consistency its own role in `ROLE_BUDGETS` (`src/lib/llm-settings.ts`), sized from that measurement, and use it instead of the budget-less `leadModel`. Then remove `leadModel` / `effortProviderSettings` if they become dead.
- [x] Gate the pass so it runs only where a contradiction is possible:
  - Skip `quick`.
  - Skip reports built from a single digest or a single worker.
  - Pick a size floor from data.
  - Optionally add a cheap deterministic pre-check, but only if it is simple and tested.
  - Log the skip reason.
  - Fewer retries on a 5xx (`maxRetries`): a failed review is a no-op by contract anyway.
- [x] Shrink the work itself in `consistencyPrompt` (`src/agent/prompt.ts`): minimal `find` spans, no rewriting of unaffected text, an explicit "return consistent when nothing contradicts".
- [x] Retune `TYPICAL_DURATION_MS` (`src/agent/depth.ts`) and the `docs/measurements.md` job-duration and consistency sections to the expected new numbers. Mark them "to re-measure in Wave 6".
**Left behind:** Finding: the 16-53k tokens are reasoning, not echoed `replace` text (edits ~230 chars p50; clean verdicts still 21k p50) — recorded in `docs/measurements.md`. `reasoning_effort` stays untouched (not a proven lever). Shipped: `ROLE_BUDGETS.consistency` = 64k (a first 32k draft was caught in review as clipping ~50% of passes; truncated passes now log `outcome: truncated`), `leadModel`/`effortProviderSettings` deleted, `consistency-gate.ts` (skip quick / <2 digests / <6k chars, logs `consistency.skipped`), `maxRetries: 0`, minimal-span prompt. Gate is mostly a quick-depth win: standard/deep reports still pass it, so their saving rests on the prompt and is unproven. `TYPICAL_DURATION_MS` (45/300/700s p50) are estimates — re-measure in Wave 6 and check the `consistency.skipped`/`truncated` rates. Deferred review items: shared no-op review factory (skip path in `run.ts` duplicates the catch-path literal), fallow flags on `run.ts` complexity and the `run.ts`/`job-runner-core.ts` duplicate block and unused exports in `llm.ts` — Wave 5.

## Wave 2 — Synthesis: never ship the stitched dump, lead with the answer            <!-- status: done -->
- [x] Log WHY synthesis is rejected: finishReason, output tokens, text-only reply vs. a malformed tool call. Field: `synthesis.rejected`.
- [x] Recover before assembling. If the model replied with the report as plain text, or hit `length`, salvage or retry once with a compact target (the existing doubled-budget path in `llm.ts`/`synthesize.ts` covers `length`; extend it to the deep 36-65k reality). Re-check `ROLE_BUDGETS.synthesis` against measured deep outputs.
- [x] Make the `assembled` fallback (`src/agent/assemble.ts`) a usable report: a deterministic top summary from the digest summaries, and no first-person process narration lines.
- [x] Synthesis prompt: open with a short "Bottom line" that answers each sub-question in a sentence, then the detail. Set a per-depth length target (standard about 10k chars). Collapse "no presence / not found" negatives to one line each.
**Left behind:** Shipped: `synthesis-outcome.ts` (pure: classify reply as submitted / length / malformed-call / text-only / no-output / guard; prose salvage at 1.5k+ chars; compact-retry predicate) driving one `attempt()` helper in `synthesize.ts`, so salvage and the guard apply to every attempt. `synthesis.rejected` (reason, finishReason, outputTokens, textChars, toolCalls, next) now fires only on fall-back to `assembled`; intermediate failures log `synthesis.retry`. `ROLE_BUDGETS.synthesis` 32k to 64k (length retry doubles to 128k). `assembleReport` opens with a deterministic Bottom line and drops first-person sentences. Synthesis prompt: Bottom line, length target (quick 3k / standard 10k / deep 20k chars), collapsed negatives. Unproven until Wave 6: that rejections actually fall, and that the 64k/128k budget does not worsen the deep tail against `SHUTDOWN_DRAIN_MS` (review discussion item; re-check `synthesis.length` and deep wall time). Deferred: a smaller token cap on the compact retry (needs a per-call budget knob in `llm.ts`); the Bottom-line rule exists both in the prompt and in `assemble.ts` with no shared constant; the `synthesize` callback's fallow complexity is reduced but not re-measured (Wave 5 `/analyze`). Gate: `make check` green (1287 tests), `ground.test.ts` green.

## Wave 3 — Grounding signal accuracy: `partial` and `unverified` mean real loss            <!-- status: done -->
- [x] `body-mentions.ts` / `scrubBody`: do not annotate a bare-host mention with no path and no claim, or a sentence that already says the source could not be read or verified. Keep issue #7's case flagged: an assertion resting on an unverified source. Add fixtures for both directions.
- [x] Add a `partialCause` field to `research.done` (`dropped` | `scrubbed` | `no-pages` | `failures`) so the next audit does not have to infer it.
- [x] Subject-match cap: apply it only when the cited URL IS the unverified entry, or no retrieved page backs the claim. A different retrieved source must not be capped. Run `src/agent/ground.test.ts`; issue #1 must stay caught.
- [x] `unverified` hygiene: drop guessed-URL 404 entries and budget-exhaustion housekeeping unless a claim in the prose depends on them. Group the rest by topic.
**Left behind:** Shipped: scrub exemptions in `body-mentions.ts` (bare-homepage sentence with no figure/attribution verb; sentence saying unreadable/unverified and carrying no figure; the URL is stripped before the phrase test), `grounding.partialCause` (`dropped|scrubbed|no-pages|failures`, in schema, `research.done` and span), subject-cap skips a citation whose cited page was retrieved unless it is a copy of the unread document (`degradeClaimsOnUnverifiedSources` gets an optional `backed` predicate), `unverified-hygiene.ts` (drops ledger-`missing`/404 and budget housekeeping unless prose names the URL or it restates a dropped citation; groups by topic). Gate: `make check` green (1305 tests), `ground.test.ts` green incl. issue #1. Review finding on `isCopy` vacuous-true was wrong (`docPath.size > 0` guards it). Unproven until Wave 6: partial rate drop (baseline 22%, 22 of 35 scrub-only) and capped counts. Deferred: `restsOn` has 5 positional params (fallow CRAP flag) and `groundReport` is ~160 lines — Wave 5; `sentenceAround` rescans the prefix per match (O(M*L), small); `partialCauseOf` labels a 0-retrieved run with 404s+failures as `failures` not `no-pages`; no `unverified` `.describe()` change (model-facing schema).

## Wave 4 — Fetch efficiency: no guessed URLs, no duplicate fetches            <!-- status: active -->
- [ ] Per-job single-flight and cache in `fetchPage`: concurrent workers asking for the same URL share one chain run. Remember a per-job terminal "blocked" verdict per URL so it is not re-walked.
- [ ] Worker prompt: fetch only URLs that came from search results, a fetched page's links, or a source-of-truth tool. A constructed URL is a last resort. On a `missing` result, return a short hint ("this URL does not exist — search the host instead") rather than a bare 404.
- [ ] Locale: when the query names a market or country, workers prefer that market's pages. A price or availability claim cited to a different-market URL caps at `medium`. Do this in code, in the ledger or ground layer, not as a prompt-only rule. Run `ground.test.ts`.
- [ ] Logging gaps: `githubRepo` failure `status`/`error`; trace `ytdlp` `Broken pipe` (24×) and fix it if it is ours.
**Left behind:**

## Wave 5 — Simplify, align, and a real eval            <!-- status: pending -->
- [ ] Run `/analyze` (fallow) and act on the high-signal findings: dead code, duplication (for example `human-solve-state.ts` plan/planDialog duplicate block), and `bin/solver.ts` `processRequest` complexity. No churn for its own sake.
- [ ] Extend `evals/golden.jsonl` by about 8 cases: deep and standard, commerce multi-item, a German-market spec query, the multi-part B2 shape, and a "must say not found" case. Make `scripts/eval.ts` report wall time and `partial` rate per depth.
- [ ] Docs alignment:
  - `AGENTS.md`, `README.md`, `docs/decisions.md`, `docs/measurements.md` and `docs/field-notes.md` match the code.
  - Fix stale counts (AGENTS.md says "ten tools" in the file map and "Nine tools" in Gotchas; verify against `tools.ts`).
  - Prune dead sections.
  - Close or update GitHub issues these waves resolved.
**Left behind:**

## Wave 6 — Live verification on the mini            <!-- status: pending -->
- [ ] Confirm the latest `master` is deployed (`deploy/MINI.md`, `make logs`, `GET /health`). `make verify` is green.
- [ ] `make eval` against the live gateway. Record the results in `evals/results/` and `docs/measurements.md`.
- [ ] Run fresh real jobs: 2 quick, 2 standard and 1 deep, across a tech question, a commerce/German-market question and a multi-part one. Compare duration, cost, partial rate, unverified count and report shape against the evidence base above.
- [ ] Write the before/after table into `docs/measurements.md`. List anything still off as GitHub issues, not as TODOs in docs.
**Left behind:**
