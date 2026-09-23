import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { wrapLanguageModel, defaultSettingsMiddleware } from 'ai'
import { env } from '../env.js'
import { ROLE_BUDGETS, effortProviderSettings, roleProviderSettings } from './llm-settings.js'
import type { LlmRole } from './llm-settings.js'

export { ROLE_BUDGETS, REASONING_EFFORT } from './llm-settings.js'
export type { LlmRole } from './llm-settings.js'

export const iu = createOpenAICompatible({
  name: 'iu',
  baseURL: env.IU_BASE_URL,
  apiKey: env.IU_API_KEY,
})

// The concrete model type `iu(modelId)` and `wrapLanguageModel(...)` both produce — inferred
// rather than imported from `@ai-sdk/provider` (a transitive dep, not one of this repo's own).
export type IuLanguageModel = ReturnType<typeof iu>

// Applied in this ONE place via `wrapLanguageModel` + `defaultSettingsMiddleware` — call sites
// just pass `planModel`/`workerModel`/`synthesisModel` to `generateText`, never ad-hoc
// `providerOptions`. See `llm-settings.ts` for exactly what lands in the request body and why.
function withRoleSettings(model: IuLanguageModel, role: LlmRole, maxCompletionTokens?: number): IuLanguageModel {
  return wrapLanguageModel({
    model,
    middleware: defaultSettingsMiddleware({
      settings: roleProviderSettings({ role, modelId: model.modelId, maxCompletionTokens }),
    }),
  })
}

const rawLeadModel = iu(env.IU_LEAD_MODEL)
const rawWorkerModel = iu(env.IU_WORKER_MODEL)

// Lead model for callers with no role budget yet (consistency review) — effort only.
export const leadModel = wrapLanguageModel({
  model: rawLeadModel,
  middleware: defaultSettingsMiddleware({ settings: effortProviderSettings(rawLeadModel.modelId) }),
})
export const planModel = withRoleSettings(rawLeadModel, 'plan')
export const synthesisModel = withRoleSettings(rawLeadModel, 'synthesis')
export const workerModel = withRoleSettings(rawWorkerModel, 'workerStep')

// The length-retry path (plan.ts/synthesize.ts: finishReason === 'length' retries once with a
// doubled budget before falling back). Worker steps don't get this — a starved worker step just
// logs it and keeps looping under its existing stopWhen/prepareStep ceiling.
export function leadModelWithDoubledBudget(role: 'plan' | 'synthesis'): IuLanguageModel {
  return withRoleSettings(rawLeadModel, role, ROLE_BUDGETS[role] * 2)
}
