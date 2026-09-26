# The mini instance

Native (no Docker), the only instance since the VPS container was retired 2026-09-26 — every
consumer already ran against the mini. Same code, same sqlite job store shape, same OTel service
name — `host.name=mini` on spans and `machine: 'mini'` on argo usage rows are now the only values
either ever takes. See `docs/decisions.md` § VPS instance retired for the history.

## Layout

| What | Where |
|-|-|
| deploy clone (what runs — never the dev checkout, a dirty tree must not go live) | `~/.research-gateway/app` |
| job store | `~/.research-gateway/data/jobs.sqlite` |
| pinned `lightpanda` + `yt-dlp` (sha256-verified, `scripts/install-bins.sh`) | `~/.research-gateway/bin` |
| `pdftotext` | Homebrew `poppler`, on the launcher's PATH |
| gateway LaunchAgent, :7780 on 127.0.0.1 | `com.jkrumm.research-gateway` → `scripts/launch.sh` |
| renderer sidecar, :7781 on 127.0.0.1 | `com.jkrumm.research-gateway-lightpanda` → `scripts/launch-lightpanda.sh` |
| deploy-on-push poller, every 120s | `com.jkrumm.research-gateway-deploy` → `scripts/mini-deploy.sh` |
| logs | `~/Library/Logs/research-gateway{,-lightpanda,-deploy}.{log,err}` |
| door | Caddy `research.test` → `research.mini.<domain>` (dotfiles `config/Caddyfile`, `make caddy-tailnet`) |

Both ports bind loopback only — no tailnet ACL grant covers them directly; the tailnet reaches
the gateway only through the Caddy door above. The renderer is unauthenticated.

## Secrets

`secrets-run` over `.env.local.tpl` + `.env.mini.tpl` (fail-closed — the launcher refuses to start
on an unresolved ref), plus two optional overlays that start the instance **degraded** instead of
not at all: `.env.mini.otel.tpl` (HyperDX ingest key) and `.env.mini.github.tpl` (public-read PAT).
A missing overlay shows as `degraded: [...]` on `GET /health` and one error-level
`process.degraded` line at boot. Seeding: add the ref to `dotfiles-private/headless.refs`, then
`make secrets-seed` on the MacBook.

The Karakeep half of `brainNotes` is the third optional overlay, `.env.mini.karakeep.tpl`
(`KARAKEEP_URL` + the dedicated Hermes Karakeep key, already in the mini's secrets cache). It is
layered by `scripts/launch.sh` like the otel/github overlays: an unresolved key starts the
instance `degraded: ["karakeep"]` with vault-only `brainNotes`, never not at all.

## Deploys

Push to `master` → within 2 minutes the poller fetches, and if `origin/master` differs from
`~/.research-gateway/data/deployed-sha`, it first checks CI before touching anything: **gated on
`.github/workflows/ci.yml`'s `check` job for that exact SHA**, queried via
`GET /repos/jkrumm/research-gateway/commits/{sha}/check-runs` (GitHub REST, `ci_gate_status` in
`scripts/mini-deploy.sh`) using the same push credential git already uses
(`secrets-run read op://mini/github/token` — dotfiles' `git-credential-secrets-cache`, never
`op read`/`op run`, which hang on a biometric prompt no one on this box can answer). A completed,
green check run lets the tick proceed; a still-running one logs "waiting for CI" and skips; a
failed one logs an error naming the SHA and skips; the API being unreachable also skips — a
deploy never goes out unchecked. Only once CI is green does the poller check that `/health`
reports zero running + queued jobs, reset the clone, run `bun install` only when
`package.json`/`bun.lock` changed, restart only what the diff touched (markdown/docs: nothing;
`lightpanda/`: the sidecar too), and write the marker only after a healthy restart — a failed
deploy is retried on the next tick. A busy gateway defers the deploy instead of draining it.
`launchd/` template changes are **not** applied automatically: `make launchd-install` by hand. A
`scripts/install-bins.sh` change re-runs it against the clone before the restart; a non-zero exit
fails the deploy (no marker written, retried next tick) rather than restart onto mismatched
pinned binaries.

`ExitTimeOut` 1860s on the gateway plist is load-bearing: launchd's default is 20s, which would
SIGKILL through the 1800s `SHUTDOWN_DRAIN_MS` drain on a reboot or manual restart.

## Operating

```bash
make mini-setup        # first install: clone, deps, pinned bins, LaunchAgents
make launchd-status    # launchd state + /health, /health/render, /health/ytdlp
make launchd-restart   # idle-gated, FORCE=1 to override
make deploy            # one poller tick, now
make launchd-logs
```

Monitoring: the `research-gateway` component of dotfiles' `devhost-health-check.sh` (gateway
`/health` + renderer via `/health/render`, into the "MacMini Dev Host - Push" Kuma monitor) and a
crash-loop row for both KeepAlive labels. Memory: no cgroup on macOS, so `MEMORY_LIMIT_MB=4096`
drives the same watchdog + load shedding off process RSS (`memory.source: "rss"` on `/health`).

## Human solve

**Browser-first.** A challenged page (Cloudflare managed challenge, DataDome, …) is first tried
with the solver Chrome ALONE (mode 'fetch', no dialog, no MacBook contact) — whether the host is
completely unknown or was previously cleared, both now run the identical code path. Measured live
2026-09-26 on the mini: MPB served a Cloudflare managed challenge (403, `cf-mitigated:
challenge`) to both a plain and an impit fetch, but the dedicated solver Chrome passed it with
**no human interaction at all** (Screen Sharing was open the whole time; Turnstile auto-passed on
the residential IP), and a follow-up 'fetch' request then read the MPB homepage in 12s with no
dialog. Only once this browser-only attempt itself comes back 'challenge' does the gateway
escalate to the dialog below. A settled page's HTTP status is now read alongside its HTML
(`performance.getEntriesByType('navigation')[0]?.responseStatus`, Chrome >=109), so a
definitively-missing page — MPB's German 404, "ERROR 404 Seite nicht gefunden" at 211 chars, thin
enough to have looked like an ordinary miss — is recorded `missing` instead of a false
`retrieved`.

The gateway ssh's to `HUMAN_SOLVE_SSH_HOST` (`iumac`) **only** to show a JXA dialog; **Open** runs
`open vnc://mini` there, and the owner clicks through the challenge in the mini's dedicated
solver Chrome (`~/.research-gateway/solver-chrome`, CDP on `127.0.0.1:9422`, separate from
any everyday Chrome, now launched with `--start-maximized` so Screen Sharing shows essentially
one browser window). The browser — and so the `cf_clearance` cookie — lives on the mini, so
later reads of that host go through the same browser with no dialog and no MacBook, from the
mini's own IP. The MacBook never fetches anything (it is an IU-managed device on a corporate
network). Requirements: the console GUI session stays logged in, Screen Sharing stays enabled.
The solver polls `/json/list` titles and attaches a CDP client only once the challenge title is
gone — an attached debugger is the main thing anti-bot scripts detect. Suppression: a skipped or
unanswered host is not re-asked for 6h (blocking both the browser-only attempt and the dialog);
an unreachable MacBook pauses only the DIALOG for 5 min, never the browser-only attempt (which
never touches the MacBook); the solver Chrome or the SSRF proxy below failing to come up pauses
everything globally for the same 5 min, under its own 'solver unavailable' reason. The dialog
rate limit (6 prompts/hour, global) is charged only on an actual escalation to the dialog — a
browser-only attempt never consumes it.

**HTTP(S)/WebSocket SSRF filter, plus a separate WebRTC restriction — not one blanket
"network-level" boundary.** The solver Chrome is LLM-chosen-URL-driven (attacker-influenced by
construction), so a URL-level check alone (`assertPublicHttpUrl` on the request in and the
settled `location.href` on the way out) leaves a gap: a redirect or a `fetch()` the challenged
page's own script issues in between is unchecked. `src/lib/safe-proxy.ts` closes that gap for
HTTP(S) and WebSocket traffic — a loopback-only HTTP+CONNECT proxy hosted INSIDE the gateway
process (started from `src/index.ts` only when `HUMAN_SOLVE_SSH_HOST` is set), listening on
`127.0.0.1:${HUMAN_SOLVE_PROXY_PORT}` (default 9423). It resolves DNS itself and connects to the
RESOLVED address (defeating DNS rebinding — a hostname that resolved safely cannot later connect
anywhere unsafe through it), refusing if ANY resolved address is unsafe. The solver Chrome is
launched with `--proxy-server=http://127.0.0.1:9423` and `--proxy-bypass-list=<-loopback>` (the
latter removes Chrome's own implicit loopback bypass, so a page reaching for
`localhost`/`127.0.0.1` is refused too, not routed direct). Adapted from agentrhq/webcmd's
`src/fetch/safe-proxy.ts` (Apache-2.0); the private/reserved-range table is shared with
`src/lib/ssrf.ts` (`isPrivateAddress` for `assertPublicHttpUrl`'s existing callers,
`isPrivateAddressStrict` — the fuller, TEST-NET-closing table — for this proxy only, which has no
TEST-NET-fixture caller to preserve). CONNECT tunnels TLS end-to-end, so this does NOT change the
Cloudflare-visible TLS/HTTP fingerprint or the egress IP the target site sees — it guards the
DESTINATION Chrome can reach, not what it looks like once it gets there.

WebRTC is a SEPARATE network path this proxy never sees — a page could otherwise open a direct
UDP/TCP connection via `getUserMedia`/`RTCPeerConnection` straight past it, with no DNS or SSRF
check in between. bin/solver.ts's Chrome is launched with
`--force-webrtc-ip-handling-policy=disable_non_proxied_udp` and
`--webrtc-ip-handling-policy=disable_non_proxied_udp` instead, restricting WebRTC's own candidate
gathering to proxied UDP only. HTTP(S)/WebSocket via the proxy above, plus WebRTC restricted to
proxied, are the two network paths page JS running in Chrome can reach — there is no other raw
TCP/UDP socket API available to it, so say precisely which mechanism covers which path rather
than one undifferentiated "network-level boundary".

Since the profile persists across launches but command-line flags don't, `bin/solver.ts` records
the proxy port it last launched Chrome with in a sidecar file next to the profile
(`~/.research-gateway/solver-chrome.launch-args.json`) and compares it on every run; a mismatch
(or an instance that predates the proxy entirely) is killed and relaunched with the flags the
current run needs — Chrome is never left browsing unfiltered. If the proxy itself isn't
listening, the solver refuses to run at all (`reason: 'proxy_unavailable'`) rather than fail
open. A `mode: 'warm'` solver run (launch/verify only, no tab, no human) checks both — proxy
listening, then Chrome up with matching launch args — with no tab and no human; the gateway no
longer calls it directly (the browser-first 'fetch' attempt above establishes the same thing as
a side effect, since it launches/verifies Chrome and the proxy before opening its tab), but the
protocol mode stays for anything else that wants a launch/verify-only check.

State is in-memory by design: a deploy or restart forgets declined hosts and any suppression, so
a declined host can be asked about again after the next deploy. Dialog prompts are capped at 6
per rolling hour. Trust boundary: the solver Chrome renders LLM-chosen URLs on the dev host with a
warm cookie profile. The settled URL is re-checked against the SSRF guard before anything is
returned, and the profile is used for nothing else. Never sign in to anything in it.
