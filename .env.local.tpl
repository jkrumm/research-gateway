# Local dev secrets template — consumed via `op run` (see package.json `dev` script).
# `op run` substitutes only bare op:// refs. Verify exact vault/item paths with `/secrets`.
# These op:// refs are INFERRED from the argo conventions — confirm before first run.

PORT=7780

# Gateway's own bearer (clients send this as `Authorization: Bearer <…>`)
API_SECRET=op://vps/research-gateway/API_SECRET

# IU unified endpoint (same item argo uses for its DeepSeek calls)
IU_BASE_URL=op://common/anthropic/OPENAI_BASE_URL
IU_API_KEY=op://common/anthropic/API_KEY
IU_MODEL=DeepSeek-V4-Pro

# Tavily (search + extract)
TAVILY_API_KEY=op://vps/research-gateway/TAVILY_API_KEY

# Context7 (OPTIONAL — libraryDocs tool registers only when set; ctx7sk_ key)
CONTEXT7_API_KEY=op://vps/research-gateway/CONTEXT7_API_KEY

# Telemetry → argo POST /usage/records (ARGO_API_SECRET = argo's shared bearer)
ARGO_USAGE_URL=https://argo.jkrumm.com/api/usage/records
ARGO_API_SECRET=op://common/api/SECRET

RESEARCH_MAX_CONCURRENCY=3
