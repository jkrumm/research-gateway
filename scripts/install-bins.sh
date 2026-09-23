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

# Same pin as ../Dockerfile's YTDLP_VERSION. The Dockerfile uses the musllinux
# asset (alpine/musl container); this is the plain macOS asset for the native
# LaunchAgent.
install_bin yt-dlp 2026.07.04 \
  "https://github.com/yt-dlp/yt-dlp/releases/download/2026.07.04/yt-dlp_macos" \
  498bd0dae17855c599d371d68ec5bafc439a9d8640e838be25c765a9792f261b \
  "--version" || exit_status=1

exit $exit_status
