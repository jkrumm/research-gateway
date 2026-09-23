#!/bin/zsh
# research-gateway/scripts/install-bins.sh — pins the two native binaries the
# mini's LaunchAgents need (lightpanda, yt-dlp) into ~/.research-gateway/bin,
# matching the SAME version the Dockerfiles pin for the VPS containers
# (lightpanda/Dockerfile, ../Dockerfile). Idempotent: a binary already at its
# pinned checksum is left alone — re-run any time, called by `make mini-setup`.
#
# When bumping a pin here, bump the matching Dockerfile pin too (and vice
# versa) — the mini and the VPS container must never run different versions
# of the same tool.

set -u

BIN_DIR="$HOME/.research-gateway/bin"
mkdir -p "$BIN_DIR"

# $1 name  $2 version (log only)  $3 download url  $4 pinned sha256  $5 smoke-test args
install_bin() {
  local name="$1" version="$2" url="$3" sha="$4" smoke="$5"
  local dest="$BIN_DIR/$name"

  if [[ -f "$dest" ]] && echo "${sha}  ${dest}" | shasum -a 256 -c - >/dev/null 2>&1; then
    print "OK  $name $version already installed, checksum matches pin — skipping download"
  else
    # Download to a temp file IN THE SAME DIR (so the final `mv` is a same-filesystem rename,
    # atomic rather than a copy) and verify before it ever occupies $dest — a curl that dies
    # partway, or a checksum mismatch, must never leave an unverified binary at the path
    # launchd is configured to spawn.
    local tmp
    tmp=$(mktemp "${dest}.XXXXXX")
    print -- "->  downloading $name $version"
    if ! curl -fsSL -o "$tmp" "$url"; then
      print -u2 "FAIL  $name: download failed ($url)"
      rm -f "$tmp"
      return 1
    fi
    if ! echo "${sha}  ${tmp}" | shasum -a 256 -c - >/dev/null 2>&1; then
      print -u2 "FAIL  $name: sha256 mismatch against the pinned checksum — refusing to install"
      rm -f "$tmp"
      return 1
    fi
    mv -f "$tmp" "$dest"
  fi

  chmod 0755 "$dest"
  # A binary fetched via curl (not through Gatekeeper's normal download path)
  # usually carries no quarantine xattr, but strip it defensively — a
  # quarantined binary launchd spawns headless fails with no dialog for
  # anyone to click through.
  xattr -d com.apple.quarantine "$dest" 2>/dev/null || true

  print -- "->  smoke test: $dest ${=smoke}"
  if ! "$dest" ${=smoke} >/dev/null; then
    print -u2 "FAIL  $name: smoke test failed"
    return 1
  fi
  print "OK  $name $version ready at $dest"
}

# NOTE: not named `status` — zsh reserves that as a read-only synonym for $?.
exit_status=0

# Same pin as lightpanda/Dockerfile's LIGHTPANDA_VERSION/LIGHTPANDA_SHA256_ARM64
# (that one is the linux/arm64 asset for the Docker container; this is the
# native aarch64-macos asset — different binary, same upstream release).
install_bin lightpanda 0.3.6 \
  "https://github.com/lightpanda-io/browser/releases/download/0.3.6/lightpanda-aarch64-macos" \
  33568934d374daf9012b9be0847fd82a99dd9f1cb2f2f93bb783cc78a96c99ac \
  "version" || exit_status=1

# Same pin as ../Dockerfile's YTDLP_VERSION, but the ONEDIR macOS build, not the onefile
# `yt-dlp_macos`: measured 2026-09-23, the onefile build unpacks into a fresh temp dir on every
# run and Gatekeeper re-scans the unpacked dylibs each time — 8.5s per call, every call, which
# timed out /health/ytdlp and would eat most of a transcript fetch. The onedir build pays that
# scan once (first run ~8s) and then starts in ~0.3s.
install_ytdlp() {
  local version=2026.07.04 sha=b0724470a0cf6dae5175a87eee05d6e75c5a0c10d2c3015166bd4d34e92b1b7b
  # Versioned dist dir, not a fixed "yt-dlp-dist" name — a version bump then installs into a
  # BRAND NEW directory that coexists with the currently-live one, so the repoint below (ln -sfn)
  # is the only moment `bin/yt-dlp` ever changes, and it changes atomically (rename(2) under the
  # hood). The old fixed-name scheme instead did `rm -rf "$dist" && mv ... "$dist"` on the SAME
  # path `bin/yt-dlp` was already symlinked into — a reader hitting that path mid-swap could see
  # ENOENT.
  local dist="$BIN_DIR/yt-dlp-dist-$version"
  local stamp="$dist/.sha256"

  # Sweep scratch dirs (`mktemp -d "$BIN_DIR/yt-dlp.XXXXXX"` below) left behind by a run that
  # crashed or was killed between mktemp and the final `mv` — nothing else ever removes them.
  local leftover
  for leftover in "$BIN_DIR"/yt-dlp.*(N); do
    print -- "->  removing stale scratch dir $leftover"
    rm -rf "$leftover"
  done

  if [[ -x "$dist/yt-dlp_macos" && "$(cat "$stamp" 2>/dev/null)" == "$sha" ]]; then
    print "OK  yt-dlp $version already installed, checksum matches pin — skipping download"
  else
    local tmp
    tmp=$(mktemp -d "$BIN_DIR/yt-dlp.XXXXXX")
    print -- "->  downloading yt-dlp $version (onedir)"
    if ! curl -fsSL -o "$tmp/y.zip" "https://github.com/yt-dlp/yt-dlp/releases/download/$version/yt-dlp_macos.zip"; then
      print -u2 "FAIL  yt-dlp: download failed"; rm -rf "$tmp"; return 1
    fi
    if ! echo "${sha}  $tmp/y.zip" | shasum -a 256 -c - >/dev/null 2>&1; then
      print -u2 "FAIL  yt-dlp: sha256 mismatch against the pinned checksum — refusing to install"; rm -rf "$tmp"; return 1
    fi
    mkdir "$tmp/dist" && unzip -q "$tmp/y.zip" -d "$tmp/dist" || { print -u2 "FAIL  yt-dlp: unzip failed"; rm -rf "$tmp"; return 1; }
    print -r -- "$sha" > "$tmp/dist/.sha256"
    xattr -dr com.apple.quarantine "$tmp/dist" 2>/dev/null || true
    # `$dist` is a fresh versioned path that should not already exist (the `-x` check above
    # would have skipped this branch if it did) — the `rm -rf` here only clears a partial dir
    # left by an earlier FAILED attempt at this same version, never the live one.
    rm -rf "$dist" && mv "$tmp/dist" "$dist" && rm -rf "$tmp"
  fi

  # Atomic repoint: `ln -sfn` replaces the symlink target in one syscall — bin/yt-dlp (what
  # YTDLP_PATH points at) is never observed missing or half-written, on a fresh install or a
  # version bump alike.
  ln -sfn "$dist/yt-dlp_macos" "$BIN_DIR/yt-dlp"
  print -- "->  smoke test: $BIN_DIR/yt-dlp --version (first run after install pays the one-time scan)"
  "$BIN_DIR/yt-dlp" --version >/dev/null || { print -u2 "FAIL  yt-dlp: smoke test failed"; return 1; }
  print "OK  yt-dlp $version ready at $BIN_DIR/yt-dlp"

  # Only now that bin/yt-dlp is confirmed live and working: sweep every OTHER dist dir, versioned
  # or not — this is what carries an existing install across the migration, cleaning up the
  # pre-migration fixed-name `yt-dlp-dist` left by an earlier version of this script.
  local old
  for old in "$BIN_DIR"/yt-dlp-dist*(N); do
    [[ "$old" == "$dist" ]] && continue
    print -- "->  removing stale dist dir $old"
    rm -rf "$old"
  done
}
install_ytdlp || exit_status=1

exit $exit_status
