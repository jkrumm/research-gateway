# The mini instance

Native (no Docker) second instance on the Mac mini, where every consumer already runs. Same
code, same sqlite job store shape, same OTel service name — told apart by `host.name=mini` on
spans and `machine: 'mini'` on argo usage rows. The VPS container stays up as the fallback until
it is retired in the `vps` repo.

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

Both ports bind loopback only: 7780/7781 sit inside the tailnet ACL's `tcp:7700-7799` grant, and
the renderer is unauthenticated.

## Secrets

`secrets-run` over `.env.local.tpl` + `.env.mini.tpl` (fail-closed — the launcher refuses to start
on an unresolved ref), plus two optional overlays that start the instance **degraded** instead of
not at all: `.env.mini.otel.tpl` (HyperDX ingest key) and `.env.mini.github.tpl` (public-read PAT).
A missing overlay shows as `degraded: [...]` on `GET /health` and one error-level
`process.degraded` line at boot. Seeding: add the ref to `dotfiles-private/headless.refs`, then
`make secrets-seed` on the MacBook.

## Deploys

Push to `master` → within 2 minutes the poller fetches, and if `origin/master` differs from
`~/.research-gateway/data/deployed-sha` **and** `/health` reports zero running + queued jobs, it
resets the clone, runs `bun install` only when `package.json`/`bun.lock` changed, restarts only
what the diff touched (markdown/docs: nothing; `lightpanda/`: the sidecar too), and writes the
marker only after a healthy restart — a failed deploy is retried on the next tick. A busy gateway
defers the deploy instead of draining it. `launchd/` template changes are **not** applied
automatically: `make launchd-install` by hand.

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
