import { z } from 'zod'

const Env = z.object({
  PORT: z.coerce.number().default(7780),
  API_SECRET: z.string().min(1),
  IU_BASE_URL: z.url(),
  IU_API_KEY: z.string().min(1),
  // Both roles run Flash. These two defaults are the real configuration — production sets
  // neither, so what is written here is what runs. (A dead IU_MODEL var used to sit here
  // and was still set to DeepSeek-V4-Pro in the deployed .env, which read as if the lead
  // were Pro long after it was not. Nothing consumed it; removed rather than corrected.)
  //
  // Flash leads as well as works. Measured live against the IU endpoint, Flash decodes
  // ~2x faster than Pro and matches it on multi-step tool-calling (3/3 tools, args valid,
  // 7.8s vs 14.1s — modelpick's 2026-07 bake-off). The lead's two jobs, planning and
  // synthesis, are both tool-calls, and synthesis is the wall-clock long pole of every
  // job — so the faster model cuts both latency and cost where it matters most. Revert
  // to DeepSeek-V4-Pro here if report quality regresses; nothing else depends on it.
  IU_LEAD_MODEL: z.string().default('DeepSeek-V4-Flash'),
  IU_WORKER_MODEL: z.string().default('DeepSeek-V4-Flash'),
  WORKER_MAX_CONCURRENCY: z.coerce.number().default(8),
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
  JOB_TTL_MINUTES: z.coerce.number().default(30),
  // bun:sqlite job store (status-only durability — see lib/job-db.ts). Relative default
  // resolves against the process CWD: the repo root in local dev, /app (the Dockerfile
  // WORKDIR) in the container, where deploy/compose.yml mounts a named volume at /app/data.
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
  // 'development' matches argo's NODE_ENV default (Env.ts) — only prod compose sets this to
  // 'production'. Feeds `deployment.environment` on every OTel log record (lib/otel-logs.ts).
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // ClickStack/HyperDX OTLP collector base URL — prod uses http://clickstack:4319, the
  // UNAUTHED receiver bound to the docker bridge (:4318 enforces bearertokenauth). See
  // lib/otel-logs.ts. Deliberately optional with NO default (unlike argo's
  // OTEL_EXPORTER_OTLP_ENDPOINT, which defaults to a local collector sidecar argo's compose
  // always runs): this service has no such sidecar, only prod's compose sets this var, and an
  // unset value must make log export inert rather than fail-open to some assumed endpoint —
  // that is what keeps local dev and every test console-only with zero configuration.
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
  OTEL_SERVICE_NAME: z.string().default('research-gateway'),
})

export const env = Env.parse(process.env)
