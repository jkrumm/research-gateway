import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { env } from '../env.js'

export const iu = createOpenAICompatible({
  name: 'iu',
  baseURL: env.IU_BASE_URL,
  apiKey: env.IU_API_KEY,
})

export const leadModel = iu(env.IU_LEAD_MODEL)
export const workerModel = iu(env.IU_WORKER_MODEL)
