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

### Ranked, if only some get built

1. Internal-consistency pass (**#1**) — it produced a wrong fact in a published
   note, and the fix needs no new retrieval.
2. `context` parameter (**#5**) — biggest cost lever, smallest surface.
3. Strip `unverified` sources from the body (**#2**) — small, purely additive safety.
4. Claim-type tag (**#4**) — changes how a consumer reads every report.
5. Phase in `job_status` (**#6**) and `job_wait_all` (**#7**) — ergonomics, not correctness.
