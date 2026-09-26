#!/bin/zsh
# research-gateway/scripts/mini-deploy.sh — the mini's "push to master
# deploys" equivalent of rollhook: there is no webhook receiver on this box,
# so com.jkrumm.research-gateway-deploy polls this every 2 minutes instead
# (launchd/com.jkrumm.research-gateway-deploy.plist.template, StartInterval).
#
# Everything lives inside `main`, invoked only on the LAST line. This file is
# itself tracked in the repo `main` pulls from — the `git reset --hard`
# partway through rewrites THIS FILE on disk mid-run if it changed upstream.
# zsh parses a `function name { ... }` block into one compiled unit at
# definition time (reading up to the matching `}` before anything inside it
# runs), so once `main` has been defined — which happens before the reset
# ever executes — the reset changing the file on disk does not affect the
# already-parsed body still running inside it. Do not move logic outside
# `main`, and do not `source` this file.

set -u

APP_DIR="$HOME/.research-gateway/app"
DATA_DIR="$HOME/.research-gateway/data"
LOCK_DIR="$DATA_DIR/mini-deploy.lock"
DEPLOYED_SHA_FILE="$DATA_DIR/deployed-sha"
HEALTH_URL="http://127.0.0.1:7780/health"
LABEL_GATEWAY="com.jkrumm.research-gateway"
LABEL_LIGHTPANDA="com.jkrumm.research-gateway-lightpanda"

# The name of ci.yml's job — GitHub creates a check run under this exact name (no explicit
# `name:` override in the workflow, so it defaults to the job id). ci_gate_status matches
# against it, never a hand-rolled webhook.
CI_CHECK_NAME="check"
CI_REPO="jkrumm/research-gateway"

# git's well-known hash of the empty tree — diffing against it lists every path in the target
# commit, which is the fallback used when there is no trustworthy deployed-sha to diff from.
EMPTY_TREE_SHA="4b825dc642cb6eb9a060e54bf8d69288fbee4904"

# A lock older than this is reclaimed regardless of whether its holder pid looks alive — a
# hang-guard floor, not a tuning default. The slowest real tick is the post-restart health
# poll below (up to 1860s); 2h clears that with room for a genuinely wedged process to still
# be caught rather than wedging every future tick forever.
STALE_LOCK_SECS=$((2 * 60 * 60))

# Matches the post-restart health-poll window: keep retrying past a `draining: true` /
# unreachable response for up to this long before declaring the deploy failed. Same value as
# SHUTDOWN_DRAIN_MS's neighbor in src/env.ts (1860s, strictly above the 1800s drain itself) —
# a restarted process can legitimately still be draining its PREVIOUS instance's jobs for
# nearly that whole window.
HEALTH_POLL_SECS=1860

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

log() {
  print "[$(date '+%Y-%m-%dT%H:%M:%S%z')] $*"
}

# Atomic write: temp file in the same dir, then `mv` — a reader (this script, next tick) must
# never observe a partially-written deployed-sha.
write_deployed_sha() {
  local sha="$1" tmp
  tmp="$DEPLOYED_SHA_FILE.tmp.$$"
  print -r -- "$sha" > "$tmp" && mv -f "$tmp" "$DEPLOYED_SHA_FILE"
}

# Prints one of success|pending|failure|unreachable for $1 (a full SHA) to stdout — never
# blocks the tick indefinitely (bounded by curl's --max-time) and never throws, since main()
# must keep polling on every outcome but success. The token is the same push credential
# git already uses (op://mini/github/token, dotfiles' git-credential-secrets-cache) — read via
# secrets-run, never `op read`/`op run` (those hang on a biometric prompt no one on this box can
# answer). A GitHub PAT authenticates the REST API the same way it authenticates git over
# HTTPS, so no separate token is provisioned for this.
ci_gate_status() {
  local sha="$1" token resp
  token=$(secrets-run read op://mini/github/token 2>/dev/null)
  if [[ -z "$token" ]]; then
    print "unreachable"
    return 0
  fi

  resp=$(curl -fsS --max-time 10 \
    -H "Authorization: Bearer $token" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$CI_REPO/commits/$sha/check-runs" 2>/dev/null)
  if [[ -z "$resp" ]]; then
    print "unreachable"
    return 0
  fi

  print -r -- "$resp" | jq -r --arg name "$CI_CHECK_NAME" '
    [.check_runs[]? | select(.name == $name)] as $runs
    | if ($runs | length) == 0 then "unreachable"
      elif ($runs | map(.status) | any(. != "completed")) then "pending"
      elif ($runs | map(.conclusion) | all(. == "success")) then "success"
      else "failure"
      end
  ' 2>/dev/null || print "unreachable"
}

# mkdir is atomic — the lock a concurrent tick (a slow deploy overrunning the next 2-minute
# StartInterval fire) cannot also acquire. On contention, a stale lock (holder pid no longer
# alive, or the lock has simply outlived STALE_LOCK_SECS) is reclaimed instead of wedging
# every future tick behind a process that crashed or was killed without cleaning up after
# itself — nothing else ever removes $LOCK_DIR.
acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    print $$ > "$LOCK_DIR/pid"
    return 0
  fi

  local holder_pid mtime now age
  holder_pid=$(cat "$LOCK_DIR/pid" 2>/dev/null)
  mtime=$(stat -f %m "$LOCK_DIR" 2>/dev/null || print 0)
  now=$(date +%s)
  age=$((now - mtime))

  if [[ -n "$holder_pid" ]] && kill -0 "$holder_pid" 2>/dev/null && (( age < STALE_LOCK_SECS )); then
    return 1  # genuinely held by a live process, and not stale yet
  fi

  # Either the holder pid is dead, or the lock has simply outlived STALE_LOCK_SECS — reclaim
  # it. `rm -rf` (not `rmdir`) because the lock dir holds the pid file; the subsequent `mkdir`
  # is still the atomicity boundary — only one concurrent reclaimer wins it, the other just
  # returns 1 and retries next tick.
  rm -rf "$LOCK_DIR" 2>/dev/null
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    log "reclaimed stale lock at $LOCK_DIR (holder pid ${holder_pid:-unknown}, age ${age}s)"
    print $$ > "$LOCK_DIR/pid"
    return 0
  fi
  return 1
}

main() {
  # `make mini-setup` already creates DATA_DIR, but make it idempotently here
  # too — otherwise a missing parent directory makes the lock mkdir below
  # fail exactly like "another tick is running", which is the wrong error to
  # surface for a setup problem.
  mkdir -p "$DATA_DIR"

  if ! acquire_lock; then
    log "another mini-deploy tick is still holding $LOCK_DIR — skipping this tick"
    return 0
  fi
  trap 'rm -rf "$LOCK_DIR" 2>/dev/null' EXIT INT TERM

  if [[ ! -d "$APP_DIR/.git" ]]; then
    log "ERROR: $APP_DIR is not a git clone yet — run 'make mini-setup' first"
    return 1
  fi

  if ! git -C "$APP_DIR" fetch --quiet origin master; then
    log "ERROR: git fetch origin master failed (network or credential-helper) — will retry next tick"
    return 1
  fi

  # The deployed-sha marker (not git HEAD) is the source of truth for "is a deploy needed" —
  # it is written ONLY after install succeeded and the restart came back healthy (or no
  # restart was needed), whereas `git reset --hard` below moves HEAD unconditionally before
  # any of that is known. Gating on HEAD==origin (the old behavior) meant a failed install or
  # an unhealthy restart left HEAD already at origin's commit, so the NEXT tick saw
  # head==origin and exited early without ever retrying. Missing file reads as "" — never
  # equal to a real sha — so a fresh clone with no marker yet always needs-deploy.
  local origin_head deployed_sha
  origin_head=$(git -C "$APP_DIR" rev-parse origin/master)
  deployed_sha=$(cat "$DEPLOYED_SHA_FILE" 2>/dev/null || print '')
  if [[ -n "$deployed_sha" && "$deployed_sha" == "$origin_head" ]]; then
    return 0  # up to date — the common case, no log line for it
  fi

  # CI gate: never deploy a SHA GitHub Actions hasn't (yet, or ever) called green. A red or
  # still-running check must not go live just because the poller happened to fire in the gap.
  local ci_status
  ci_status=$(ci_gate_status "$origin_head")
  case "$ci_status" in
    success) ;;
    pending)
      log "waiting for CI on ${origin_head[1,12]} — skipping this tick"
      return 0
      ;;
    failure)
      log "ERROR: CI failed on ${origin_head[1,12]} — refusing to deploy, will retry next tick"
      return 0
      ;;
    *)
      log "ERROR: GitHub check-runs API unreachable for ${origin_head[1,12]} — refusing to deploy unchecked, will retry next tick"
      return 0
      ;;
  esac

  # Idle gate: a down service can't lose jobs, so an unreachable /health
  # deploys anyway rather than wedging every future tick behind a dead
  # process. A reachable-but-busy service defers — the next tick retries.
  local health running=0 queued=0
  if health=$(curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null); then
    running=$(print -r -- "$health" | jq -r '.jobs.running // 0' 2>/dev/null || print 0)
    queued=$(print -r -- "$health" | jq -r '.jobs.queued // 0' 2>/dev/null || print 0)
    if (( running + queued > 0 )); then
      log "deferred: $running running + $queued queued job(s) — will retry next tick"
      return 0
    fi
  else
    log "GET $HEALTH_URL unreachable — deploying anyway (a down service cannot lose jobs)"
  fi

  # Diff from deployed-sha, not HEAD — HEAD only ever equals origin (see the reset below), so
  # diffing from it would always report zero changed paths on a retry after a failed install.
  # If deployed-sha is missing, or is no longer an ancestor of origin/master (a force-push, or
  # this is the very first deploy), there is no trustworthy base to diff from: fall back to
  # diffing against the empty tree, which lists every path in origin/master and so classifies
  # everything below as changed — the safe default (full install + full restart).
  local base_ref="$EMPTY_TREE_SHA"
  if [[ -n "$deployed_sha" ]] \
    && git -C "$APP_DIR" cat-file -e "${deployed_sha}^{commit}" 2>/dev/null \
    && git -C "$APP_DIR" merge-base --is-ancestor "$deployed_sha" "$origin_head" 2>/dev/null; then
    base_ref="$deployed_sha"
  fi

  local changed
  changed=$(git -C "$APP_DIR" diff --name-only "$base_ref" "$origin_head")
  local -a changed_arr
  changed_arr=("${(@f)changed}")
  local from_label="none"
  [[ -n "$deployed_sha" ]] && from_label="${deployed_sha[1,12]}"
  log "deploying $from_label -> ${origin_head[1,12]} (${#changed_arr} changed path(s): ${(j:, :)changed_arr[1,20]}${${changed_arr[21]:+, …}:-})"

  if ! git -C "$APP_DIR" reset --hard origin/master >/dev/null; then
    log "ERROR: git reset --hard origin/master failed"
    return 1
  fi

  local deps_changed=0 restart_needed=0 lightpanda_changed=0 launchd_changed=0 install_bins_changed=0
  local f
  for f in "${changed_arr[@]}"; do
    case "$f" in
      package.json|bun.lock) deps_changed=1; restart_needed=1 ;;
      *.md|docs/*) ;;  # docs-only changes never restart anything
      lightpanda/*) lightpanda_changed=1; restart_needed=1 ;;
      launchd/*) launchd_changed=1 ;;
      scripts/install-bins.sh) install_bins_changed=1; restart_needed=1 ;;
      *) restart_needed=1 ;;
    esac
  done

  if [[ "$deps_changed" -eq 1 ]]; then
    log "package.json/bun.lock changed — bun install --frozen-lockfile --production"
    if ! (cd "$APP_DIR" && bun install --frozen-lockfile --production); then
      log "ERROR: bun install failed — leaving the gateway on its current running build"
      return 1
    fi
  fi

  # scripts/install-bins.sh pins lightpanda/yt-dlp into ~/.research-gateway/bin — a change to
  # it (a version bump, a checksum rotation) must be applied to those pinned binaries BEFORE the
  # gateway restarts onto whatever code now expects them, same reasoning as deps_changed above.
  # A non-zero exit here fails the whole deploy: no deployed-sha is written (below), so the next
  # tick retries from the same starting point rather than restarting onto mismatched binaries.
  if [[ "$install_bins_changed" -eq 1 ]]; then
    log "scripts/install-bins.sh changed — running it before restart"
    if ! (cd "$APP_DIR" && ./scripts/install-bins.sh); then
      log "ERROR: install-bins.sh failed — leaving the gateway on its current running build"
      return 1
    fi
  fi

  if [[ "$launchd_changed" -eq 1 ]]; then
    log "WARNING: launchd/ templates changed — this deploy does NOT re-render or reload plists. Run 'make launchd-install' by hand to pick up the change."
  fi

  if [[ "$restart_needed" -eq 0 ]]; then
    write_deployed_sha "$origin_head"
    log "deployed $(git -C "$APP_DIR" rev-parse --short HEAD) — no restart-worthy paths changed, gateway left running"
    return 0
  fi

  # `kickstart -k` returns before the old process is gone, so the first /health answers can
  # still come from it — the first live deploy logged "healthy" off the OLD process. Only a
  # changed `lastRestartAt` proves the new one is serving.
  local prev_restart
  prev_restart=$(curl -fsS --max-time 2 "$HEALTH_URL" 2>/dev/null | jq -r '.lastRestartAt // ""' 2>/dev/null)

  log "restarting $LABEL_GATEWAY"
  launchctl kickstart -k "gui/$(id -u)/$LABEL_GATEWAY" 2>&1 | while IFS= read -r l; do log "  $l"; done

  if [[ "$lightpanda_changed" -eq 1 ]]; then
    log "restarting $LABEL_LIGHTPANDA (lightpanda/ changed)"
    launchctl kickstart -k "gui/$(id -u)/$LABEL_LIGHTPANDA" 2>&1 | while IFS= read -r l; do log "  $l"; done
  fi

  # Reachable AND not draining is "healthy" — a freshly kickstarted process can legitimately
  # still be draining its previous instance's in-flight jobs (index.ts's SIGTERM path), so
  # `draining: true` keeps polling rather than failing fast at the old 60s ceiling. Unreachable
  # (curl failure, non-2xx, unparseable body) also keeps polling — only the full window elapsing
  # without ever observing a healthy response is a failure.
  # `health` is already a local above — re-declaring it with `local` makes zsh print its value.
  local i=0 ok=0 draining restarted_at
  while (( i < HEALTH_POLL_SECS )); do
    if health=$(curl -fsS --max-time 2 "$HEALTH_URL" 2>/dev/null); then
      draining=$(print -r -- "$health" | jq -r '.draining // false' 2>/dev/null || print true)
      restarted_at=$(print -r -- "$health" | jq -r '.lastRestartAt // ""' 2>/dev/null)
      if [[ "$draining" != "true" && -n "$restarted_at" && "$restarted_at" != "$prev_restart" ]]; then
        ok=1
        break
      fi
    fi
    sleep 1; i=$((i + 1))
  done

  local sha
  sha=$(git -C "$APP_DIR" rev-parse --short HEAD)
  if [[ "$ok" -eq 1 ]]; then
    write_deployed_sha "$origin_head"
    log "deploy OK — $sha up and healthy after restart"
  else
    log "ERROR: deploy of $sha did NOT come back healthy within ${HEALTH_POLL_SECS}s (unreachable or still draining) — check ~/Library/Logs/research-gateway.err"
    return 1
  fi
}

main
