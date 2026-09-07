# Local dev secrets template — consumed via `secrets-run` (drop-in op shim; see the
# package.json `dev` script). Substitutes only bare op:// refs, mirroring `op run`.
# Verify exact vault/item paths with `/secrets`.
# Refs confirmed 2026-07-17 against the vps `.env.tpl` and the live vault.

PORT=7780

# Gateway's own bearer (clients send this as `Authorization: Bearer <…>`)
API_SECRET=op://vps/research-gateway/API_SECRET

# IU unified endpoint (same item argo uses)
IU_BASE_URL=op://common/anthropic/OPENAI_BASE_URL
IU_API_KEY=op://common/anthropic/API_KEY
# Lead and worker models come from the defaults in src/env.ts (gpt-5.6-luna for both), the
# same as prod, which sets neither. Override here only to test a deliberate exception:
# IU_LEAD_MODEL=
# IU_WORKER_MODEL=

# Web search backend: `sonar` (default) routes searchWeb through Perplexity on the IU
# endpoint above — billed to the work key, ~20 dated sources per call. `tavily` takes
# Perplexity out of the loop. Either way Tavily stays required: it is fetchPage's Extract
# fallback and the per-call fallback when a Sonar search fails.
# SEARCH_PROVIDER=sonar
# SONAR_MODEL=sonar

# Tavily (extract + search fallback)
TAVILY_API_KEY=op://common/tavily/API_KEY

# Context7 (OPTIONAL — libraryDocs tool registers only when set; ctx7sk_ key)
CONTEXT7_API_KEY=op://vps/research-gateway/CONTEXT7_API_KEY

# GitHub (OPTIONAL — githubFile/githubRepo/findPackages fall back to anonymous, 60 req/h).
# Left commented for local dev: resolving this ref on the mini needs an entry in
# dotfiles-private/headless.refs plus a `make secrets-seed` from the MacBook. Uncomment
# only after seeding, or `bun run dev` fails on a cache miss.
# GITHUB_TOKEN=op://vps/research-gateway/GITHUB_TOKEN

# Telemetry → argo POST /usage/records (ARGO_API_SECRET = argo's shared bearer)
ARGO_USAGE_URL=https://argo.jkrumm.com/api/usage/records
ARGO_API_SECRET=op://common/api/SECRET

RESEARCH_MAX_CONCURRENCY=3
