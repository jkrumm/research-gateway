import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { env } from '../env.js'

export const iu = createOpenAICompatible({
  name: 'iu',
  baseURL: env.IU_BASE_URL,
  apiKey: env.IU_API_KEY,
})

export const loopModel = iu(env.IU_MODEL)
