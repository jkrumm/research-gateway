import { z } from 'zod'

const Env = z.object({
  PORT: z.coerce.number().default(7780),
  API_SECRET: z.string().min(1),
  IU_BASE_URL: z.url(),
  IU_API_KEY: z.string().min(1),
  IU_MODEL: z.string().default('DeepSeek-V4-Pro'),
  // Flash leads as well as works. Measured live against the IU endpoint, Flash decodes
  // ~2x faster than Pro and matches it on multi-step tool-calling (3/3 tools, args valid,
  // 7.8s vs 14.1s — modelpick's 2026-07 bake-off). The lead's two jobs, planning and
  // synthesis, are both tool-calls, and synthesis is the wall-clock long pole of every
  // job — so the faster model cuts both latency and cost where it matters most. Revert
  // to DeepSeek-V4-Pro here if report quality regresses; nothing else depends on it.
  IU_LEAD_MODEL: z.string().default('DeepSeek-V4-Flash'),
  IU_WORKER_MODEL: z.string().default('DeepSeek-V4-Flash'),
  WORKER_MAX_CONCURRENCY: z.coerce.number().default(8),
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
