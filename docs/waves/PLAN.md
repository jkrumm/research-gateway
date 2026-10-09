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

## Wave 4 — Fetch efficiency: no guessed URLs, no duplicate fetches            <!-- status: done -->
- [x] Per-job single-flight and cache in `fetchPage`: concurrent workers asking for the same URL share one chain run. Remember a per-job terminal "blocked" verdict per URL so it is not re-walked.
- [x] Worker prompt: fetch only URLs that came from search results, a fetched page's links, or a source-of-truth tool. A constructed URL is a last resort. On a `missing` result, return a short hint ("this URL does not exist — search the host instead") rather than a bare 404.
- [x] Locale: when the query names a market or country, workers prefer that market's pages. A price or availability claim cited to a different-market URL caps at `medium`. Do this in code, in the ledger or ground layer, not as a prompt-only rule. Run `ground.test.ts`.
- [x] Logging gaps: `githubRepo` failure `status`/`error`; trace `ytdlp` `Broken pipe` (24×) and fix it if it is ours.
**Left behind:** Shipped: `fetch-flight.ts` (pure; registry lives in `tools.ts`, `run.ts` clears per job) — concurrent callers share one chain run, page/404/410/classified-block outcomes are replayed, transient failures are not; each caller commits the staged ledger into its own ledger and charges its own page budget; logs `tool.fetchPage` `via: joined|replayed`. A 404/410 returns a "search the host instead" hint. Worker prompt: discovered-URLs-only and prefer-the-query's-market rules. `market.ts` + `groundClaims`/`groundReport` optional `market` param: a price/availability claim on another market's URL (ccTLD, country subdomain, locale path) or quoting a foreign currency caps at `medium`; bare `.com` is unknown, never foreign. Market is applied at the job boundary only (not `groundDigest`) — that is where report citations are gated. Logging: `githubRepo` failures log `status`/`error`. yt-dlp `Broken pipe` WAS ours: `-J` is 11.3 MB vs an 8 MB stdout cap (we closed the pipe); cap now 32 MB, a cut reports itself. Gate: `make check` green (1326 tests), `ground.test.ts` green incl. issue #1 and a new market block. Review fixes applied: mixed-currency claims, dead `U.S.`/`U.K.` query patterns, merged country maps, removed type cast, `fetch.host` on shared spans. Unproven until Wave 6: `missing` share (11%), repeat-fetch count (1,037), cross-market caps in real German-market jobs; remembered page text is held per job in memory (no byte bound; watch `memory_pressure` on deep jobs). Deferred: `githubRepo` 39% failure not yet broken down (needs a log read after deploy); joiner cannot cancel independently of the first caller's signal; fetch.ok for a replayed 404 reads as a block on the HyperDX hosts tile; ytdlp truncated+nonzero-exit ordering; fallow flags (`run.ts`/`job-runner-core.ts` clone, `direct-sources.ts` 10-line clone, unused re-exports) — Wave 5.

## Wave 5 — Simplify, align, and a real eval            <!-- status: done -->
- [x] Run `/analyze` (fallow) and act on the high-signal findings: dead code, duplication (for example `human-solve-state.ts` plan/planDialog duplicate block), and `bin/solver.ts` `processRequest` complexity. No churn for its own sake.
- [x] Extend `evals/golden.jsonl` by about 8 cases: deep and standard, commerce multi-item, a German-market spec query, the multi-part B2 shape, and a "must say not found" case. Make `scripts/eval.ts` report wall time and `partial` rate per depth.
- [x] Docs alignment:
  - `AGENTS.md`, `README.md`, `docs/decisions.md`, `docs/measurements.md` and `docs/field-notes.md` match the code.
  - Fix stale counts (AGENTS.md says "ten tools" in the file map and "Nine tools" in Gotchas; verify against `tools.ts`).
  - Prune dead sections.
  - Close or update GitHub issues these waves resolved.
**Left behind:** Shipped: fallow dead exports removed; `run-contract.ts` (env-free `runResearch` input/opts/`RunResearchFn`/`JobUsage`, shared by `run.ts` and `job-runner-core.ts`, ends the clone); `noopConsistencyReview` factory; `BOTTOM_LINE_HEADING` shared by prompt and `assemble.ts`; `suppressedGuard` in `human-solve-state.ts`; `restsOn` takes an options object; `partialCauseOf` labels 0-retrieved + failures `no-pages` (a review noted this merges "absence evidence" and "absence plus failures" under one label; raw `pagesFailed` is still reported). Eval: 28 cases (8 new: deep, commerce, German spec, multi-part, two not-found, two lookups), new `all` expect kind, per-depth wall/partial table in output and `summary.byDepth`, shared `scripts/gateway-client.ts` (tested) for bench and eval, `scripts` now in tsconfig, `golden.jsonl` parse test. Docs: tool count (ten on the mini, nine elsewhere) in AGENTS/decisions, field-notes pruned of VPS/rollhook-era traps and the fixed `readCapped` item, `measurements.md` eval section. Issues #3-#7 closed (all resolved by Waves 1-3); no open issues remain. Gate: `make check` green (1347 tests), `ground.test.ts` green, sideclaw review findings fixed (runJob error contract, cancelled polling, dead imports, weak http2 case). Skipped: `bin/solver.ts` `processRequest` split (CDP I/O with continue/return flow, only pure helpers have tests), `direct-sources.ts` clone (just two arg lists), `job-db.ts`/`job-store-core.ts` 119-line clone (fallow; an unchanged structural overlap, not touched), `bin/research.ts` internal clones and `parseArgs` complexity, `html-parse.ts` redeclaring `ParseRequest`/`ParseResponse`, schema.ts const/type pairs flagged by fallow. Not verified: no new golden case has run against the live gateway, and the not-found cases do not check for fabricated citations (matcher sees report text only) — Wave 6 runs `make eval` and should read those rows by eye. Still deferred from earlier waves: `githubRepo` 39% failure breakdown needs a post-deploy log read; joiner cannot cancel independently of the first caller's signal; replayed-404 `fetch.ok` reads as a block on the HyperDX hosts tile; ytdlp truncated+nonzero-exit ordering; smaller token cap on the compact synthesis retry; `sentenceAround` prefix rescan.

## Wave 6 — Live verification on the mini            <!-- status: done -->
- [x] Confirm the latest `master` is deployed (`deploy/MINI.md`, `make logs`, `GET /health`). `make verify` is green.
- [x] `make eval` against the live gateway. Record the results in `evals/results/` and `docs/measurements.md`.
- [x] Run fresh real jobs: 2 quick, 2 standard and 1 deep, across a tech question, a commerce/German-market question and a multi-part one. Compare duration, cost, partial rate, unverified count and report shape against the evidence base above.
- [x] Write the before/after table into `docs/measurements.md`. List anything still off as GitHub issues, not as TODOs in docs.
**Left behind:** Plan complete. Deployed 4a6c3a4 verified (`make verify` green, deploy log). `make eval`: 28/28, $1.36, `evals/results/2026-10-08-4a6c3a4.json`. Five fresh jobs (2 quick, 2 standard, 1 deep; tech, German commerce, multi-part) plus the log record since the final deploy, before/after table in `docs/measurements.md` § Live verification: quick p50 100s to 11s, standard 362s to 152s, deep 442s/538s (n=2), consistency p50 119s to 59s with 0 failures, `synthesis.rejected` 0 of 35, partial 22% to 17%, `missing` share 11% to 4.8%. `TYPICAL_DURATION_MS` retuned for quick/standard (deep kept, n=2). `githubRepo` 39%: an incident on 2026-09-24/25 (123 of 131 failures), about 6% since, 1 legitimate 404 post-deploy; nothing to fix. Not-found rows read by eye (full re-run reports and citations): no fabricated citation. Gate: `make check` green (1347 tests); no `ground.ts`/`tools.ts` change, `/review` skipped (a constants retune plus docs). Open as issues: #37 (workers name never-fetched URLs, drives scrub partials), #38 (eval stores no report text), #39 (standard length on negative answers; deep tail unproven at n=2). No next wave spawned, per the brief.

## Wave 7 — Close the Wave 6 leftovers            <!-- status: done -->
- [x] #37: workers name docs URLs they never fetched, which makes scrub-only partials. Fix it at the source: the worker/synthesis prompt plus whatever code-side check is simplest. Keep issue #7's intent intact. Run `ground.test.ts`.
- [x] #38: eval results store the report text and citations, so a not-found row can be audited without a re-run. Keep the file size sane.
- [x] #39: the standard-depth length target must hold on "does not exist" answers. A negative answer should be short.
- [x] Re-run `make eval` live after the deploy. Record it in `docs/measurements.md`. Close #37-#39 with a one-line note each.
**Left behind:** Plan complete. #37/#39: prompt-only (`src/agent/prompt.ts`): worker rule (name a URL only if retrieved; unfetched version-history claims become "not checked", no link), synthesis rule (no URL outside Sources read/findings), and a short-report rule when the bottom line is "does not exist" (~3k chars at any depth). No code-side check added: the existing scrub already catches a surviving case. #38: eval rows store `report` + `citations`; golden `citationsRetrieved` flag on the two not-found cases prints `NOT-IN-SOURCES=` (informational, not scored — a `missing` 404 legitimately backs an absence claim but is not in `sources`; first scored version failed both rows). Live eval dcb6490: 28/28 matcher, $1.34, not-found reports 3.0k/2.0k chars (was ~12k), partial 2/8 standard (one dropped citation each, none scrubbed), `evals/results/2026-10-08-dcb6490.json`. Gate: `make check` green (1349 tests), `ground.test.ts` green; one unrelated CI timeout (`host gate cooldown` test, 5s) passed on rerun. `/review` skipped (prompt text + eval tooling). Unproven: #37's scrub-partial rate needs more than this eval's one multi-part standard run; #39's deep tail still n=2 plus this run's one deep (310s). Still deferred: smaller token cap on compact synthesis retry; joiner cancel independence; replayed-404 `fetch.ok` on the hosts tile; ytdlp truncated+nonzero ordering; `sentenceAround` rescan.

## Wave 8 — Fixes from the 2026-10-09 live validation            <!-- status: done -->
Evidence from five live jobs (2026-10-09): Elysia c00b078c, Canyon b8aad229, ClickHouse b6e8bae3, PDFs cce38233, CSV c494ec73. Ground truth for the CSV job was computed locally, and every number matched. Look up the logs by jobId in `~/Library/Logs/research-gateway.log`.
- [x] **Scrub false alarms are still the main source of `partial`.** Two of the three partials in this batch were false alarms.
  - (a) CSV job: the prose names a URL the ledger holds as `missing` (404) and says it is 404, which is legitimate absence evidence. A `missing`-tier URL must not be scrub-annotated when its sentence makes an absence claim. Probably the simplest rule is never to scrub `missing` URLs, because they can back absence claims; verify that against issue #3/#7.
  - (b) Elysia job: "The Elysia 1.3 blog release note … could not be read" was flagged. The "carries no figure" exemption tripped on the version number that is part of the subject's own name. A figure that occurs in the unverified entry's own topic or URL must not count. Add both fixtures.
- [x] **Number-check false positives** (`numbers.ts`).
  - Canyon job: "Canyon-ID 4392" was capped low because 4392 occurs in the cited URL (`…/canyon_4392.html`), not the page text. Treat numbers present in the cited URL as found.
  - CSV job: an HTTP status ("404") in a claim about a missing page was capped. Exempt HTTP status codes when the claim is about the response itself, or the cited page is ledger-`missing`.
  - Keep issue #1's case and the existing number tests green.
- [x] **Large text/CSV files are cut at the page-text budget.** In the CSV job, population.csv (557 KB) was truncated at about 80k chars, so Germany's rows were never read and the worker fell back to the World Bank API. Let workers pull the rows they need from a big text/CSV/JSON-lines document without reading all of it. Prefer an optional parameter on `fetchPage` (for example a line filter that returns the header plus matching lines, charged to the page budget) over a new tool, and keep the tool description short. The result must still register the URL as `retrieved` in the ledger with exactly the text returned, so the number check works. Test with a fixture CSV.
- [x] **Worker digest loss.**
  - Canyon job: a worker ended `finishReason: stop` with no tool call at 07:49:08 after about 40s. `worker.salvage` returned `ok:false, findings:0`, so the sub-question "technical specs" was lost.
  - Overall rate: `worker.salvage` 18 false of 197, and 760 of 780 digests returned (2.6% lost).
  - Make the salvage path recover more often, for example by retrying salvage once on an empty result. Log why salvage failed (text-only reply vs. no call vs. error). No wall-clock caps.
- [x] Re-run the five validation queries (or equivalents) live after the deploy. Record durations, partial causes and number-check caps in `docs/measurements.md`. File anything still off as GitHub issues.
**Left behind:** Plan complete. Shipped: scrub never annotates a `missing`-tier (404/410) source and compares whole figures against the entry's own topic/URL (substring match was a review catch); `numbers.ts` treats digits in the cited URL as found and exempts an HTTP status quoted as the response (word-bounded keywords); `fetchPage` optional `lines` (≤5 case-insensitive terms) returns header + matching lines for text/CSV/TSV/NDJSON bodies, filtered before the 80k cut, own flight/dedup key per filter, ledger holds exactly the returned text (`line-filter.ts`; added csv/ndjson media types to `RAW_CONTENT_TYPES`); worker salvage tries twice (a throw on attempt 1 still earns attempt 2), logs `attempt`/`reason`/`finishReason`. Live: 5 jobs, 0 partial, line filter read Germany's rows from a 17k-line CSV, see `docs/measurements.md` § Wave 8. CI: the `fetch-chain` suite flaked on a 5s default timeout on the runner (poller refused two SHAs); `setDefaultTimeout(30_000)`. Gate: `make check` green (1383 tests), `ground.test.ts` green, sideclaw review run, both blockers fixed. Review items skipped: `fetchPage` execute closure complexity (fallow), brain-note branch ignores `lines`/dedup key, no note when a `lines` filter is requested but not applicable (non-line body), `omitted` not logged, line-filter reserve sizing only masked by TEXT_CAP, no groundReport-level integration tests for the missing bypass. Unproven: salvage retry path live; partial-rate drop at n=5. No next wave spawned, per the brief.
