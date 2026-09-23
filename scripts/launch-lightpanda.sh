#!/bin/zsh
# lightpanda sidecar launcher — the ProgramArguments of
# com.jkrumm.research-gateway-lightpanda (mini native instance, :7781). No
# secrets: lightpanda/server.ts reads plain env vars only (numberFromEnv,
# LIGHTPANDA_BIN) — no secrets-run wrapper needed since nothing here is an
# op:// ref.
#
# Runs from the DEDICATED deploy clone (~/.research-gateway/app/lightpanda),
# same reasoning as scripts/launch.sh — never the dev checkout.

set -u

DIR="${0:A:h:h}/lightpanda"  # scripts/launch-lightpanda.sh -> repo root/lightpanda
cd "$DIR" || { print -u2 "research-gateway-lightpanda: cannot cd to $DIR"; exit 78; }

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

export PORT=7781
export LIGHTPANDA_BIN="$HOME/.research-gateway/bin/lightpanda"
export NODE_ENV=production

# Loopback only: the render endpoint is unauthenticated, and 7781 sits inside the
# tailnet ACL's tcp:7700-7799 grant — all interfaces would hand any tailnet peer a
# browser that runs on this machine.
export HOST=127.0.0.1

exec bun run server.ts
