# Field notes — what a real consumer session looked like

Observations from the calling side, not the serving side. The README records what
the service measures about itself; this file records what a client noticed while
using it for actual work, and what would have made that work cheaper or safer.

Each entry is dated and names the run it came from. Add to it after any session
where the gateway did something surprising — the value is in the specifics, not
in a general impression.

---

## 2026-08-06 — 7 parallel jobs, one domain (Wild Rift champion research)

**The shape of the run.** Seven `depth=standard` jobs submitted in two batches
inside one turn, all on the same subject area (Wild Rift patch 7.2b: builds,
runes, counters for seven champions), consumed by writing seven vault notes plus
a synthesised decision guide. Every job returned `status: ok`. Nothing failed.

| | Min | Max | Median |
|-|-|-|-|
| Wall time | 199s | 406s | 315s |
| Cost | $0.035 | $0.131 | $0.127 |
| Search calls | 4 | 16 | 16 |
| Pages retrieved | 10 | 33 | 27 |
| Pages failed | 0 | 5 | 1 |
| Citations kept | 14 | 56 | 40 |

Total **$0.79** for ~46 minutes of aggregate research wall time, of which ~19
minutes was blocking `job_wait` for the tail. Citations dropped: **0** across all
seven runs.

### What worked, concretely

**The `unverified` block earned its place.** It caught the sharpest failure of
the run by itself: a Nunu report pulled matchup data from Blitz.gg, then flagged
in `unverified` that Blitz.gg publishes *PC League* patch 26.9 data, not Wild
Rift, "and cannot be used." Without that block I'd have written PC matchups into
a Wild Rift note. Another run self-reported a citation it had to drop because the
URL was never actually retrieved. That is the honesty the field is for.

**Per-citation `confidence` mapped to reality.** Everything marked `high` traced
to Riot patch notes or a primary build site; the `medium` labels landed on Reddit
threads and aggregator counter-stats, which is exactly right. I used the labels
to decide what to state flatly and what to attribute.

**The cheapest run was not the worst run.** The Dr. Mundo job used 4 search calls
and $0.035 and produced a report I used essentially in full. The 16-call runs
were broader but not proportionally more useful. Search is 60–75% of the cost
(e.g. $0.070 search vs $0.037 LLM on one run), so this is where the money is.

### Problems worth fixing

**1. Reports can contradict themselves, and nothing checks.** The Nunu report
opened by correctly stating that patch 7.2 *removed boot enchantments*, then two
sections later listed the boot line as "Plated Steelcaps → **Gargoyle Enchant**
(tier-3 upgrade)". Both claims are in the same document. The Galio report did the
same thing ("Armored Advance (wrbase) **or** Gargoyle (WildRiftFire)"). The Rakan
report hit the identical trap and *did* catch it inline — "note: Protobelt is a
full mage item, not a boot enchant, in 7.2". So the capability exists; it just
isn't applied systematically.

→ **A final internal-consistency pass over the report's own claims** would catch
this class. It needs no new sources: the contradicting statement is already in
the context.

**2. A source can be cited in the body and disowned in `unverified`.** Same Nunu
report: Blitz.gg appears in the "Best Matchups" table *and* in `unverified` as
unusable. Flagging it is good; still tabling it is not.

→ **Anything that lands in `unverified` should be stripped from the body**, or the
body row should carry the warning inline.

**3. Cross-domain contamination is invisible without domain knowledge.** The same
run named **Sylas** as a champion who steals Nunu's ultimate. Sylas does not exist
in Wild Rift — it is a PC-League fact wearing the right costume. A prior session
of mine hit the same failure with Trundle. The gateway cannot be expected to know
a game roster, but this is a recognisable *pattern*: a query about a spin-off
product pulls facts from the parent product.

→ Nothing generic fixes this. What would help is **surfacing which sources are
about the exact subject vs. an adjacent one** — the run already knew Blitz.gg was
PC data; it just didn't generalise that suspicion to the Reddit and counter-site
results from the same search.

**4. Editorial rankings and measurements are quoted with equal weight.** Reports
say "S-tier on wrbase" and "53.4% win rate" in the same table, both cited, both
`high` confidence — because both are *accurately reported*. But one is a
publisher's opinion and the other is a measurement, and in this domain they
disagreed hard (one champion: S-tier on the build site, 47% and below the
publication threshold in the measured feed).

→ **A claim-type tag alongside `confidence`** — `measured` | `editorial` |
`community` — would let a consumer weight them without re-reading every source.
`confidence` currently answers "did we really retrieve this?", not "is this a
number or an opinion?"

**5. Seven jobs re-derived the same background seven times.** Every one of my
queries needed the same patch-7.2 context: boot enchants removed, tier-3 boots
at 10:00, mage items reworked. Each job searched for and re-established that
independently. At ~$0.08 of search per job, a large fraction of $0.79 bought the
same seven facts seven times.

→ **A `context` parameter** (free-text background the lead treats as given,
not to be re-verified) would cut this directly. A batch mode sharing one
retrieved corpus across sub-queries would cut it further.

**6. Latency is high-variance and opaque.** 199s to 406s for near-identical
prompt shapes, with no signal beyond `elapsedMs` about *why*. A job at 300s
could be mid-search or mid-synthesis and the client can't tell, which makes
"wait or give up" a guess.

→ **Return a coarse phase in `job_status`** (`searching` | `reading` |
`synthesising`, plus counts so far). Cheap to emit, and it turns the tail wait
into an informed one.

**7. Polling seven jobs is chatty.** Each `job_wait` blocks ~50s, so the slowest
job took 8 sequential calls. Correct behaviour, but for a fan-out the client
ends up interleaving waits by hand.

→ **`job_wait_all({ jobIds })`** returning as each completes, or a single call
that blocks until all are done, would collapse that.

### Follow-up the same day: one `depth=deep` run, and a new failure class

A single `depth=deep` job on "does a structured Wild Rift item/rune data source
exist" ran **650s for $0.47** — 1.6× the wall time and 3.6× the cost of the
median `standard` run, with 59 search calls, 106 pages retrieved and **51 page
fetches failed**. The report was broad and genuinely useful. It was also wrong
in a way the `standard` runs never were.

**A failed fetch became a fact about the world.** Two claims, both
`confidence: high`, both false when probed by hand from the same machine minutes
later:

- *"The lrlib CDN hosts only static image assets… the naming patterns suggest
  this CDN serves a card/hero collection game, not Wild Rift."* It hosts the live
  141-champion Wild Rift roster as JSON and every champion's official head icon.
  The run reasoned from a **sparse Wayback CDX listing** because the direct fetch
  failed, and concluded the resource doesn't exist.
- *"`mlol.qt.qq.com` … is geo-restricted to mainland China (connection refused
  from outside)."* It answers fine; I pulled 353 KB from it that day. One failed
  fetch became a geographic claim.

This is worse than an unsourced guess, because it arrives with high confidence
and a citation to the *evidence of absence* (a 404 probe, an archive query). With
51 failed fetches in one run, the odds of at least one turning into a false
negative are high.

→ **Never promote a fetch failure to a negative claim.** If the only evidence for
"X does not exist" is that retrieval failed, it belongs in `unverified` as
"could not retrieve", not in the report as a finding. The distinction the run
needs is *retrieved-and-empty* vs *not-retrieved*, and it already tracks both.

**It also reasoned about a document it admitted it couldn't read.** The report
declared the wiki's item module stale and unusable for the current patch, while
its own `unverified` block says the module *"is too large to fetch — 121 KB"*.
The staleness verdict came from a revision timestamp alone. Worse, it checked the
**wrong host**: the same module title exists on the Fandom mirror (last edited
2025-09-17) and on the official migrated wiki (last edited two days before the
run). Reading the second one — 144 KB via `action=query&rvprop=content`, which
works fine — reversed the verdict.

→ **If a claim rests on a document that landed in `unverified`, the claim should
degrade with it.** And a "site is stale" conclusion should survive a check for
the same content on a sibling domain.

**What deep bought that standard didn't:** the whole third-party landscape —
which sites actually measure builds (two: wrchina.gg reading the CN in-game
leaderboard, and RiftGG), which are editorial, which are dead. That is real
value, and it was cheaper than doing it by hand.

→ The lesson isn't "don't use deep". It is that **breadth raises the failed-fetch
count, and failed fetches are the input to this failure mode** — so the guard
matters more at `deep` than anywhere else.

### Ranked, if only some get built

Filed as issues, ranked by severity — the first two are the same bug wearing two
hats: **the pipeline treats "we couldn't get it" as "it isn't there."** Fixing
that one idea fixes both.

1. [#3](https://github.com/jkrumm/research-gateway/issues/3) Never promote a fetch failure to a negative claim
2. [#4](https://github.com/jkrumm/research-gateway/issues/4) A claim sourced from an `unverified` document should degrade with it
3. [#5](https://github.com/jkrumm/research-gateway/issues/5) Internal-consistency pass over a report's own claims
4. [#6](https://github.com/jkrumm/research-gateway/issues/6) Add a `context` parameter to skip re-deriving shared background
5. [#7](https://github.com/jkrumm/research-gateway/issues/7) Strip `unverified` sources from the report body

Not filed, lower priority: a claim-type tag (`measured` / `editorial` /
`community`) alongside `confidence`, and a coarse `job_status` phase plus
`job_wait_all` — both ergonomics, not correctness.

---

## 2026-08-30 — open items harvested from the serving-side handover notes

The gitignored handover file (`HANDOVER.md`) that carried the working state between sessions
was retired; its measurements moved to [`measurements.md`](./measurements.md), its settled
rules to [`decisions.md`](./decisions.md), and everything still *open* is here, so it has a
tracked home. Status as of the retirement, with the numbers that were true then.

### Costs money while it waits

- **Tavily is over plan** — `planUsage 1152 / planLimit 1000`, `paygoUsage 151`, visible at
  `GET /health/tavily` and pushed to argo on a 10-min throttle. The open part is the decision:
  upgrade or cap. yt-dlp made it much less urgent — extract calls for one job fell 22 → 4,
  and video transcripts now cost zero.

### Known-open, with numbers

- **`readCapped` in `ytdlp.ts` breaks out of the stream at 8 MB without draining**, then awaits
  `proc.exited`. A process still writing could block on a full pipe. The cap is far above the
  measured 642 KB so it has never fired; kill the process on cap instead if it ever does.
- **techempower returns 4,626 chars of nav.** The real data is a 143 KB JS chunk on the same
  host (`/benchmarks/assets/index-<hash>.js` → `round-23-<hash>.js`). A 3-GET site adapter
  would fix it. The hash changes on rebuild — walk the chain, never pin it.
- **The 200-char floor let a 243-char error page through once** (`walmart`, at concurrency 2;
  three solo runs read 1,632). Isolate with `--only <name>` before attributing movement.
- **Step-1 fetch timeout is 10s.** Surfline hit it once, never again. Deliberately unchanged.
- **Search tuning untouched.** `deep`'s `maxSearches: 6` was never validated. Pages-read
  predicts citations (r=+0.78); searches-issued only +0.52. Read the price-of-an-answer
  table in `measurements.md` before A/B-ing anything.
- **`github.com` is the top unverifiable host** (16 of 26 across 15 runs) and the next
  site-adapter candidate — a Wayback rescue (`sub_tool: wayback` in argo) is the signal that
  picks the one after that.
- **Workers occasionally die at ~300-321s with `TimeoutError`**; wall time is dominated by
  synthesis, not research. The SSRF DNS-rebinding TOCTOU gap remains (the redirect-hop gap
  is closed).
- **If yt-dlp starts returning `Sign in to confirm you're not a bot` across the board, the
  VPS IP got flagged.** Independent research says YouTube blocks whole cloud ASNs at the
  edge; this VPS is currently not in that state. Levers, in order: `--cookies` from a
  logged-in export, a residential proxy, a paid transcript API. Nothing in the code needs
  redesigning for that.

### Proposed, NOT validated

- **Bump `YTDLP_MAX_CONCURRENCY` above 2.** 429s were measured under burst, so raising it
  needs a real run, not a guess.
- **A retry for `no json3 caption track`** — pointless, it is a property of the video. Do not
  add it.
- **Split `direct-sources.ts`** (~900 lines). Flagged by review as a deliberate call.
- **Extract steps 1-2 of `runFetchChain` into a helper** so `skipToExtract` is a guard clause
  rather than a wrapping `if/else`.
- **`SiteAdapter` as a discriminated union** — `plan` and `rewriteHost` are mutually exclusive
  at runtime but not in the type.

### Traps that are not obvious from the code

- **Pushing to master deploys and kills running jobs.** Check `/health/render` shows `active: 0`.
- **`make research-gateway-down && up` rolls code back** (recreates from `:latest`, which
  RollHook never updates). Use `make research-gateway-redeploy`.
- **The VPS's own `~/vps` checkout has no git credential** — commit from the mini, pull there.
- **From the mini, `.github/workflows/` pushes need a credential override.**
- **`lightpanda/Dockerfile` copies `*.ts` as a glob**; `boundary.test.ts` guards it.
- **`--extractor-args "youtube:player_skip=webpage,configs"` triggers the bot wall on every
  video; `--sub-langs "en.*"` expands to ~157 tracks and 429s.** Both measured; never add
  either. The code picks one caption track from `-J` itself and never passes `--write-subs`.
