import { describe, it, expect } from 'bun:test'
import { ROLE_BUDGETS, REASONING_EFFORT, roleProviderSettings } from './llm-settings.js'

// Pure module, no env.js import — asserts the exact request-body shape `llm.ts` merges into
// every call via `wrapLanguageModel` + `defaultSettingsMiddleware`. `@ai-sdk/openai-compatible@3`
// spreads `providerOptions.iu.*` straight into the outgoing args except for its own reserved
// keys; `reasoningEffort` is one of those (mapped to `reasoning_effort`), `max_completion_tokens`
// is not, so it must appear verbatim under that exact key — never `maxOutputTokens`/`max_tokens`,
// never `temperature`.
describe('roleProviderSettings', () => {
  it('sends reasoningEffort high and the role budget under the iu provider key', () => {
    const settings = roleProviderSettings('plan')
    expect(settings).toEqual({
      providerOptions: {
        iu: {
          reasoningEffort: 'high',
          max_completion_tokens: ROLE_BUDGETS.plan,
        },
      },
    })
  })

  it('keys the budget per call role, not one shared model-level value', () => {
    // plan raised 8_000 -> 16_000 on 2026-09-13: under 16k risked the reasoning-model
    // empty-content/finish_reason=length failure mode on this route. It now matches
    // workerStep's floor rather than getting its own distinct number.
    expect(ROLE_BUDGETS.plan).toBe(16_000)
    expect(ROLE_BUDGETS.workerStep).toBe(16_000)
    expect(ROLE_BUDGETS.synthesis).toBe(32_000)
  })

  it('accepts an override budget for the length-retry path without changing effort', () => {
    const doubled = roleProviderSettings('synthesis', ROLE_BUDGETS.synthesis * 2)
    expect(doubled.providerOptions.iu.max_completion_tokens).toBe(64_000)
    expect(doubled.providerOptions.iu.reasoningEffort).toBe(REASONING_EFFORT)
  })

  it('never carries maxOutputTokens/max_tokens or temperature keys', () => {
    const settings = roleProviderSettings('workerStep')
    const keys = Object.keys(settings.providerOptions.iu)
    expect(keys).not.toContain('maxOutputTokens')
    expect(keys).not.toContain('max_tokens')
    expect(keys).not.toContain('temperature')
  })
})
