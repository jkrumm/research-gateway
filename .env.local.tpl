# Local dev secrets template — consumed via `secrets-run` (drop-in op shim; see the
# package.json `dev` script). Substitutes only bare op:// refs, mirroring `op run`.
# Verify exact vault/item paths with `/secrets`.
# Refs confirmed 2026-07-17 against the vps `.env.tpl` and the live vault.

PORT=7780

# Gateway's own bearer (clients send this as `Authorization: Bearer <…>`)
API_SECRET=op://vps/research-gateway/API_SECRET

# IU unified endpoint (same item argo uses for its DeepSeek calls)
IU_BASE_URL=op://common/anthropic/OPENAI_BASE_URL
IU_API_KEY=op://common/anthropic/API_KEY
# Lead plans + synthesizes; workers fan out. Split so the cheap/fast model does the
# bounded extract-and-distill work and the strong one only sees compact digests.
IU_LEAD_MODEL=DeepSeek-V4-Pro
IU_WORKER_MODEL=DeepSeek-V4-Flash

# Tavily (search + extract)
TAVILY_API_KEY=op://common/tavily/API_KEY

# Context7 (OPTIONAL — libraryDocs tool registers only when set; ctx7sk_ key)
CONTEXT7_API_KEY=op://vps/research-gateway/CONTEXT7_API_KEY

# Telemetry → argo POST /usage/records (ARGO_API_SECRET = argo's shared bearer)
ARGO_USAGE_URL=https://argo.jkrumm.com/api/usage/records
ARGO_API_SECRET=op://common/api/SECRET

RESEARCH_MAX_CONCURRENCY=3
