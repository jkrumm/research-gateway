# Mini overlay — the native LaunchAgent instance on :7780, alongside the VPS
# Docker container (also :7780, different host). Layered on top of
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

# Same service name as the VPS instance, so both land under one HyperDX
# service and are told apart by host.name via OTEL_RESOURCE_ATTRIBUTES.
# Export itself stays optional (.env.mini.otel.tpl / scripts/launch.sh) — the
# HyperDX ingestion key is seeded separately from everything else here.
OTEL_SERVICE_NAME=research-gateway
OTEL_RESOURCE_ATTRIBUTES=host.name=mini

# Matches .env.local.tpl's own default — repeated here so the mini's
# concurrency ceiling is a deliberate, visible choice rather than an
# inherited default.
RESEARCH_MAX_CONCURRENCY=3
