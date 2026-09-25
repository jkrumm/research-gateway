# Optional overlay: Karakeep bookmarks inside brainNotes (agent/karakeep.ts). The key is the
# dedicated, separately revocable Hermes Karakeep key, already in the mini's secrets cache.
# Layered by scripts/launch.sh only when the ref resolves — an unseeded ref starts the
# instance degraded (brain notes only), never not at all.
KARAKEEP_URL=https://karakeep.jkrumm.com
KARAKEEP_API_KEY=op://hermes/karakeep/api-key
