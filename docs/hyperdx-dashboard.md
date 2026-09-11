# HyperDX — "Research" dashboard

Traces and logs land in ClickStack under `ServiceName = 'research-gateway'` (tables
`otel_traces`, `otel_logs`; attributes in `SpanAttributes[...]`, all values are **strings** —
numbers need `toFloat64OrZero`, booleans compare against `'true'`).

**One trace per job, and the trace id IS the job id** with dashes stripped
(`traceIdFromJobId`). That is the whole operational point: someone hands you a jobId from a bad
report, and

```sql
WHERE TraceId = replaceAll('e1aafd34-83b2-4207-b47a-b9e937a5d577', '-', '')
```

gives you the plan, every worker, every page fetch with its fallback waterfall, the synthesis,
and the grounding verdict — plus every `log()` line, which now carries the same `TraceId`.
Nothing else joins those together; container logs rotate away inside 72h and a deep job runs
for minutes (measured p50 366s, max 1237s over 30 days).

A span exports when it **ends**, so a running job shows up as a partial trace: workers and
tool calls land within seconds of finishing, while `research.job` itself only appears when the
job does — up to ~21 minutes later at `depth=deep`, measured. A root-less trace is *usually* a job still
running — but a SIGKILL or an uncaught exception mid-job leaves the identical shape, because
`research.job` never ends and so never exports. Disambiguate against the sqlite job store
(`GET /research/:jobId`), not against the trace: a job the store calls terminal with no root
span is a crash.

## Span model

```
research.job                    server, root — traceId = jobId
├─ research.plan                client   (skipped entirely at depth=quick — no LLM call)
├─ research.round   round=1     internal
│  └─ research.worker  ×N       internal, parallel, bounded by WORKER_MAX_CONCURRENCY
│     ├─ tool.searchWeb         client
│     ├─ tool.fetchPage         client   + one `fetch.step` EVENT per fallback attempt
│     └─ tool.<any other>       client   (wrapped generically in buildTools)
├─ research.round   round=2     internal — the gap round, only if findings left holes
├─ research.synthesis           client
└─ research.ground              internal — the code-side citation gate
```

| Span | Key attributes |
|-|-|
| `research.job` | `research.depth` · `research.query` (200 chars) · `research.reason` submit_report/assembled/empty · `research.rounds` · `research.workers` · `research.digests` · `report.status` ok/partial · `report.citations` · `report.sources` · `grounding.pages_retrieved` / `.pages_failed` / `.citations_dropped` / `.confidence_capped` · `llm.input_tokens` / `.cached_input_tokens` / `.output_tokens` / `.reasoning_tokens` · `cost.llm_usd` / `.search_usd` / `.total_usd` · `search.calls` · `render.count` / `.failures` |
| `research.plan` | `llm.model` · `plan.sub_questions` · `plan.fallback` |
| `research.round` | `research.round` · `research.workers_dispatched` · `research.digests_returned` · `research.gap_round` · `research.round_retry` (only on a retry pass — a round that lost EVERY worker is re-dispatched once over the same questions, so one `research.round` number can legitimately carry two spans) |
| `research.worker` | `worker.sub_question` (200) · **`worker.forced_submit`** step_cap/context_cap/worker_deadline/job_deadline, absent = finished naturally · `worker.steps` · `worker.digest` · `worker.findings_kept` / `.findings_stripped` · `ledger.retrieved` / `.failed` / `.snippet` · `llm.*` |
| `research.synthesis` | `synthesis.digests` · `synthesis.outcome` submitted/salvaged/rejected_no_call/rejected_guard/failed |
| `research.ground` | the four `grounding.*` counts + `report.status` |
| `tool.fetchPage` | `fetch.url` · `fetch.host` · `fetch.via` · `fetch.ok` · `fetch.chars` · `fetch.attempts` · `fetch.error` · events `fetch.step` {step, ok, chars, error, ms} and `fetch.rewrite` |
| `tool.searchWeb` | `search.query` (200) · `search.via` cache/budget/dual/tavily/sonar · `search.results` |

A zero-evidence job (`research.reason=empty`) is the one exception to that `research.job` row:
its span still carries `research.rounds` / `.workers` / `.digests` (0) / `.failures`, but no
`report.status` / `cost.*` / `grounding.*` — it throws before synthesis and grounding ever run.

No personal API key is cached on the mini, so the dashboard is built once in the UI
(Dashboards → New → add tiles). Each tile is a HyperDX search + chart; the SQL below is the
equivalent for the SQL editor or the `/otel` skill
(`~/.claude/skills/otel/scripts/query.py --env prod "<sql>"`).

## Tiles

**1. Report quality — the grounding funnel (table, one row per day × depth)**

The product-quality tile. `digests → citations` is what the pipeline produced;
`dropped`/`capped` is what the code-side gate had to take away because the ledger did not back
it. A rising `dropped` means the synthesis model is asserting sources the workers never
actually read — the exact failure the ledger exists to catch. A rising `partial` share means
evidence is being lost upstream; go to tile 3.

```sql
SELECT toStartOfDay(Timestamp) d, SpanAttributes['research.depth'] depth, count() jobs,
       countIf(SpanAttributes['report.status']='partial') partial,
       round(avg(toFloat64OrZero(SpanAttributes['research.digests'])),1) digests,
       round(avg(toFloat64OrZero(SpanAttributes['report.citations'])),1) citations,
       round(avg(toFloat64OrZero(SpanAttributes['grounding.citations_dropped'])),2) dropped,
       round(avg(toFloat64OrZero(SpanAttributes['grounding.confidence_capped'])),2) capped,
       round(avg(toFloat64OrZero(SpanAttributes['grounding.pages_retrieved'])),1) pages_ok,
       round(avg(toFloat64OrZero(SpanAttributes['grounding.pages_failed'])),1) pages_fail
FROM otel_traces WHERE ServiceName='research-gateway' AND SpanName='research.job'
  AND Timestamp > now() - INTERVAL 7 DAY
GROUP BY d, depth ORDER BY d DESC
```

**2. Where a 28-minute job goes — stage breakdown (bar)**

Search: `ServiceName:research-gateway SpanName:research.*` · group by `SpanName` · `Duration`
p50/p95. Read `research.worker` against `research.round`: the round costs what its **slowest**
worker costs, so the gap between the two is pure straggler tax.

```sql
SELECT SpanName, count() n,
       round(quantile(0.5)(Duration)/1e9,1) p50_s,
       round(quantile(0.95)(Duration)/1e9,1) p95_s,
       round(max(Duration)/1e9,1) max_s
FROM otel_traces WHERE ServiceName='research-gateway' AND Timestamp > now() - INTERVAL 7 DAY
  AND SpanName LIKE 'research.%'
GROUP BY SpanName ORDER BY p95_s DESC
```

**2b. The straggler, per round (table)** — which rounds were held open by one worker, and by
how much. This is the tile that says whether raising `WORKER_MAX_CONCURRENCY` would buy
anything (it would not; the tail worker sets the wall clock either way) or whether
`workerTimeoutMs` is the real lever.

```sql
SELECT TraceId, SpanAttributes['research.round'] round, count() workers,
       round(min(Duration)/1e9,1) fastest_s, round(max(Duration)/1e9,1) slowest_s,
       round((max(Duration)-avg(Duration))/1e9,1) tail_cost_s
FROM otel_traces WHERE ServiceName='research-gateway' AND SpanName='research.worker'
  AND Timestamp > now() - INTERVAL 7 DAY
GROUP BY TraceId, round HAVING workers > 1 ORDER BY tail_cost_s DESC LIMIT 20
```

**3. How workers end (stacked bar) — the most actionable tile here**

`worker.forced_submit` is the ceiling that cut the worker off; absent means it decided it was
done. `job_deadline` climbing is the signal that the research phase is being squeezed by
synthesis's reserved budget; `context_cap` climbing means `maxContextTokens` or the digest
prompt needs work; `step_cap` climbing means the worker is thrashing tools. Each points at a
different knob in `depth.ts`, which is why the reason is recorded rather than just the fact.

```sql
SELECT coalesce(nullIf(SpanAttributes['worker.forced_submit'],''),'natural') ended_by,
       count() n,
       countIf(SpanAttributes['worker.digest']='true') with_digest,
       round(avg(Duration)/1e9,1) avg_s,
       round(avg(toFloat64OrZero(SpanAttributes['worker.steps'])),1) steps,
       round(avg(toFloat64OrZero(SpanAttributes['worker.findings_stripped'])),2) stripped
FROM otel_traces WHERE ServiceName='research-gateway' AND SpanName='research.worker'
  AND Timestamp > now() - INTERVAL 7 DAY
GROUP BY ended_by ORDER BY n DESC
```

**4. The fetch waterfall — which fallback step actually earns its place (table)**

Every `tool.fetchPage` span carries one `fetch.step` event per attempt, in order, so the whole
chain is measurable for the first time outside `fetch-bench.ts`. `win_pct` is how often a step
terminates the chain when it runs; `wasted_s` is time burned by that step on runs where it did
**not**. A step with a low `win_pct` and a high `wasted_s` is a candidate for reordering or a
`site-adapters.ts` entry that skips straight past it.

```sql
SELECT a['step'] step, count() attempts,
       countIf(a['ok']='true') wins,
       round(100*countIf(a['ok']='true')/count(),1) win_pct,
       round(avg(toFloat64OrZero(a['ms']))) avg_ms,
       round(sumIf(toFloat64OrZero(a['ms']), a['ok']!='true')/1000) wasted_s
FROM otel_traces
ARRAY JOIN Events.Name AS en, Events.Attributes AS a
WHERE ServiceName='research-gateway' AND SpanName='tool.fetchPage' AND en='fetch.step'
  AND Timestamp > now() - INTERVAL 7 DAY
GROUP BY step ORDER BY attempts DESC
```

**5. Hosts that block us (table)**

Ranked by failed fetches, with a sample error. This is the queue for the next
`site-adapters.ts` entry, and the check on whether an existing adapter still works. Commerce
and login-walled sites block at the fingerprint layer and will never resolve — what matters is
spotting a host that *used* to fetch and stopped.

```sql
SELECT SpanAttributes['fetch.host'] host, count() tries,
       countIf(SpanAttributes['fetch.ok']='true') ok,
       countIf(SpanAttributes['fetch.ok']!='true') blocked,
       any(SpanAttributes['fetch.error']) sample_error,
       arrayStringConcat(groupUniqArray(SpanAttributes['fetch.via']), ', ') vias
FROM otel_traces WHERE ServiceName='research-gateway' AND SpanName='tool.fetchPage'
  AND Timestamp > now() - INTERVAL 7 DAY
GROUP BY host HAVING blocked > 0 ORDER BY blocked DESC LIMIT 30
```

**6. What a job costs, by depth (table + number)**

`cache_pct` is the load-bearing one: the IU endpoint bills a cache read ~30× below a miss, and
the whole per-model cost split in `cost.ts` rests on the fan-out sustaining a high hit rate. If
that number falls, `llm_usd` is understated everywhere it appears — in the report, in argo, and
here.

```sql
SELECT SpanAttributes['research.depth'] depth, count() jobs,
       round(avg(toFloat64OrZero(SpanAttributes['cost.total_usd'])),4) avg_usd,
       round(quantile(0.95)(toFloat64OrZero(SpanAttributes['cost.total_usd'])),4) p95_usd,
       round(sum(toFloat64OrZero(SpanAttributes['cost.llm_usd'])),3) llm_usd,
       round(sum(toFloat64OrZero(SpanAttributes['cost.search_usd'])),3) search_usd,
       round(100*sum(toFloat64OrZero(SpanAttributes['llm.cached_input_tokens']))
             / nullIf(sum(toFloat64OrZero(SpanAttributes['llm.input_tokens'])),0),1) cache_pct,
       round(avg(Duration)/1e9) avg_s
FROM otel_traces WHERE ServiceName='research-gateway' AND SpanName='research.job'
  AND Timestamp > now() - INTERVAL 7 DAY
GROUP BY depth
```

**7. Search backend split (pie + table)**

`search.via` separates the paths that cost money (`tavily`, `sonar`, `dual`) from the ones that
do not (`cache`) and the one that means we ran out (`budget`). A rising `budget` share means
`maxSearches` is binding and workers are going blind before they are done.

```sql
SELECT SpanAttributes['search.via'] via, count() n,
       round(avg(toFloat64OrZero(SpanAttributes['search.results'])),1) results,
       round(avg(Duration)/1e6) avg_ms
FROM otel_traces WHERE ServiceName='research-gateway' AND SpanName='tool.searchWeb'
  AND Timestamp > now() - INTERVAL 7 DAY
GROUP BY via ORDER BY n DESC
```

**8. Errors (table)** — `ServiceName:research-gateway StatusCode:Error`. A `research.worker`
error is a degraded job, not a failed one (the job absorbs it); a `research.job` error is a
real failure. Click a row through to its trace.

```sql
SELECT Timestamp, SpanName, StatusMessage,
       SpanAttributes['worker.sub_question'] sub_question, TraceId
FROM otel_traces WHERE ServiceName='research-gateway' AND StatusCode='Error'
  AND Timestamp > now() - INTERVAL 7 DAY ORDER BY Timestamp DESC LIMIT 50
```

**9. Logs (table)** — `ServiceName:research-gateway` in the Logs tab. Every record now carries
`TraceId`/`SpanId`, so a `worker.failed` or `synthesis.rejected` line clicks straight through
to the trace that produced it. The narrative stays in logs; the numbers you group by live in
spans.

**10. Lifecycle & shedding (table)** — the events that say whether a restart cost anything.
These have no span: they happen outside a job, or to jobs that never finished one. This is the
tile to read after any deploy or restart.

```sql
SELECT Timestamp, SeverityText, Body, LogAttributes
FROM otel_logs
WHERE ServiceName='research-gateway'
  AND Body IN ('process.draining','process.drained','job.drain_queued','job.reaped',
               'job.reaped_on_read','process.memory_pressure','process.memory_recovered',
               'process.signal','process.uncaughtException','job.rejected')
  AND Timestamp > now() - INTERVAL 7 DAY
ORDER BY Timestamp DESC LIMIT 200
```

How to read it:

| Event | What it means |
|-|-|
| `process.draining` | SIGTERM arrived. `running`/`queued` are what was in flight, `drainMs` the configured window |
| `process.drained` | The drain finished. `remaining: 0` is the good case; **`remaining > 0` is ERROR severity** and means the window elapsed with jobs still alive — the number that decides whether agent-loop checkpointing is worth building |
| `job.drain_queued` | Jobs failed fast because they were still queued at shutdown. Expected, not a fault |
| `job.reaped` / `job.reaped_on_read` | A job whose owner died without draining — a SIGKILL or an OOM kill. **Not** expected on a clean deploy any more |
| `process.memory_pressure` / `process.memory_recovered` | Admission shed new work at 85% of the cgroup limit and released it below 75%. A pressure line with no recovery line is the shape to alert on |
| `job.rejected` | Group by `reason`: `queue_full` \| `memory_pressure` \| `draining` |

**11. Did one `job_wait` cover the job? (table)** — `job_wait` blocks for the whole job, so the
healthy shape is one record per job with a terminal `status`. A `stillRunning` state with
`bounded: false` means the *client* hung up, which points at its per-server `timeout`, not at
this service.

```sql
SELECT Timestamp, LogAttributes['jobId'] job_id, LogAttributes['status'] status,
       toFloat64OrZero(LogAttributes['waitedMs'])/1000 waited_s,
       LogAttributes['bounded'] bounded, LogAttributes['aborted'] aborted
FROM otel_logs
WHERE ServiceName='research-gateway' AND Body='mcp.job_wait'
  AND Timestamp > now() - INTERVAL 7 DAY
ORDER BY Timestamp DESC LIMIT 100
```

## One-job forensics

```sql
SELECT Timestamp, SpanName, ParentSpanId, round(Duration/1e6) ms, StatusCode, SpanAttributes
FROM otel_traces WHERE TraceId = replaceAll('<jobId>','-','') ORDER BY Timestamp
```

```sql
SELECT Timestamp, SeverityText, Body, LogAttributes
FROM otel_logs WHERE TraceId = replaceAll('<jobId>','-','') ORDER BY Timestamp
```
