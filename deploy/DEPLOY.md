# Deploying research-gateway to the VPS

**This repo ships the code, the two Dockerfiles and the deploy workflows. Everything the
container runs *with* lives in the `vps` repo:**

| What | Where |
|-|-|
| compose file (both services, networks, `mem_limit`, `LIGHTPANDA_URL`, OTel endpoint) | `vps/apps/research-gateway/compose.yml` |
| prod secrets template (`op://` refs, materialized by `make research-gateway-env`) | `vps/apps/research-gateway/.env.tpl` |
| Makefile targets (`research-gateway-{up,down,env,redeploy,bootstrap-image}`) | `vps/Makefile` |
| the Cloudflare DNS record | Cloudflare dashboard / `/cloudflare` |

There is deliberately **no template copy here** any more — two copies drifted (this side sat on
`mem_limit: 512m` and no OTel wiring for a month after prod moved on). Edit the vps file, commit
there, `git pull` on the VPS, `make research-gateway-redeploy`.

Ingress is **Tailscale-only** — a grey-cloud DNS-only A record (`research.<domain>` → the VPS
Tailscale IP) routed to **Traefik v3**, *not* through the Cloudflare Tunnel (same pattern as
`argo` and `audio-gateway`). Deploys are **label-driven via rollhook** (OIDC, zero-downtime):
push to `master` → `.github/workflows/deploy.yml` → rollhook-action → rolling update. The
`rollhook.allowed_repos=jkrumm/research-gateway` label on the running container authorizes it.

## 0. Gating pre-check — IU reachability from the VPS

The gateway calls the IU unified endpoint **directly** from the VPS. If that endpoint is ever
VPN/localhost-bound, the whole LLM-path decision reopens — verify before anything else:

```bash
ssh vps
curl -sS -X POST "$IU_BASE_URL/chat/completions" \
  -H "Authorization: Bearer $IU_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.6-luna","messages":[{"role":"user","content":"ping"}],"max_tokens":5}'
```

## 1. 1Password items (account `tkrumm`)

- `op://vps/research-gateway/API_SECRET` — the gateway's own bearer; generate a strong random one.
- `op://common/tavily/API_KEY` — Tavily. **Shared item**, not a gateway-specific one.
- `op://vps/research-gateway/CONTEXT7_API_KEY` — optional; a `ctx7sk_` key enables `libraryDocs`.
- `op://vps/research-gateway/GITHUB_TOKEN` — optional fine-grained PAT, **no permissions**
  (public read only): raises the GitHub tools from 60 req/h *per IP, shared across every
  concurrent job* to 5000 req/h. The field may be **empty** (the gateway treats empty as
  unset) but must **exist**, or `op inject` fails on the missing ref.
- `IU_*` and `ARGO_API_SECRET` reuse `op://common/anthropic/*` and `op://common/api/SECRET`.

> **The VPS 1Password service account is read-only** (`op item create` → `(101)`). Items and
> fields are created from the MacBook with the interactive, biometric `op`.

> **`op inject` substitutes `op://` refs inside comments too.** A commented-out ref to a
> missing field fails the whole injection — and the failure is the *previous* `.env` never
> being rewritten, not an error next to the offending line. Never park an unused ref behind
> a `#`; delete it.

## 2. Cloudflare DNS (Tailscale-only)

`research.<your-domain>` → **A record, DNS-only (grey cloud)** → the VPS Tailscale IP
(`op://vps/config/VPS_TAILSCALE_IP`). **Not** in the cloudflared tunnel ingress: Traefik's
`:443` is already bound to the Tailscale interface and the wildcard DNS-01 cert covers it.

## 3. First deploy on a fresh server

1. `make research-gateway-env` in the vps repo (materializes the gitignored `.env`).
2. `make research-gateway-bootstrap-image` — builds and pushes **both** images. RollHook tags
   by git SHA and never moves `:latest`, so CI alone never produces the tag compose defaults
   to; this is also why the sidecar's first `deploy-lightpanda.yml` run fails at the token
   step (`service not found — ensure the app is running`) if it lands before the container
   exists. The deploy step retries on its own once the container is up (observed 2026-08-02).
3. `make research-gateway-up` once. Every later deploy is a push to `master`.

The renderer sidecar (`lightpanda/`, its own image, `.github/workflows/deploy-lightpanda.yml`)
needs **no secret and no `.env` entry**: it is reached over the compose-private `render`
network, `LIGHTPANDA_URL` is set in compose, and unsetting that takes the renderer out of
the fetch chain without a gateway rebuild. It deploys separately so a browser bump does not
restart the gateway and kill in-flight jobs.

## 4. Verify

```bash
BASE=https://research.<your-domain>
TOKEN=$(secrets-run read op://vps/research-gateway/API_SECRET)

curl -sS $BASE/health          # {"status":"ok","lastRestartAt":…,"reaped":0,"interrupted":0}
curl -sS $BASE/health/ytdlp    # {"ytdlp":"ok","version":"2026.07.04",…}
curl -sS $BASE/health/render   # {"renderer":"ok",…}

JOB=$(curl -sS -X POST $BASE/research -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"current stable version of Elysia and how to register the openapi plugin","depth":"quick"}' | jq -r .jobId)
curl -sS $BASE/research/$JOB -H "Authorization: Bearer $TOKEN" | jq   # poll until status=done
```

For the renderer, the check that matters is a page whose text is not in its HTML: `POST
/probe/fetch` with `{"url":"https://www.techempower.com/benchmarks/"}` should terminate at
`lightpanda` with ~4,600 chars (a plain fetch returns a 2 KB shell).

## Traps

- **Pushing to master deploys and kills running jobs.** Check `/health/render` shows
  `active: 0` and the job store has nothing running first. Markdown-only pushes are ignored
  by the workflow (`paths-ignore`).
- **`make research-gateway-down && up` rolls code back** — it recreates from `:latest`,
  which RollHook never updates. Use `make research-gateway-redeploy`, also the documented way
  to apply a compose change.
- **The VPS's own `~/vps` checkout has no git credential.** Commit and push from the mini's
  `~/SourceRoot/vps`, then `git pull` on the VPS. The path *on* the VPS is `~/vps`.
- **compose `image:` needs the nested `${IMAGE_TAG:-…}`** or RollHook's validator rejects the
  service and silently stops shipping it.
- **`mem_limit` and `RESEARCH_MAX_CONCURRENCY` are one decision.** The container was
  OOM-killed at exactly 1 GiB on 2026-09-04 (15 jobs reaped at the restart) and wedged at
  512 MiB on 2026-08-06; a kernel kill leaves no container log line — `journalctl -k | grep
  oom` on the host is the record, `process.memory_pressure` in HyperDX the warning.
- **Job store durability is status-only.** A `done` result survives a redeploy; a job caught
  mid-run comes back as a terminal `error` once its heartbeat is >90s stale — never as a
  blanket "everything running at boot is dead", because rollhook's overlap has both replicas
  on the same sqlite file and the old one may still be genuinely working.
- **The SSRF guard (`src/lib/ssrf.ts`) is load-bearing** — the gateway fetches pages itself.
  A DNS-rebinding TOCTOU gap remains and is documented inline.
- **Budget ceilings are the cost backstop.** Anything holding the bearer can trigger a loop;
  `src/agent/depth.ts` caps steps, context and wall-clock per depth.
