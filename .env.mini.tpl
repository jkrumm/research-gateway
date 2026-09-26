# Mini overlay — the native LaunchAgent instance on :7780, the only instance since the VPS
# container was retired 2026-09-26 (docs/decisions.md). Layered on top of
# .env.local.tpl:
#   secrets-run run --env-file=.env.local.tpl --env-file=.env.mini.tpl -- bun run src/index.ts
# Last file wins per key, so anything here overrides .env.local.tpl's dev
# defaults. See scripts/launch.sh.

PORT=7780
# Loopback only — Caddy (research.test → research.mini.jkrumm.com) is the one door.
HOST=127.0.0.1
NODE_ENV=production
MACHINE=mini

# lightpanda runs as its own LaunchAgent (com.jkrumm.research-gateway-lightpanda)
# on loopback, not a Docker network peer — see
# launchd/com.jkrumm.research-gateway-lightpanda.plist.template.
LIGHTPANDA_URL=http://127.0.0.1:7781

# No cgroup on macOS, so the memory watchdog (src/lib/memory-watch.ts) has
# nothing to sample there — setting MEMORY_LIMIT_MB switches it to process RSS
# against this ceiling instead. 4096 leaves headroom under the mini's real RAM for
# the gateway process plus up to RESEARCH_MAX_CONCURRENCY concurrent jobs.
MEMORY_LIMIT_MB=4096

# Same service name the retired VPS instance used, kept so history stays under one HyperDX
# service; host.name via OTEL_RESOURCE_ATTRIBUTES now only ever says "mini".
# Export itself stays optional (.env.mini.otel.tpl / scripts/launch.sh) — the
# HyperDX ingestion key is seeded separately from everything else here.
OTEL_SERVICE_NAME=research-gateway
OTEL_RESOURCE_ATTRIBUTES=host.name=mini

# Raised 3 → 5 on 2026-09-25, measured during a 14-job burst at 3-way: RSS
# 1.42 GB of 4096 MB (34%, ~2.8 GB extrapolated at 6), zero LLM or search 429s
# in two days of logs, and no wall-clock slowdown for overlapping jobs. The one
# metric near a ceiling is Sonar: 51 searches in the peak minute at 3 jobs
# against a documented 50 RPM on IU's shared account (a 429 retries once, then
# falls back to Tavily). 5, not 6, for that reason — watch tool.searchWeb
# errors before going higher. The memory watchdog still brakes dispatch at 85%.
RESEARCH_MAX_CONCURRENCY=5

# brainNotes tool (agent/tools.ts, agent/brain-search.ts) — the second brain's reader app,
# tailnet-only (dotfiles' Caddyfile: basalt-ui-obsidian demo, port 7733). BRAIN_DIR itself
# can't live here — templates can't expand $HOME — so scripts/launch.sh exports it directly,
# next to JOB_DB_PATH/YTDLP_PATH, only when the vault checkout exists.
BRAIN_BASE_URL=https://brain.mini.jkrumm.com

# Human-solve escalation (agent/human-solve.ts): the ssh alias to the owner's MacBook, which
# reaches it non-interactively (dedicated key, IdentityAgent none, BatchMode) ONLY to prompt —
# a dialog asking whether to open Screen Sharing into the mini's own console session, where the
# actual solver Chrome runs (bin/solver.ts, spawned locally).
HUMAN_SOLVE_SSH_HOST=iumac
# The mini's tailnet MagicDNS name over the macOS Screen Sharing URL scheme — what the
# MacBook's dialog opens on "Open". :5900 is Screen Sharing's default port, so no port needed.
HUMAN_SOLVE_VIEW_URL=vnc://mini
