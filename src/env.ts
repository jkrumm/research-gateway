import { z } from 'zod'

const Env = z.object({
  PORT: z.coerce.number().default(7780),
  // 0.0.0.0 for the container (Traefik reaches it over the docker network); the mini pins
  // 127.0.0.1 so only Caddy fronts it, never the LAN or a raw tailnet port.
  HOST: z.string().default('0.0.0.0'),
  API_SECRET: z.string().min(1),
  IU_BASE_URL: z.url(),
  IU_API_KEY: z.string().min(1),
  // Both roles run DeepSeek. These two defaults are the real configuration — production sets
  // neither, so what is written here is what runs. (A dead IU_MODEL var used to sit here
  // and was still set to DeepSeek-V4-Pro in the deployed .env, which read as if the lead
  // were Pro long after it was not. Nothing consumed it; removed rather than corrected.)
  //
  // 2026-09-13: `deepseek-v4.1-flash` for both roles, `reasoning_effort: "high"` (lib/llm.ts
  // owns the effort + per-call-role output budget, applied via `wrapLanguageModel` — see the
  // comment there). Supersedes the 2026-08-20 move to `gpt-5.6-luna` recorded in
  // docs/decisions.md: Luna was faster to first token but this is an estate-wide model
  // decision, not a per-service latency tiebreak. DeepSeek has no prompt-cache discount here
  // (measured elsewhere in the estate), which is an accepted cost, not a bug to chase.
  // gpt-6-luna ran here briefly on 2026-09-23 and was reverted: with function tools it only
  // accepts `reasoning_effort: "none"` (lib/llm-settings.ts), a quality downgrade for research.
  IU_LEAD_MODEL: z.string().default('deepseek-v4.1-flash'),
  IU_WORKER_MODEL: z.string().default('deepseek-v4.1-flash'),
  WORKER_MAX_CONCURRENCY: z.coerce.number().default(8),
  // Idle watchdog for every LLM call in the agent loop (plan, worker, synthesis): aborted
  // when no step/tool activity has been observed for this long. Replaces the old per-phase
  // wall-clock ceilings (`workerTimeoutMs` et al.) — there is no longer a total time budget
  // for a run, only a liveness check that a call is still doing something. `generateText` is
  // non-streaming here, so "activity" is step/tool-execution boundaries, not token chunks —
  // see worker.ts/plan.ts/synthesize.ts and `lib/idle-watchdog.ts`.
  //
  // 1_800_000 (30 min), not 300_000: `arm()` only fires from step/tool-execution callbacks, so
  // there is no in-request heartbeat while a single non-streaming call is still thinking — a
  // 300s budget read a `deepseek-v4.1-flash` call at `reasoning_effort: "high"` still generating
  // its 32k-token synthesis output as "gone silent" and killed it mid-flight. rules/
  // agent-limits.md sets 30 minutes as the hang-guard floor for exactly this shape (a single
  // non-streaming request with no token-level signal to arm against).
  RESEARCH_IDLE_TIMEOUT_MS: z.coerce.number().default(1_800_000),
  // Which backend `searchWeb` uses. Sonar is the default: it runs over IU_BASE_URL on the
  // work key, costs about the same per call as a Tavily basic search, and returns ~20 dated
  // sources instead of 5 (measured 2026-08-02). Tavily is kept as a one-shot per-call
  // fallback and remains the only Extract path, so TAVILY_API_KEY stays required either way.
  // Set to 'tavily' to take Perplexity out of the loop entirely.
  SEARCH_PROVIDER: z.enum(['sonar', 'tavily']).default('sonar'),
  // `sonar` deliberately, not a Reasoning variant: `sonar-reasoning` was deprecated upstream
  // in Dec 2025 (IU still lists it), and `sonar-reasoning-pro` spends the whole answer budget
  // on reasoning tokens — it returned empty content at the max_tokens floor this uses.
  // Perplexity is also migrating Sonar Chat Completions toward its Agent API, so treat this
  // as the pinned, known-good surface rather than a menu.
  SONAR_MODEL: z.string().default('sonar'),
  TAVILY_API_KEY: z.string().min(1),
  CONTEXT7_API_KEY: z.string().optional(),
  // Optional. The GitHub tools work unauthenticated, but the anonymous budget is 60
  // req/hour PER IP — shared across every worker of every concurrent job — so a busy
  // hour degrades them to "rate limited". A token raises it to 5000/hour. Needs no
  // scopes: public read only.
  //
  // Empty-as-unset is deliberate: `op inject` renders an empty 1Password field as
  // `GITHUB_TOKEN=`, and sending `Authorization: Bearer ` is worse than sending nothing
  // (GitHub 401s the request instead of serving it anonymously). This makes the field
  // safe to exist before a real token has been pasted into it.
  GITHUB_TOKEN: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v : undefined)),
  // Absolute path to the owner's second-brain vault (a git checkout of an Obsidian vault) —
  // mini-only, native LaunchAgent host. Unset everywhere else (VPS, local dev, tests), which
  // keeps the `brainNotes` tool unregistered entirely (agent/tools.ts), exactly like
  // `libraryDocs` without CONTEXT7_API_KEY. Search is hard-scoped to `${BRAIN_DIR}/wiki/` in
  // code (agent/brain-search.ts) — the vault's Projects/Areas/Inbox trees carry private data
  // and must never be reachable from here, symlink escapes included.
  //
  // Empty-as-unset like GITHUB_TOKEN above: templates can't express "absent", only "".
  BRAIN_DIR: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v : undefined)),
  // Base URL of the brain reader app (basalt-ui-obsidian demo, mini-only, tailnet ACL'd — see
  // dotfiles' Caddyfile). Building a citation URL requires both BRAIN_DIR (to read the note)
  // and this (to cite it); either missing keeps `brainNotes` unregistered — see
  // buildBrainNotesTool. `z.url()`, not empty-as-unset: this is a plain config value, not an
  // `op://` secret ref that could render as `""`.
  BRAIN_BASE_URL: z.url().optional(),
  // `rg` resolves via PATH (Homebrew's ripgrep on the mini, /opt/homebrew/bin) — same pattern
  // as PDFTOTEXT_PATH below. Only meaningful when BRAIN_DIR is set.
  RG_PATH: z.string().default('rg'),
  // The JavaScript-rendering sidecar — a self-hosted browser engine, and the step that
  // replaced Jina Reader as fetchPage's renderer (see agent/lightpanda.ts, lightpanda/).
  //
  // Base URL of the sidecar, e.g. http://research-gateway-lightpanda:7781. Unset makes the
  // step inert — the gateway must be able to run without the sidecar, both in local dev and
  // if the container fails to come up in production.
  // `z.url()`, matching IU_BASE_URL and ARGO_USAGE_URL rather than a bare string: a
  // scheme-less or typo'd value would otherwise pass boot and surface only as an opaque fetch
  // failure inside the tool's catch, silently demoting every render to the fallback while the
  // container reported healthy.
  // Empty-as-unset first, for the same reason as GITHUB_TOKEN below and one specific to this
  // var: setting it to `""` in compose is the obvious way to switch the renderer off, and a
  // bare `z.url()` would answer that by refusing to boot the gateway at all.
  LIGHTPANDA_URL: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z
      .url()
      .optional()
      .transform((v) => (v ? v.replace(/\/+$/, '') : undefined)),
  ),
  ARGO_USAGE_URL: z.url().optional(),
  ARGO_API_SECRET: z.string().optional(),
  RESEARCH_MAX_CONCURRENCY: z.coerce.number().default(3),
  RESEARCH_MAX_QUEUE: z.coerce.number().default(50),
  // Result retention. A finished job's status and result stay readable from sqlite for this
  // long, so the `jobId` is a durable handle: a client whose wait was cut (a closed session, a
  // restart, a dropped stream) can still fetch the result later. The in-memory map holds only
  // queued/running jobs (plus a terminal one for the ~60s until the next sweep), so a week of
  // finished jobs costs no memory; the sweep deletes rows older than this. Default 10080
  // (7 days). SQLite growth is roughly 50-100 KB per finished job — trivial.
  JOB_TTL_MINUTES: z.coerce.number().default(10080),
  // How long index.ts's shutdown path waits for RUNNING jobs to finish before force-exiting
  // (see `drainThenExit`, `waitForDrain`).
  //
  // Being generous is nearly free: rollhook's rollout is start-new -> wait-healthy -> stop-old
  // (rollhook/internal/jobs/steps/rollout.go:102-110, `container.StopOptions{}` with no timeout,
  // so Docker applies the compose `stop_grace_period`), which means a long drain costs only
  // deploy-tail latency — the new container is already serving, and both replicas share the
  // same sqlite job store, so a client polling the new one still sees the old replica's job
  // finish.
  //
  // **Size it off docs/measurements.md § Job duration, never off one run.** The first value
  // here was 600s, taken from a single fast deep run, and the span record says that would have
  // missed 39% of deep jobs. 1800s clears the measured maximum. There is no summed per-phase
  // wall-clock ceiling to bound it against any more (settled 2026-09-12, see depth.ts) — only
  // the per-call idle watchdog (`RESEARCH_IDLE_TIMEOUT_MS`) — so 1800s is itself the job's
  // outer bound, sized off measured history rather than derived from a structural cap.
  //
  // MUST stay strictly below the compose `stop_grace_period` (1860s, vps repo) or SIGKILL wins
  // first and the drain buys nothing. `process.boot` logs this value so the drift is visible.
  SHUTDOWN_DRAIN_MS: z.coerce.number().default(1_800_000),
  // bun:sqlite job store (status-only durability — see lib/job-db.ts). Relative default
  // resolves against the process CWD: the repo root in local dev, /app (the Dockerfile
  // WORKDIR) in the container, where the vps repo's apps/research-gateway/compose.yml mounts a
  // named volume at /app/data.
  JOB_DB_PATH: z.string().default('./data/jobs.sqlite'),
  // yt-dlp binary path — bundled into the image at build time (Dockerfile), pinned to a
  // specific release. See agent/ytdlp.ts.
  YTDLP_PATH: z.string().default('/usr/local/bin/yt-dlp'),
  // MEASURED 2026-08-06 from the VPS: YouTube rate-limits this datacenter IP under burst
  // (`HTTP Error 429` on a `--sub-langs` glob expansion). Bounded on purpose, not a tuning
  // default — raising it trades a slower queue for a higher chance of a 429 mid-job.
  YTDLP_MAX_CONCURRENCY: z.coerce.number().default(2),
  // MEASURED 2026-08-06: a `-J` extraction + caption fetch completed in 3.6-4.2s per video
  // (three-video sample). 45s leaves headroom for a slow one without lingering forever on a
  // wedged process.
  YTDLP_TIMEOUT_MS: z.coerce.number().default(45_000),
  // poppler's pdftotext binary — 'pdftotext' resolves via PATH (the Dockerfile's `apk add
  // poppler-utils` puts it at /usr/bin/pdftotext on the alpine runner). See agent/pdf.ts.
  PDFTOTEXT_PATH: z.string().default('pdftotext'),
  // 'development' matches argo's NODE_ENV default (Env.ts) — only prod compose sets this to
  // 'production'. Feeds `deployment.environment` on every OTel span and log record (lib/otel.ts).
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // ClickStack/HyperDX OTLP collector base URL — prod uses http://clickstack:4319, the
  // UNAUTHED receiver bound to the docker bridge (:4318 enforces bearertokenauth). See
  // lib/otel.ts. Deliberately optional with NO default (unlike argo's
  // OTEL_EXPORTER_OTLP_ENDPOINT, which defaults to a local collector sidecar argo's compose
  // always runs): this service has no such sidecar, only prod's compose sets this var, and an
  // unset value must make trace/log export inert rather than fail-open to some assumed
  // endpoint — that is what keeps local dev and every test console-only with zero config.
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
  OTEL_SERVICE_NAME: z.string().default('research-gateway'),
  // Standard `OTEL_EXPORTER_OTLP_HEADERS` (`key=value,key=value`, values may contain `=`),
  // sent on every OTLP POST — see otel.ts's `EXPORT_HEADERS`. Ported from audio-gateway
  // (src/config.ts's otelHeaders), which already needs this: the mini exports to the VPS's
  // public OTLP ingest (https://otel.jkrumm.com), which sits behind bearertokenauth, unlike the
  // VPS container's own in-cluster :4319 leg. Empty default reproduces today's VPS behaviour
  // (no header sent).
  OTEL_EXPORTER_OTLP_HEADERS: z.string().default(''),
  // The `authorization` header value on its own, so a secret manager that only resolves
  // whole-value `op://` refs (secrets-run, op run) can inject the ingestion key without string
  // composition — same reasoning as audio-gateway's otelAuthorization. Empty-as-unset like
  // GITHUB_TOKEN above: `op inject` renders an empty field as `VAR=`, and sending
  // `authorization: ` is worse than sending nothing.
  OTEL_EXPORTER_OTLP_AUTHORIZATION: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v : undefined)),
  // Optional scheme prefix ("Bearer") for the authorization header above; HyperDX's ingest
  // takes the raw key, so this stays unset on the VPS. Matches audio-gateway's
  // otelAuthScheme name and semantics.
  OTEL_EXPORTER_OTLP_AUTH_SCHEME: z.string().default(''),
  // Host label stamped on every argo usage row (part of argo's idempotency triple, and a
  // dashboard breakdown dimension) — this service now runs on both the VPS (prod container)
  // and the mini (native LaunchAgent), so it must not be hardcoded. Default reproduces
  // today's VPS behaviour unchanged; the mini's .env.mini.tpl sets MACHINE=mini. Matches
  // audio-gateway's `config.machine` convention.
  MACHINE: z.string().default('vps'),
  // Fallback memory ceiling (MiB) for `lib/memory-watch.ts`'s watchdog + load-shedding on a
  // host with no cgroup — macOS (the mini's native LaunchAgent) has none, so
  // `memory.max`/`memory.current` are unreadable there and the watchdog is otherwise
  // permanently inert. Unset (the VPS container's default, cgroup available) keeps the cgroup
  // path exclusive — this var is read ONLY as a fallback when the cgroup read fails.
  MEMORY_LIMIT_MB: z.coerce.number().optional(),
  // Optional overlays the mini's launcher (scripts/launch.sh) could NOT resolve and started
  // without — e.g. `otel`, `github` — as a comma list. Surfaced on `GET /health` as
  // `degraded: [...]` so a monitor can tell "up" from "up, but exporting no traces". Matches
  // audio-gateway's AUDIO_GATEWAY_DEGRADED/`config.degraded` convention. Always '' on the VPS
  // container, which has no such overlay concept.
  RESEARCH_GATEWAY_DEGRADED: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
})

export const env = Env.parse(process.env)
