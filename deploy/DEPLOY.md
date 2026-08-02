# Deploying research-gateway to the VPS

Ingress is **Tailscale-only** — a grey-cloud DNS-only A record (`research.<domain>` → the VPS
Tailscale IP) routed to **Traefik v3**, *not* through the Cloudflare Tunnel (same pattern as `argo`
and `audio-gateway`). Deploys are **label-driven via rollhook** (OIDC, zero-downtime). The app repo
ships only the code, `Dockerfile`, and the `.github/workflows/deploy.yml` trigger. The compose
file, the prod `.env`, and the Cloudflare DNS record live in the **`vps`** repo + the Cloudflare
dashboard.

> The `op://` refs were confirmed against the live vault and the vps `.env.tpl` on 2026-07-17.
> Note the Tavily key lives on the **shared** item, not a gateway-specific one.

## 0. Gating pre-check — IU reachability from the VPS (do this FIRST)

The gateway calls the IU unified endpoint **directly** from the VPS (the Mac-local LiteLLM
bridge is unreachable from there). Before anything else, verify the IU gateway is publicly
reachable from the VPS with the key — if it is VPN/localhost-bound, the whole LLM-path
decision reopens.

```bash
ssh vps
# Pull the IU base URL + key from 1Password (or read them from the materialized .env)
curl -sS -X POST "$IU_BASE_URL/chat/completions" \
  -H "Authorization: Bearer $IU_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"DeepSeek-V4-Pro","messages":[{"role":"user","content":"ping"}],"max_tokens":5}'
```

A normal completion response → proceed. A timeout / connection-refused / 401 → stop and resolve
before building further.

## 1. Create the 1Password items

Create the gateway-specific secrets (account `tkrumm`):

- `op://vps/research-gateway/API_SECRET` — generate a strong random bearer (the gateway's token).
- `op://common/tavily/API_KEY` — the Tavily key. Shared item; there is no gateway-specific one.
- `op://vps/research-gateway/CONTEXT7_API_KEY` — optional; a `ctx7sk_` key. Omit to run without the `libraryDocs` tool.
- `op://vps/research-gateway/GITHUB_TOKEN` — a fine-grained PAT with **no** permissions
  (public read only). Raises the `githubFile`/`githubRepo`/`findPackages` budget from
  anonymous 60 req/h *per IP, shared across every concurrent job* to 5000 req/h. The field
  may be left **empty**: the gateway treats an empty value as unset and falls back to
  anonymous, so `.env.tpl` can reference it before a token exists.

> **The VPS 1Password service account is read-only** (`op item create` → `(101) You do not
> have permission`). Items and fields must be created from the MacBook with the interactive,
> biometric `op`; the VPS only ever reads them.

`IU_*` and `ARGO_API_SECRET` reuse existing shared items (`op://common/anthropic/*`, `op://common/api/SECRET`).

## 2. Add the service to the vps repo

```bash
mkdir -p ~/SourceRoot/vps/apps/research-gateway
cp deploy/compose.yml  ~/SourceRoot/vps/apps/research-gateway/compose.yml
cp deploy/.env.tpl     ~/SourceRoot/vps/apps/research-gateway/.env.tpl
```

> **`compose.yml` is a template — the vps repo holds its own copy, not a symlink.** Any edit
> made here (e.g. the `research-gateway-data` named volume, added for the job-store durability
> change) must be re-applied by hand to `~/SourceRoot/vps/apps/research-gateway/compose.yml` —
> `cp`-ing over it blindly would also clobber any vps-repo-local drift, so diff before copying.

Add Makefile targets in the vps repo mirroring the `argo-*` ones (`research-gateway-up`,
`-down`, `-env`, `-redeploy`, `-bootstrap-image`). The env target is:

```make
research-gateway-env:
	op --account tkrumm inject -i apps/research-gateway/.env.tpl -o apps/research-gateway/.env -f
	chmod 644 apps/research-gateway/.env
```

Run `make research-gateway-env` to materialize the gitignored `.env`. Re-run after rotating any secret.

## 3. Cloudflare DNS (Tailscale-only)

The gateway is **tailnet-only** — every consumer (Claude Code, Hermes) is on the tailnet, so it is
*not* exposed to the public internet. Access is gated at the DNS layer (a grey-cloud A record to a
CGNAT address is unreachable off-tailnet); the bearer token is defense-in-depth on top.

Add the DNS record exactly like `audio-gateway` / `argo` (via the `/cloudflare` skill or the
dashboard):

- `research.<your-domain>` → **A record, DNS-only (grey cloud, `proxied:false`)** → the VPS
  Tailscale IP (`op://vps/config/VPS_TAILSCALE_IP`).

**Do NOT** add it to the cloudflared tunnel ingress. Traefik's `:443` is already bound to the
Tailscale interface and the wildcard `*.<domain>` DNS-01 cert already covers the hostname, so no
per-host tunnel entry and no separate cert issuance are needed.

## 4. Bootstrap + first deploy

1. `git init`, push the repo to `github.com/jkrumm/research-gateway` (default branch `master`).
2. Seed the initial registry image so rollhook has a container to authorize against
   (mirror argo's `bootstrap-image.sh`), then `make research-gateway-up` once on the VPS.
3. Subsequent deploys: push to `master` → the `deploy.yml` workflow calls rollhook-action (OIDC) →
   zero-downtime rolling update. The `rollhook.allowed_repos=jkrumm/research-gateway` label on the
   running container authorizes it.

## 5. Smoke test

```bash
TOKEN=$(op read "op://vps/research-gateway/API_SECRET" --account tkrumm)
BASE=https://research.<your-domain>

curl -sS "$BASE/health"                                   # {"status":"ok"} — tailnet-only

JOB=$(curl -sS -X POST "$BASE/research" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"current stable version of Elysia and how to register the openapi plugin","depth":"quick"}' \
  | jq -r .jobId)

curl -sS "$BASE/research/$JOB" -H "Authorization: Bearer $TOKEN" | jq   # poll until status=done
```

## 6. The JavaScript-rendering sidecar (first run only)

`lightpanda/` builds a **second image**, `research-gateway-lightpanda`, deployed by its own
workflow (`.github/workflows/deploy-lightpanda.yml`) so a browser-version bump does not restart
the gateway and kill in-flight jobs. Two consequences on a fresh server, both one-time:

- **RollHook tags by git SHA and never moves `:latest`**, so CI alone never produces the
  `:latest` tag `compose.yml` defaults to. `make research-gateway-bootstrap-image` builds and
  pushes both images (it was extended for this) — run it before the first
  `make research-gateway-up`.
- **The first `deploy-lightpanda.yml` run cannot deploy** if it lands before that container
  exists. It fails at the *token* step, before build or push, with:

  ```
  POST /auth/token failed (403): service not found — ensure the app is running
  before requesting a registry credential
  ```

  RollHook has nothing to roll and nothing to authorize the `rollhook.allowed_repos` label
  against. Bootstrap and `make research-gateway-up` is the fix. Observed on 2026-08-02: the
  deploy step retries, so a run that failed at 20:20 went green on its own at 20:28 once the
  container was up — no manual `gh workflow run` was needed. If it does not recover, dispatch
  it by hand. Either way it is not a code failure.

The sidecar needs **no secret and no `.env` entry**. It is reached over a compose-private
`render` network, and `LIGHTPANDA_URL` is set in `compose.yml`, not `.env.tpl` — the network is
what stands in for authentication, since the service's whole job is to fetch a URL it is given.
Unsetting `LIGHTPANDA_URL` takes the renderer out of the fetch chain without a gateway rebuild.

Verify after deploying — the check that matters is a page whose text is not in its HTML:

```bash
ssh vps 'docker exec $(docker ps -qf name=research-gateway-lightpanda) \
  curl -sS -m 90 -X POST http://localhost:7781/render \
  -H "content-type: application/json" \
  -d "{\"url\":\"https://www.techempower.com/benchmarks/\"}"' | head -c 200
# expect {"ok":true,...} with ~4600 chars — a plain fetch of that URL returns a 2 KB shell
```

## Notes / caveats

- **Job store persists to SQLite (status-only, heartbeat-reaped).** Job records (status,
  query/depth, and — once terminal — the full result or error) live in `bun:sqlite` at
  `/app/data/jobs.sqlite`, backed by the `research-gateway-data` named volume, so a `done` job
  stays retrievable with its result across a redeploy. This does **not** resume the agent's own
  in-flight work (tool calls, retrieval ledger) — checkpoint/resume is a separate, later change.
  A `queued`/`running` job only becomes a terminal `error` once its liveness **heartbeat** goes
  stale (>90s with no touch, or was never set) — see `lib/job-store.ts`'s `startHeartbeat` —
  never as a blanket "this process booted, so everything queued/running must be dead". That
  distinction is load-bearing: rollhook's brief 2-replica overlap has **both** containers
  mounting the SAME volume and reading/writing the SAME sqlite file, so at the moment the new
  replica boots, the old one may still be genuinely alive and actively working (or holding) a
  job it owns. A blanket reap would kill that job out from under the old replica and hand a
  caller a false "lost, resubmit" on a run that was never actually interrupted — the reap logic
  exists specifically to avoid this. The heartbeat covers a job's **entire** lifetime, not just
  `running`: it starts the instant a job is created, before the concurrency-slot wait, so a
  merely-`queued` job counts too. That matters in practice — `RESEARCH_MAX_CONCURRENCY=3` and a
  deep run takes ~28 minutes, so under load a 4th job can sit legitimately `queued` for well
  over half an hour, and any deploy landing in that window must not treat the whole backlog as
  lost. Correctness across the overlap rests on heartbeat staleness detection, not on a
  distributed lock or leader election — two processes never coordinate directly, they only each
  observe the same timestamps in the same file.
- **Page fetching** uses `fetch()` + `linkedom` + Readability (`jsdom`'s `fromURL` fetcher is
  broken under Bun; linkedom parses fine). Because the gateway fetches pages itself, the SSRF
  guard (`src/lib/ssrf.ts`) is active and load-bearing; the readability→Tavily-Extract fallback
  still covers extraction misses. A residual DNS-rebinding TOCTOU gap remains and is documented
  inline in `src/lib/ssrf.ts`.
- **Budget ceilings are load-bearing.** Anything holding the bearer can trigger a loop; the
  per-depth step/token/wall-clock caps (`src/agent/depth.ts`) are the cost backstop.
