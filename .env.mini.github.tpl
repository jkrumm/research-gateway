# Optional overlay: a no-permission public-read GitHub PAT, lifting the GitHub tools from
# 60 req/h (per IP, shared by every worker of every job) to 5000. Layered by
# scripts/launch.sh only when the ref resolves from the mini's secrets cache — an unseeded
# ref starts the instance degraded (anonymous GitHub budget), never not at all.
GITHUB_TOKEN=op://vps/research-gateway/GITHUB_TOKEN
