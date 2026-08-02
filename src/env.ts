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
  // step inert, exactly like JINA_ENABLED — the gateway must be able to run without the
  // sidecar, both in local dev and if the container fails to come up in production. The two
  // renderers are ordered, not exclusive: Jina stays wired behind its own flag as the
  // rollback, so if this one has to be pulled, that is one env var and no deploy.
  LIGHTPANDA_URL: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v.replace(/\/+$/, '') : undefined)),
  // Jina Reader — the previous JavaScript-rendering step in fetchPage's chain (agent/jina.ts).
  //
  // This flag, not the API key, is the switch. Enabling it means the URLs this service
  // fetches become visible to a third party, which is a decision to take explicitly — but
  // r.jina.ai serves ANONYMOUS callers fine (measured: HTTP 200 without a key), so gating on
  // the key would have tied a privacy decision to a rate-limit lever. Worse, it would have
  // made a bad key strictly worse than no key: the first key tried here returned HTTP 402
  // `InsufficientBalanceError` on every request while anonymous access worked.
  JINA_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  // OPTIONAL rate-limit lever on top of JINA_ENABLED: anonymous is 20 RPM, a key raises it
  // to 500. A key whose account has no balance 402s every request, so tools.ts retries once
  // anonymously and logs loudly rather than letting the whole step die silently.
  //
  // Empty-as-unset for the same reason as GITHUB_TOKEN above: `op inject` renders an empty
  // 1Password field as `JINA_API_KEY=`, and sending `Authorization: Bearer ` is worse than
  // sending nothing.
  JINA_API_KEY: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v : undefined)),
  ARGO_USAGE_URL: z.url().optional(),
  ARGO_API_SECRET: z.string().optional(),
  RESEARCH_MAX_CONCURRENCY: z.coerce.number().default(3),
  RESEARCH_MAX_QUEUE: z.coerce.number().default(50),
  JOB_TTL_MINUTES: z.coerce.number().default(30),
  // bun:sqlite job store (status-only durability — see lib/job-db.ts). Relative default
  // resolves against the process CWD: the repo root in local dev, /app (the Dockerfile
  // WORKDIR) in the container, where deploy/compose.yml mounts a named volume at /app/data.
  JOB_DB_PATH: z.string().default('./data/jobs.sqlite'),
})

export const env = Env.parse(process.env)
