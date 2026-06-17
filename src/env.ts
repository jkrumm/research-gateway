import { z } from 'zod'

const Env = z.object({
  PORT: z.coerce.number().default(7780),
  API_SECRET: z.string().min(1),
  IU_BASE_URL: z.url(),
  IU_API_KEY: z.string().min(1),
  IU_MODEL: z.string().default('DeepSeek-V4-Pro'),
  TAVILY_API_KEY: z.string().min(1),
  CONTEXT7_API_KEY: z.string().optional(),
  ARGO_USAGE_URL: z.url().optional(),
  ARGO_API_SECRET: z.string().optional(),
  RESEARCH_MAX_CONCURRENCY: z.coerce.number().default(3),
  RESEARCH_MAX_QUEUE: z.coerce.number().default(50),
  JOB_TTL_MINUTES: z.coerce.number().default(30),
})

export const env = Env.parse(process.env)
