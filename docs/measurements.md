# Measurements

Every number this service's design rests on, with the run it came from. The README states the
decisions; this file is the evidence, moved out of it verbatim so the README stays readable
and the measurements stay quotable. Dates are the day of the run. Prefer the repeated
measurements (the 15- and 45-run baselines) over any n=1 — several tuning claims in this repo's
history were made from single runs and did not survive being measured properly.

**How to measure things here**

| Question | Command |
|-|-|
| Is yt-dlp alive in prod? | `curl https://research.<domain>/health/ytdlp` |
| One URL through the deployed chain, no LLM | `POST /probe/fetch` with `{ url }` |
| Does the fetch chain still work? | `API_SECRET=$(secrets-run read op://vps/research-gateway/API_SECRET) bun run scripts/fetch-bench.ts` |
| Is a bench row stable, or is the origin flapping? | same script with `--only <name>`, three times |
| Is the renderer up? | `curl https://research.<domain>/health/render` |
| Tavily account state | `curl https://research.<domain>/health/tavily` |
| Did a job's findings survive grounding? | HyperDX, `TraceId = <jobId without dashes>`, `worker.ungrounded` and `grounding.citationsDropped` |
| What did a job actually call? | same trace, `tool.*` spans |
| Container memory headroom | `ssh vps 'docker stats --no-stream \| grep research'` |

`scripts/bench.ts` costs ~90 min and ~$1.35 per configuration and **cannot resolve fetch-level
effects** (`pagesFailed` moved 10.8% → 11.3% at cv 1.00). Use `fetch-bench.ts` for the chain.

---

## Web search backend — why Sonar, and the two pinned settings

`searchWeb` runs on **Perplexity Sonar over the same IU endpoint as the LLMs** by default,
with Tavily as a per-call fallback. Set `SEARCH_PROVIDER=tavily` to take Perplexity out of the
loop entirely.

Why Sonar is the default (all figures measured against the live endpoint, 2026-08-02):

| | Sonar | Tavily (`basic`) |
|-|-|-|
| Cost per search | $0.005 (`low`, what we send) | ~1 credit ($0.005–0.008) |
| Sources available | 17–20, trimmed per depth | 5 |
| Publication dates | on every result | none |
| Latency | ~1.7–2.3s | ~1.9s |
| Billed to | the IU work key | the personal Tavily plan |

**Two settings are pinned against measurement, not intuition** — both live-probed 2026-08-02:

- **`search_context_size` is `low` at every depth.** Across two queries at all three tiers the
  result *count* was identical (17/17/17, 20/20/20) and the URL set identical to within one
  hit. The higher tiers buy longer snippets (2613 → 3555 chars), and snippets are triage only
  — the ledger caps a snippet-backed claim at `medium` no matter what. Paying 2.4x for text
  that may not serve as evidence is waste.
- **Hits are trimmed per depth** (`maxSearchResults`: quick 5, standard 12, deep 20). This
  dial costs nothing on the search side — the per-request fee is flat — but it drives worker
  tokens and wall-clock, because every extra candidate is a page a worker may fetch. Handing a
  `standard` job all 20 produced a better report (50 citations / 35 pages) at 545s and $0.16;
  trimming to 8 gave 247s and $0.031 but only 15 citations; the shipped 12 gives 213s, $0.080
  and 39 citations — faster than the 8-hit config *and* 2.6x its citations, so it is not a
  midpoint but a better operating point than either. (n=1 per config on one broad query.)

There is also a **hard per-worker search budget** (`maxSearches`: quick 2, standard 4, deep 6),
enforced in the tool rather than requested in the prompt. The worker prompt has long said "1–3
searches should be enough" and "re-searching with reworded queries is the least effective thing
you can do"; a measured deep job issued **74 searches across 11 workers** (~6.7 each), and
search was 65% of that job's $0.57. Prompts do not hold here, the same way citation
instructions did not hold before the retrieval ledger. Exhausting the budget returns the same
tool-visible error shape a failed search returns — behaviour the prompt already teaches a
response to — and cache hits do not count against it.

Two properties of this route are load-bearing and were established by probing, not from docs:

- IU exposes Sonar as `owned_by: "Perplexity direct"` — a **real passthrough**. `citations` and
  `search_results` sit outside the OpenAI-standard `choices` array, and normalizing gateways
  drop them (LiteLLM #5313/#13777, Portkey's strict-compliance mode, API7). Here they survive.
  If that ever changes, `search_results` comes back empty; `sonar-parse.ts` treats an empty
  result set as a failure precisely so the Tavily fallback engages instead of the worker being
  told the web has nothing. A 429 is retried once (honouring `Retry-After`, capped at 5s)
  before falling back — Perplexity is 50 RPM at tier 0 on IU's *shared* account, so a rate
  limit is likely transient and not worth moving spend onto the personal key over.
- `usage.cost` carries Perplexity's own per-call USD, which is why this is the one backend whose
  telemetry can report real money (see below).

**Sonar's synthesized answer is discarded.** It is an answer engine and it does hallucinate
under confidence; letting that prose into a worker's context would launder Perplexity's
assertions into the report attached to URLs we never retrieved. Only the URLs and snippets are
kept, and they enter the ledger at the `snippet` tier like any other search hit — so nothing
Sonar asserts can be cited as verified. `max_tokens` is pinned at 16 (the API's floor; it 400s
below that) to pay for as little discarded generation as possible.


## Measured baseline

`standard`, 15 runs — 5 heterogeneous queries x 3 repetitions via
[`scripts/bench.ts`](./scripts/bench.ts) against the live gateway, 2026-08-02:

| metric | mean | sd | cv | min | max |
|-|-|-|-|-|-|
| wall (s) | 354 | 223 | 0.63 | 131 | 777 |
| total ($) | 0.0891 | 0.0257 | 0.29 | 0.0363 | 0.1212 |
| search ($) | 0.0523 | 0.0186 | 0.36 | 0.0151 | 0.0754 |
| searches | 10.4 | 3.7 | 0.36 | 3 | 15 |
| citations | 38.4 | 16.9 | 0.44 | 14 | 66 |
| pages | 24.7 | 8.0 | 0.32 | 10 | 37 |

**Read the within-query spread, not the table, before believing a config change.** Per query
(n=3): wall cv 0.11–0.77, cost cv 0.08–0.33, citations cv 0.06–0.47. Cost is the trustworthy
metric — a >25% difference is probably real. Citations are usable with care. **Wall-clock is
not usable for config decisions**: one query spanned 206s to 779s on identical configuration.
Several tuning claims in this repo's history were made from single runs and did not survive
being measured properly; that is what the harness exists to prevent.

Three findings that outlast the tuning:

- **Search is 59% of a standard job's cost** ($0.052 of $0.089). LLM is 41%.
- **Tavily is dormant** — 12 credits across all 15 runs, touched by only 5 of them. That is
  the Sonar migration's real result: search left the personal key, and Tavily is back to
  being the Extract fallback it was meant to be.
- **13.4% of page fetches fail** (41% worst case), ~3.9 wasted fetches per run — and each one
  costs a worker step, the resource that actually buys citations. One host dominated: 6 of 13
  unverified entries in a sampled deep run were `www.reddit.com`, which answers a bot with
  HTTP 200 and an 8 KB JavaScript shell. `fetch-url.ts` now fetches those through
  `old.reddit.com` (267 KB of real HTML for the same thread) while the ledger keeps the
  original URL, so citations still ground. The remaining failures are genuine — dead domains,
  404s, paywalls. A 15-run re-measurement after the fix: fetch failure rate 13.4% → 10.8%,
  **Tavily credits 12 → 7 across the whole matrix** (the predicted mechanism — no more
  Extract calls wasted on shells), cost unchanged, and no resolvable change in citations.


## Source-of-truth lookups

### Spoken sources: video transcripts, and why podcasts needed no code

`fetchPage` on a `youtube.com/watch?v=…` URL returns the video's full spoken transcript. Both
YouTube code paths — this one and `findVideos` — now run on a `yt-dlp` binary bundled into the
image (pinned in the Dockerfile), not a Tavily Extract call or an HTML scrape.

The shape that works, MEASURED 2026-08-06 against three videos from the VPS: **one `-J`
metadata extraction plus one direct GET of the caption track it names**.

| Video | Track | Extract | Caption fetch | Total | Chars |
|-|-|-|-|-|-|
| `8aGhZQkoFbQ` | manual `en` | 3,989ms | 182ms | 4,171ms | 22,147 |
| `ELYfRiF-424` | auto `de` | 3,427ms | 198ms | 3,625ms | 80,411 |
| `-PHXi7NTB8k` | manual `en` | 3,837ms | 93ms | 3,930ms | 19,967 |

`-PHXi7NTB8k` is a video Tavily Extract failed on in production — yt-dlp read it fine. The
crux is the caption URL itself: the `baseUrl` scraped from the watch page's HTML returns HTTP
200 with **zero bytes** (PO-token gated), but the URL `-J` returns for the same track carries
the params that make a plain GET actually work.

**Track selection is deliberate, not "whatever yt-dlp defaults to".** Manual captions outrank
auto ones — MEASURED on the same video, same moment: manual reads "- Today, we are finally
gonna bring everyone out there up to speed on how to use a flash.", auto reads "today we are
finally going to bring everyone out there up to speed on how to use a flash" — same words,
unpunctuated. `agent/youtube-captions.ts` picks the video's own language first (manual, then
auto), falling back to English only when that language has no track at all, and the resulting
transcript text says explicitly when it came from auto-generated captions.

Two flag traps this was built around, both measured: `--extractor-args
"youtube:player_skip=webpage,configs"` triggers `ERROR: Sign in to confirm you're not a bot`
on every video — never add it. `--sub-langs "en.*"` is a glob that expands to ~157
auto-translated tracks and causes `HTTP Error 429: Too Many Requests`; even two exact codes
downloads a useless machine-translated track. That is why this reads `-J`'s own metadata and
picks one track itself rather than using `--write-subs` at all.

**Tavily Extract remains the fallback**, tried when yt-dlp finds no usable track (a rate
limit, a video truly without captions, a binary error) — it still recovers a video's
description and metadata even when a transcript is unavailable. `YTDLP_MAX_CONCURRENCY`
(default 2) bounds concurrent yt-dlp processes, because YouTube rate-limits this datacenter IP
under burst — the same trap the `--sub-langs` glob hit above.

URL shape still matters and was measured, not assumed:

| URL shape | Against yt-dlp / Tavily Extract |
|-|-|
| `youtube.com/watch?v=<id>` | works |
| `youtu.be/<id>` | fails — canonicalised to the watch form before dialling |
| `youtube.com/shorts/<id>` | fails — adapter declines, falls through to the generic path |
| `youtube.com/@channel` | 404 — adapter declines |

**Podcasts needed no code at all**, and two measurements say why. Episode pages are ordinary
web pages that step 1 already reads: `dwarkesh.com` returned 80,181 chars and
`changelog.com/podcast/626` 65,547, both via Readability on the first try. And the
Podcasting 2.0 `<podcast:transcript>` RSS tag — the obvious thing to build a discovery chain
on — has **2 tags across ~3,000 episodes** of eight major tech and interview shows. Only
Acquired publishes one. A discovery→RSS→VTT pipeline would have bought almost nothing.

**`findVideos` search is now the same binary, not a scrape.** `yt-dlp --flat-playlist -J
"ytsearch<n>:<query>"` returned **9,795 bytes in 2,712 ms** (MEASURED 2026-08-06) — a 134x
reduction against the ~1.3 MB HTML search page it replaces — with `id`/`title`/`duration`
(numeric seconds)/`view_count`/`channel` per entry, directly. It also retires the
`ytInitialData` regex as a breakage surface: that undocumented blob's shape was the entire
reason the old scraper existed.

Two shape decisions worth knowing before changing them:

- **`docker` deliberately returns no `latestVersion`.** Every other ecosystem's
  `latestVersion` names a real release. Docker's `latest` is a mutable pointer a maintainer
  can repoint at any time, and often is not the newest build. Under the same key a model
  already trusts from npm, it would produce a confidently wrong version number. It returns a
  tag list with dates instead.
- **Go module paths are case-encoded.** proxy.golang.org escapes uppercase as `!` + lowercase.
  Verified: `github.com/!masterminds/semver/v3/@latest` returns `v3.5.0`, and the unescaped
  path returns **HTTP 404** — a silent failure that looks exactly like "module not found".

**Semantic Scholar was measured and rejected.** Unauthenticated
`api.semanticscholar.org/graph/v1/paper/search` returned HTTP 429 on all three consecutive
calls from the VPS, and 200-then-429-then-429 from a residential IP. It is unusable at this
gateway's call rate without a key. The unblock is the free-key form
(`semanticscholar.org/product/api#api-key-form`), not a retry loop.

### Why a new tool needs two live runs, not one

`academicSearch` shipped working and useless, and only running it showed the difference. Three
runs of one identical query, each after one fix:

| | as shipped | + ledger fix | + prompt fix |
|-|-|-|-|
| findings stripped at the worker boundary | **9 of 14** | 2 of 10 | **0** |
| citations kept | 5 | 8 | **11** |
| citations pointing at an API endpoint | — | **5 of 8, at `high`** | **0** |
| `academicSearch` calls for one question | 8 | 6 | **3** |

Run 1: the tool answered correctly and `groundDigest` threw two thirds of it away, because
`lookupOpenAlex` recorded only its query URL while the model — correctly — cited works by DOI
and landing page. **Every URL a model can cite from a tool's response has to be on the
ledger**, or the tool is doing free work.

Run 2: fixed, and worse in a new way. Five of eight citations were the same
`api.openalex.org/works?filter=…` URL, at `high` confidence, standing in for five different
papers. Two behaviours caused it — the worker issued five reworded OpenAlex queries for one
question, then, out of useful steps, hand-built API URLs and passed them to `fetchPage`, which
reads them as raw JSON and grounds them at `high`. Neither is a bug in the tool; both are the
prompt not saying the thing.

Run 3: every citation is a paper (`arxiv.org`, `doi.org`, `pubmed`), all at `medium` — the
honest ceiling for "the index says so", since nothing read the papers themselves.

The lesson generalises past this tool. A new source-of-truth lookup is not done when it
returns correct data; it is done when a real worker's citations survive the ledger. Both
failures were invisible to unit tests and to the corpus, and both showed up in the first
`worker.ungrounded` line of a live run.


## Fetching pages

### Rendering JavaScript

Step 3 runs [lightpanda](https://github.com/lightpanda-io/browser) 0.3.6 in a sidecar container
(`lightpanda/`), reached over a private Docker network. On the page that motivated this — 
`techempower.com/benchmarks`, which serves a 2,003-byte shell to a plain fetch — it returns
**4,626 chars where Jina Reader — the third-party renderer it replaced — returned 1,030**, and
it does so without showing a third party which URLs this service reads and without a per-minute
quota. Jina was kept wired behind it as a one-env-var rollback for a while; it has since been
[retired](#retiring-the-third-party-renderer).

It is a **separate container**, and that is the measured part. Peak RSS is 100–205 MB per
render, and **479 MB** on a real page (`bun.com/docs`) without a heap cap. The gateway runs at
~151 MiB under a 512 MiB limit, so one uncapped render inside it is an OOM kill of the service
— which, with the job store it has, takes every in-flight research job with it. In its own
cgroup the same event costs one fetch, which falls through to Tavily. (The binary is also
glibc-linked and cannot execute on the gateway's alpine base at all.) Sizing: `mem_limit: 768m`
against 3 concurrent renders × 205 MB + ~50 MB of wrapper.

`--v8-max-heap-mb 64` is the flag that makes that sizing hold. Measured across 8 real pages at
32 / 64 / uncapped:

| cap | content vs uncapped | worst RSS | worst wall |
|-|-|-|-|
| 32 | **lossy** — 2,517 chars where uncapped gives 4,627 | 90 MB | 5.4s |
| 64 | byte-identical on all 8 | 205 MB | 9.3s |
| none | — | 479 MB | 32.2s |

Capping at 32 would have silently dropped 45% of the techempower page while landing well above
the 200-char floor, so nothing downstream would have noticed. 64 costs nothing and buys a 2.3×
memory bound and a 3.5× speedup, because V8 spends the difference growing a heap nothing reads.

Concurrency is bounded **in the sidecar**, not the gateway: the sidecar owns the memory budget,
and the gateway has 8 workers × 3 jobs with no single place that could enforce it. A request
that waits more than 20s for a slot is failed fast — the fallback costs a Tavily credit and
answers in ~2s, and the scarce resource on the gateway side is the worker step, not the credit.

### Success-shaped failures

Every renderer this chain has run reports failure by not failing, and each shape had to be
found by running it:

| Source | What it does |
|-|-|
| Reddit | HTTP 200 with an 8 KB JavaScript shell |
| Jina (retired) | HTTP 200 with `Warning: Target URL returned error 403` in the body |
| lightpanda | **exit 0** on a dead domain, with a synthetic `# Navigation failed` markdown page as the content, and `http_status: 0` |
| lightpanda | **exit 0** on HTTP 404 |
| lightpanda | uncaught page-JS exceptions written to **stdout**, after the JSON — `JSON.parse` of the stream throws `Extra data` (deterministic on techempower) |

Taking any of them at face value files un-retrieved text as page content and lets a citation
rest on it. All are detected and treated as errors; the rules are unit-tested in
`lightpanda/parse.test.ts` and `src/agent/lightpanda.test.ts` against the exact shapes measured.

One more, from Bun rather than the browser: `proc.killed` is **true after a clean `exit 0`**,
not only after a timeout kill (Bun 1.3.14). Gating the timeout branch on it turned every
successful render into "render timed out". `proc.signalCode` is the discriminator that holds.

### What the rendering stage actually recovers

This table is **generated**, not hand-built — `bun run scripts/fetch-bench.ts` replays a
fixed corpus through the deployed chain and prints it. Run 2026-08-03 against the build that
has no Jina step at all, 13 URLs, 17.8s, 0 Tavily credits:

| url | terminated at | chars | chain |
|-|-|-|-|
| reddit-thread | site-adapter | 30,509 | `site-adapter✓` |
| reddit-old | site-adapter | 30,507 | `site-adapter✓` |
| surfline-api | **raw** | 8,075 | `raw✓` |
| surfline | readability | 826 | `readability✓` |
| walmart | readability | 1,649 | `readability✓` |
| daily-dev-auth | readability | 889 | `readability✓` |
| medium-paywall | readability | **1,068** | `readability✓` — but see below |
| techempower | lightpanda | 4,626 | `readability✗ → lightpanda✓` |
| web-frameworks | lightpanda | 28,960 | `readability✗ → lightpanda✓` |
| x-status | lightpanda | 7,408 | `readability✗ → lightpanda✓` |
| ticketmaster | lightpanda | 28,504 | `readability✗ → lightpanda✓` |
| hard-404 | — | 0 | `readability✗` |
| dead-domain | — | 0 | `(none)` — SSRF guard catches DNS failure in 1ms |

**11 of 13 by the counter. 10 in truth.** Two rows fail correctly — a hallucinated 404 and a
dead domain. `medium-paywall` is the third, and the counter cannot see it: it is a real
member-only post whose first 1,068 characters are the lede and whose full text runs 14,911.
Step one returns the lede, clears the 200-char floor, and terminates the chain reporting
success. Nothing downstream can tell that apart from an article that is simply short.

That row used to point at `medium.com/@ai/some-post`, a URL naming no post at all — so the
corpus tested a 404 dressed as a paywall, and on the strength of it a third-party renderer
kept its place in the chain for months. It now points at a real one.

This is deliberately a *fetch-level* measurement rather than another job-level A/B. The 45
runs established that fetch-stage effects land below the job-level resolution floor
(within-query citation cv 0.09–0.43), so a 15-run comparison could not have resolved this
either way — while replaying the actual failing URLs answers it directly, in minutes.

Two caveats worth carrying, because the corpus is small enough to over-read:

- **`chars` is not a verdict, and neither is `via`.** `medium-paywall` reads `readability✓`
  today on 7% of the article. Before that, with Jina in the chain, it read `jina✓` on 5,014
  characters of Medium's navigation and sign-in furniture. Both are the same failure wearing
  the table's success column, and no length floor separates either from a genuinely short
  page. The bench prints a `preview` for exactly this reason; read it before calling a row a
  recovery.
- **Not every row-to-row change is attributable to a code change.** Three rows move on their
  own. `surfline` went from a 10s step-1 timeout to a clean 825-char read; `walmart` from 33
  characters to ~1,632, and once — mid-run, under concurrency 2 — down to a 243-char error
  page that lightpanda then "recovered" above the 200-char floor; `daily-dev-auth` reads 889
  or 4,595 depending on the run. Nothing in the chain explains any of it. Isolate a row with
  `--only <name>` before attributing its movement to a change: three consecutive solo runs
  put `walmart` at 1,632/1,632/1,632 while the full-corpus run beside them read 243.

A 15-run `standard` benchmark on the deployed chain says the same thing from the other side.
Counting what each step actually terminated (487 `fetchPage` outcomes):

| step | resolved | failed |
|-|-|-|
| Readability | 326 | — |
| site adapter | 3 | — |
| lightpanda | **44** (1,705,597 chars) | 40 |
| Jina, behind it | 8 | 32 (30 are 404s) |
| Tavily Extract | 1 | 31 exhausted the chain |

**That argued for keeping both renderers. The fetch-level bench then undercut it, and Jina is
gone** — see below. The job-level metrics moved as predicted, which is to say not resolvably: wall 354 → 328s,
cost $0.0891 → $0.0887, fetch failure rate 10.8% → 11.3% (pagesFailed cv **1.00** — this
metric cannot resolve anything at n=3). `tavilyCredits` read 12 → 7 → **0**, which is not the
saving it looks like — see below. The honest version of that claim is the table: Tavily
Extract now terminates 1 fetch in 487.

Two things the run surfaced that are not about rendering. `github.com` is now the top
unverifiable host (16 of 26 across 15 runs), replacing Reddit as the site-adapter candidate.
And a definitive **404 was still retried** through Jina and then Tavily — 30 of Jina's 32
failures were 404s the renderer had already proven. That is now fixed: 404 and 410
short-circuit at step one (`response-kind.ts`), which took the benchmark's `hard-404` row
from 10,543 ms and a billed Extract call to 365 ms and none. Deliberately not 401/403 —
those mean "not to you, like this", and a different client often does get through.

### Retiring the third-party renderer

Jina Reader was step 4 for as long as the self-hosted sidecar needed a rollback. It is now
deleted — schema, env vars, module and test.

The decision was one measurement, not an argument: run the 13-URL corpus against the deployed
chain with `JINA_ENABLED=true`, flip it to `false` in the VPS `.env`, recreate the container,
run the same corpus again.

| | Jina on | Jina off | step deleted |
|-|-|-|-|
| recovered | 11 / 13 | 10 / 13 | 10 / 13 |
| wall | 21.0s | 19.3s | 22.0s |
| Tavily credits | 0 | 0 | 0 |
| terminated by lightpanda | 4 | 4 | 4 |
| terminated by Jina | 1 | — | — |

(The wall-clock column is not a signal — the corpus is dominated by four ~5s renders, and in
the middle column `medium-paywall` walks to Tavily Extract instead of stopping at Jina. All
three runs used the old corpus, whose Medium row is described below.)

**One row changed: `medium-paywall`.** Its 5,014 characters were Medium's navigation chrome,
and its URL (`medium.com/@ai/some-post`) does not name a real post — so the row Jina "won" was
furniture on a page that does not exist. Nothing a citation could rest on was lost.

What the removal buys, beyond one less step: no third party learns which URLs this service
reads. That was the reason the sidecar was built, and keeping Jina wired behind it kept the
exposure alive for whatever the sidecar could not render. The 20 RPM anonymous ceiling and
the dead-key 402 handling go with it.

Rolling back is a `git revert`, not an env var. That is the deliberate cost of the change,
and it is affordable because the fallback below Jina — Tavily Extract — never moved.

#### The Medium paywall, which this made visible

Retiring Jina forced a look at the row it was winning, and the row was fake. Replacing it with
a real member-only post exposed a gap no step in the chain addresses.

Measured against four real Medium articles through the deployed chain, all four terminate at
Readability above the 200-char floor. The member-only ones are truncated to the lede:

| article | step 1 | full text |
|-|-|-|
| tailwind-css-vs-css | 1,068 | 14,911 |
| throw-vs-throw-ex | 1,206 | 5,607 |
| my-timeout-froze-the-queue | 8,754 | 7,887 |
| wikipedia-fication | 2,659 | 2,906 |

The bottom two are not paywalled — step one already has them, and the "full text" column is
just a mirror reading the same page. The top two are the gap: **the chain hands a worker 7% of
an article and reports success.**

The `full text` column comes from `freedium-mirror.cfd`, and the deliberate decision is **not
to wire it in**. It is a third-party proxy — precisely the exposure deleting Jina removed —
and it is one unproxied IP with no CDN behind it. Trading a measured, documented ceiling for
an unmeasured dependency on a hobby host is the wrong direction, and the same reasoning that
retired Jina applies here.

Two things worth recording for whoever revisits this. The `freedium.cfd` that every
paywall-bypass guide names **no longer resolves anywhere** — NXDOMAIN from three networks;
`freedium.io`, `scribe.rip` and `md.dhr.wtf` all fail too, and `freedium-mirror.cfd` was the
only one of five that worked. And a paywall marker could not be found from outside the
container: `curl` from the VPS gets a 5.8 KB consent interstitial where the gateway's own Bun
fetch gets the article, so detecting "this is a lede, not an article" would need a debug
affordance that returns raw HTML before it could need a heuristic.

### Sonar and Tavily are complementary, not interchangeable

Measured head-to-head on the 5-query benchmark set, 12 results each, run from the deployed
container (2026-08-02):

| | Sonar | Tavily |
|-|-|-|
| results | 60 | 60 |
| unique domains | 36 | 45 |
| shared domains | 14 | 14 |
| results carrying a date | 60/60 | 0/60 |
| dead or blocked (40 sampled) | 1 | 2 |

**Only 14 domains overlap** — 2–3 per query out of 12 results each. The switch to Sonar was
framed as replacing one search backend with another; it is closer to trading one slice of the
web for a different one. Tavily surfaces *more* distinct domains (45 vs 36); Sonar dates every
result, Tavily dates none; dead-link rates are comparable.

This is answerable at the component level for the same reason the renderer was: it is a
property of the search call, not of a whole job, so it costs cents and minutes instead of the
80 hours a job-level A/B would need (see below). The open question it raises — whether `deep`
should query **both** backends for roughly double the domain diversity, at the cost of Tavily
credits on deep jobs — is a spending decision, not a measurement one.

The merge was built, shipped and then **turned off**, which is the more useful result. It
does widen the pool: measured live on a deep job, 16 dual searches produced 31.2 results each
against a single-backend cap of 20 (+56%), with 4-11 cross-backend duplicates removed per
search. But pages actually read across three deep jobs were 100, 109 (without) and 107
(with) — the extra candidates produced no extra reading, because a worker's ceiling is
`workerMaxSteps` (9), not candidate supply. Citations landed at 152, inside the 66-158 range
the two runs without it already spanned. It cost 16 Tavily credits per deep job — double the
pre-ship estimate, since workers search more than once inside their budget — and bought
nothing measurable.

The lever worth revisiting is therefore `workerMaxSteps`, not the candidate list:
pages-read predicts citations at r=+0.78, searches-issued only +0.52. Widen the reading
budget before widening what there is to read. The merge itself stays in the code behind
`dualSearchFirstRound`, one boolean from returning.

### The price of an answer

From the 45 runs, pooled within-query cv is 0.235 (citations), 0.172 (cost), 0.372 (wall),
0.263 (pages). Reps **per query** needed to detect a relative effect at α=0.05, power=0.80,
and the wall-clock that implies for a two-arm A/B over the 5-query set:

| effect | citations | cost | wall |
|-|-|-|-|
| 5% | 348 (319 h) | 186 (171 h) | 868 (795 h) |
| 10% | 87 (80 h) | 47 (43 h) | 217 (199 h) |
| 20% | 22 (20 h) | 12 (11 h) | 54 (50 h) |
| 30% | 10 (9 h) | 5 (5 h) | 24 (22 h) |

At ~$0.087 per run, resolving a 10% citation change costs roughly **80 hours and $76** of
live jobs. That is the honest constraint on tuning this system, and it is why the remaining
knobs (`deep`'s `maxSearches`, a Sonar-vs-Tavily quality comparison) are documented as open
rather than guessed at: anything under a ~20% effect is not affordably decidable here.

It also reframes a decision already made. The `maxSearches` 4→3 A/B measured a 9% citation
drop on 3 reps per query — by this table, ~29x underpowered for that effect size. It was
nonetheless reverted correctly, but on **sign consistency** (down on 5 of 5 queries, p≈0.06)
rather than on the magnitude. Use that test, not the effect size, for anything this small.

### What this harness can and cannot resolve

At 3 repetitions per query, the resolvable effect size (2 × standard error, as a share of that
query's mean) is **±7% to ±55% for citations** and **±10% to ±38% for cost**, depending on the
query. So: a 20%+ cost change is measurable, a 5% citation change is not — and a single run
resolves nothing at all. Raise `--reps` before trying to defend a small effect, and expect the
occasional degenerate run (one q0 run did 3 searches and 7 pages where its siblings did 14–15
and 29–51); report those rather than dropping them silently.
- **Pages predict citations far better than searches do.** Pages-read correlates with citations
  at r=+0.78; searches-issued reaches only +0.52, and does so *through* pages (searches→pages
  r=+0.49). Yield decays with volume: 3.8 pages per search on the query that searched least,
  1.7 on the one that searched most.

That last finding argued for a tighter search budget, so it was tested rather than assumed —
and the test refuted it. A 14-run arm at `maxSearches: 3` cut cost 13.6% but cut citations
9.0%, **down on 5 of 5 queries** (individually inside the noise; a 5/5 sign agreement is not).
One query lost 17.9% of its citations while its cost rose 6.3%. So it is a trade, not a
saving — and the wrong way round here, since search bills the IU work key while report quality
is the product. `maxSearches` stayed at 4. Revisit if IU spend ever becomes binding.


## Telemetry

### What `tavilyCredits` cannot see

**`tavilyCredits` counts search credits only. It does not count page extraction, and it never
did.** Repeated write-ups in this repo blamed the field. The field is fine: `@tavily/core`
sends `include_usage: true` and surfaces `response.data.usage` correctly, and the zero comes
from Tavily. Measured against `api.tavily.com` from the VPS, 2026-08-03:

| URLs per Extract call | reported `usage.credits` |
|-|-|
| 1 | **0** (four calls, fresh and cached URLs) |
| 2 | 1 |
| 5 | 1 |
| *search, any* | 1 — correct |

`fetchPage` extracts exactly **one** URL per call, so on that path the field is structurally
zero forever, at any volume. Ground truth lives at `GET https://api.tavily.com/usage`, which
at measurement time reported `extract_usage: 75` against `search_usage: 1064` — extracts are
billed, the per-response field just cannot see them at this call shape.

So the fix is not to read a different field. `tavilyExtractCalls` counts the calls, travels in
`raw` beside the credits, and is what any future USD-per-credit rate would have to multiply.

That same `GET /usage` call is worth running occasionally for a reason unrelated to this
field: it is the only place the **plan ceiling** is visible. It reports `plan_usage` against
`plan_limit` and a separate `paygo_usage` — and nothing in this service reads it, so crossing
from plan credits into pay-as-you-go happens silently.


## Older baselines (2026-08-02, from the handover notes)

`deep`, `maxSearches=6`: 74 → 60 searches, cost slightly down. **Do not read the rest of that
table as an effect** — two runs of the same query differ by 66 vs 158 citations and 671s vs
1137s. Tuning `deep` needs repeated runs across several queries, not another n=1.

YouTube transcripts through the deployed chain, 2026-08-06: 4,473ms / 19,610 chars, 4,058ms /
80,181 chars (German), 4,261ms / 21,955 chars, 4,294ms / 19,193 chars — `tavilyCredits: 0` on
every one. 7 of 9 transcript fetches succeeded in a live job; the 2 misses had no `json3`
caption track at all and fell through to Tavily Extract, which still returns the description.
That ~78% is a property of the videos, not a bug. Confidence on a video citation is the
model's call: 4 cited videos all came back `medium` with `confidenceCapped: 0`, because all
four had auto-generated captions and the transcript text says so. Do not "fix" the medium.

The container wedged once at 512 MiB (2026-08-06): two concurrent `standard` jobs pinned it at
510.1 MiB, CPU 222%, **not** OOM-killed — the process kept running jobs while its HTTP
listener died (no socket on 7780, healthcheck `FailingStreak: 8`, `RestartCount=0`). A
wedged-but-running container never triggers a restart policy. At 1 GiB the identical pair
peaked at 228.2 MiB. On 2026-09-04 the kernel's cgroup OOM killer took the 1 GiB container
outright (`anon-rss:935864kB`), reaping 15 jobs — `mem_limit` and `RESEARCH_MAX_CONCURRENCY`
are one decision.
