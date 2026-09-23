#!/bin/zsh
# research-gateway launcher — the ProgramArguments of com.jkrumm.research-gateway
# (mini native instance, :7780, alongside the VPS Docker container). Pattern
# copied from audio-gateway's scripts/launch.sh: never point launchd at a
# Homebrew binary directly (macOS BTM silently disallows it) — this wrapper is
# the required indirection, and it fails closed if any referenced secret
# can't resolve.
#
# Runs from the DEDICATED deploy clone (~/.research-gateway/app), never the
# dev checkout at ~/SourceRoot/research-gateway — the dev checkout is edited
# constantly by agents and a dirty tree must never go live. See Makefile's
# mini-setup and scripts/mini-deploy.sh.

set -u

DIR="${0:A:h:h}"  # scripts/launch.sh -> repo root
cd "$DIR" || { print -u2 "research-gateway: cannot cd to $DIR"; exit 78; }

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

# `timeout` is a Homebrew coreutils binary (macOS ships none) — resolve it once, falling back
# to `gtimeout` (the name coreutils installs it under when GNU-prefixed), and fail closed with
# a dedicated error rather than let a missing binary read as an unrelated "command not found".
TIMEOUT_BIN=""
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_BIN="timeout"
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_BIN="gtimeout"
else
  print -u2 "research-gateway: neither 'timeout' nor 'gtimeout' found on PATH — install coreutils (brew install coreutils)"
  exit 78
fi

SECRETS_RUN="$HOME/.local/bin/secrets-run"
TPL_BASE="$DIR/.env.local.tpl"
TPL_MINI="$DIR/.env.mini.tpl"

[[ -x "$SECRETS_RUN" ]] || { print -u2 "research-gateway: $SECRETS_RUN missing"; exit 78; }
[[ -f "$TPL_BASE" ]]   || { print -u2 "research-gateway: $TPL_BASE missing"; exit 78; }
[[ -f "$TPL_MINI" ]]   || { print -u2 "research-gateway: $TPL_MINI missing"; exit 78; }

# Assert every ref resolves BEFORE handing off — an unresolved ${VAR} would
# otherwise reach the process as a literal string, not fail loudly.
RENDERED=$("$TIMEOUT_BIN" 20 "$SECRETS_RUN" export --env-file="$TPL_BASE" --env-file="$TPL_MINI" 2>/dev/null | /usr/bin/grep -c '^export ')
# Unique keys across both files — the overlay overrides some base keys (last wins).
WANT=$(/usr/bin/grep -hoE '^[A-Za-z_][A-Za-z0-9_]*=' "$TPL_BASE" "$TPL_MINI" | /usr/bin/sort -u | /usr/bin/wc -l | /usr/bin/tr -d ' ')
if [[ -z "$RENDERED" || "$RENDERED" -lt "$WANT" ]]; then
  print -u2 "research-gateway: only ${RENDERED:-0}/$WANT refs resolved — refusing to start."
  print -u2 "  Seed the missing refs (add to dotfiles-private/headless.refs, then"
  print -u2 "  \`make secrets-seed\` on the MacBook) and retry."
  exit 78
fi

# OTel export is an optional overlay: its ingestion key is seeded separately,
# and secrets-run fails closed on ANY unresolved ref in a file — so probe it
# on its own and start without it rather than not at all. RESEARCH_GATEWAY_DEGRADED
# is exported for GET /health's `degraded` field (src/env.ts parses it into the
# array the route and the boot log read) — same shape audio-gateway's
# AUDIO_GATEWAY_DEGRADED/`config.degraded` overlay-visibility field uses.
DEGRADED=()

# $1 = overlay name, $2 = template path, $3 = the op:// refs it needs. Sets
# REPLY to the overlay's --env-file argument on success (no command
# substitution — a subshell could not append to DEGRADED); records the name
# otherwise.
overlay_args() {
  local name="$1" tpl="$2" refs="$3"
  if [[ -f "$tpl" ]] && "$TIMEOUT_BIN" 20 "$SECRETS_RUN" export --env-file="$tpl" >/dev/null 2>&1; then
    REPLY="--env-file=$tpl"
    return 0
  fi
  local unresolved
  unresolved=$(/usr/bin/grep -hoE '^[A-Za-z_][A-Za-z0-9_]*=op://[^[:space:]]+' "$tpl" 2>/dev/null | /usr/bin/sed 's/^[^=]*=//' | /usr/bin/tr '\n' ' ')
  print -u2 "research-gateway: ERROR overlay '$name' ($tpl) does not resolve — refs: ${unresolved:-$refs}. Starting DEGRADED without it (seed the ref(s) via \`make secrets-seed\` on the MacBook, then \`make launchd-restart\`)."
  DEGRADED+=("$name")
  return 1
}

OTEL_ARGS=()
if overlay_args otel "$DIR/.env.mini.otel.tpl" "op://vps/argo/HYPERDX_API_KEY_PROD"; then OTEL_ARGS=("$REPLY"); fi

GITHUB_ARGS=()
if overlay_args github "$DIR/.env.mini.github.tpl" "op://vps/research-gateway/GITHUB_TOKEN"; then GITHUB_ARGS=("$REPLY"); fi

export RESEARCH_GATEWAY_DEGRADED="${(j:,:)DEGRADED}"

# Templates can't expand $HOME (secrets-run/op inject render literal text) —
# compute the mini's absolute data paths here and export them so bun/zod see
# them via process.env directly. Both live under the dedicated deploy layout
# (~/.research-gateway/{data,bin}), never inside this repo checkout — see
# src/env.ts's JOB_DB_PATH/YTDLP_PATH defaults, which this overrides.
export JOB_DB_PATH="$HOME/.research-gateway/data/jobs.sqlite"
export YTDLP_PATH="$HOME/.research-gateway/bin/yt-dlp"

exec "$SECRETS_RUN" run --env-file="$TPL_BASE" --env-file="$TPL_MINI" "${OTEL_ARGS[@]}" "${GITHUB_ARGS[@]}" -- bun run src/index.ts
