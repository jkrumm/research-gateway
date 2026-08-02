# syntax=docker/dockerfile:1
#
# The JavaScript-rendering sidecar. Built and deployed independently of the gateway
# (.github/workflows/deploy-lightpanda.yml, image `research-gateway-lightpanda`) because it
# changes on its own schedule — pinning a new browser version has nothing to do with a gateway
# release, and rebuilding a 153 MB download on every gateway push is waste.
#
# Base is DEBIAN, not the alpine the gateway uses, and that is not a preference: the lightpanda
# binary is dynamically linked against glibc (libc.so.6, ld-linux-x86-64.so.2), so it cannot
# execute on musl at all. Verified with `ldd` on the release asset before this was written.
FROM oven/bun:1.3-slim AS runner

# Pinned to a tagged release rather than the `nightly` tag the docs point at. Nightly is a
# moving asset behind a fixed URL: the same build would pull different bytes on different days,
# and the checksums below could not exist. 0.3.6 was measured against nightly on the pages this
# service actually fails on and is equivalent (techempower.com/benchmarks: 4,627 vs ~4,704
# chars, within run-to-run variance) while carrying every flag this depends on, including
# --v8-max-heap-mb.
#
# Upgrading is deliberate: bump the version, replace BOTH checksums (from the release page or
# `sha256sum` on the downloaded asset), rebuild. A wrong or stale checksum fails the build
# loudly, which is the point.
ARG LIGHTPANDA_VERSION=0.3.6
ARG LIGHTPANDA_SHA256_AMD64=e438c0ad44e0f6916c14cf13beb003512c60438d8fd200738d2e596e73f652d6
ARG LIGHTPANDA_SHA256_ARM64=29c059cd0755a195350cc79dbcf7ee9580fd575ec3eaa31db755dbada417e616

# ca-certificates is load-bearing, not hygiene: without a trust store lightpanda cannot
# complete TLS to any target and every render fails. curl serves the download below and the
# healthcheck at the bottom.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
  rm -f /etc/apt/apt.conf.d/docker-clean \
  && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl

ARG TARGETARCH
RUN set -eu; \
  case "$TARGETARCH" in \
  amd64) asset=lightpanda-x86_64-linux; sha=$LIGHTPANDA_SHA256_AMD64 ;; \
  arm64) asset=lightpanda-aarch64-linux; sha=$LIGHTPANDA_SHA256_ARM64 ;; \
  *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
  esac; \
  curl -fsSL -o /usr/local/bin/lightpanda \
  "https://github.com/lightpanda-io/browser/releases/download/${LIGHTPANDA_VERSION}/${asset}"; \
  echo "${sha}  /usr/local/bin/lightpanda" | sha256sum -c -; \
  chmod 0755 /usr/local/bin/lightpanda; \
  lightpanda version

WORKDIR /app
COPY --chown=bun:bun parse.ts server.ts ./

ENV NODE_ENV=production
EXPOSE 7781

# The bun image ships this user. Rendering hostile third-party JavaScript is the last thing
# that should be running as root.
USER bun

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -fsS http://localhost:7781/health || exit 1

CMD ["bun", "run", "server.ts"]
