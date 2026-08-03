# Production secrets template for the VPS.
# Materialized into a real (gitignored) `.env` on the VPS via `op inject` — see DEPLOY.md.
# Place this file in the vps repo at apps/research-gateway/.env.tpl and re-run the env target
# after rotating any secret. These secret refs are INFERRED — confirm with `/secrets`.

# Gateway's own bearer
API_SECRET=op://vps/research-gateway/API_SECRET

# IU unified endpoint — serves both the DeepSeek lead/workers and the Perplexity Sonar
# search backend below. (IU_MODEL used to sit here; nothing has consumed it since it was
# dropped from env.ts, and it read as if the lead were Pro long after it was not.)
IU_BASE_URL=op://common/anthropic/OPENAI_BASE_URL
IU_API_KEY=op://common/anthropic/API_KEY

# Web search backend. `sonar` (the default) puts searchWeb on the IU key via Perplexity;
# `tavily` reverts to the personal Tavily plan. Uncomment only to override the default.
# SEARCH_PROVIDER=sonar
# SONAR_MODEL=sonar

# Tavily — still required with SEARCH_PROVIDER=sonar: it is fetchPage's Extract fallback
# and the per-call fallback when a Sonar search fails.
# Shared item, NOT a gateway-specific one — see DEPLOY.md step 1. The live VPS .env.tpl
# has always used this ref; the gateway-scoped one written here did not exist.
TAVILY_API_KEY=op://common/tavily/API_KEY

# Context7 (optional)
CONTEXT7_API_KEY=op://vps/research-gateway/CONTEXT7_API_KEY

# GitHub (githubFile / githubRepo / findPackages). These tools work unauthenticated, but
# anonymous GitHub is 60 req/h PER IP shared by every worker of every concurrent job; a
# fine-grained PAT with NO permissions (public read only) raises it to 5000/h.
# The field may be left EMPTY in 1Password — the gateway treats empty as unset and falls
# back to anonymous, so this line is safe to keep enabled before a token is pasted in.
GITHUB_TOKEN=op://vps/research-gateway/GITHUB_TOKEN

# Telemetry → argo
# Internal docker route on the VPS — argo is Tailscale-only (grey-cloud), so the
# container posts to argo-api directly over the shared monitoring-net, not the public host.
# (Local dev in .env.local.tpl keeps the public URL — the Mac can reach argo.)
ARGO_USAGE_URL=http://argo-api:4000/usage/records
ARGO_API_SECRET=op://common/api/SECRET

RESEARCH_MAX_CONCURRENCY=3
