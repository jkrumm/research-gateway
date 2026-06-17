# Production secrets template for the VPS.
# Materialized into a real (gitignored) `.env` on the VPS via `op inject` — see DEPLOY.md.
# Place this file in the vps repo at apps/research-gateway/.env.tpl and re-run the env target
# after rotating any secret. These op:// refs are INFERRED — confirm with `/secrets`.

# Gateway's own bearer
API_SECRET=op://vps/research-gateway/API_SECRET

# IU unified endpoint
IU_BASE_URL=op://common/anthropic/OPENAI_BASE_URL
IU_API_KEY=op://common/anthropic/API_KEY
IU_MODEL=DeepSeek-V4-Pro

# Tavily
TAVILY_API_KEY=op://vps/research-gateway/TAVILY_API_KEY

# Context7 (optional)
CONTEXT7_API_KEY=op://vps/research-gateway/CONTEXT7_API_KEY

# Telemetry → argo
ARGO_USAGE_URL=https://argo.jkrumm.com/api/usage/records
ARGO_API_SECRET=op://common/api/SECRET

RESEARCH_MAX_CONCURRENCY=3
