import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { wrapLanguageModel, defaultSettingsMiddleware } from 'ai'
import { env } from '../env.js'
import { ROLE_BUDGETS, roleProviderSettings, submitToolChoice } from './llm-settings.js'
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

export const planModel = withRoleSettings(rawLeadModel, 'plan')
export const synthesisModel = withRoleSettings(rawLeadModel, 'synthesis')
export const consistencyModel = withRoleSettings(rawLeadModel, 'consistency')
export const workerModel = withRoleSettings(rawWorkerModel, 'workerStep')

// The length-retry path (plan.ts/synthesize.ts: finishReason === 'length' retries once with a
// doubled budget before falling back). Worker steps don't get this — a starved worker step just
// logs it and keeps looping under its existing stopWhen/prepareStep ceiling.
export function leadModelWithDoubledBudget(role: 'plan' | 'synthesis'): IuLanguageModel {
  return withRoleSettings(rawLeadModel, role, ROLE_BUDGETS[role] * 2)
}

// The `toolChoice` for a lead/worker call that must end in its submit tool — see
// `submitToolChoice` for why it is not always a forced choice.
export const leadSubmitChoice = <T extends string>(toolName: T) => submitToolChoice(env.IU_LEAD_MODEL, toolName)
export const workerSubmitChoice = <T extends string>(toolName: T) => submitToolChoice(env.IU_WORKER_MODEL, toolName)
