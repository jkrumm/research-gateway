// Pure by design (no `env.js` import — see CLAUDE.md's "modules importing env.ts are not
// unit-tested" rule) so the shape of what actually lands in the outgoing request body is
// testable without booting the env-parsing chain. `llm.ts` is the only consumer.

// Reasoning effort for every IU model call in this repo, top-level per the 2026-09-13
// gateway probe (`effort` as an `extra_body` shape is rejected; it's always
// `reasoning_effort`). Never `temperature` on this leg — house rule, and unsupported
// together with tools + reasoning_effort on some IU models.
export const REASONING_EFFORT = 'high'

// Plan and synthesis both run on IU_LEAD_MODEL but need very different output budgets — the
// synthesis report is written entirely inside the `submit_report` tool call, plan's tool call
// is a handful of sub-questions, and a worker step is a normal tool-use turn. So budget is
// keyed per CALL ROLE, not per model env var — this is the one place all three live.
export const ROLE_BUDGETS = {
  plan: 16_000,
  workerStep: 16_000,
  synthesis: 32_000,
} as const

export type LlmRole = keyof typeof ROLE_BUDGETS

// What `wrapLanguageModel` + `defaultSettingsMiddleware` merges into every call for a role.
// `providerOptions.iu.*` is what `@ai-sdk/openai-compatible@3` spreads into the request body:
// `reasoningEffort` maps to `reasoning_effort`; `max_completion_tokens` is not one of the
// package's reserved option keys (`user`, `reasoningEffort`, `textVerbosity`,
// `strictJsonSchema`), so it passes through under its own name unchanged (verified in
// node_modules/@ai-sdk/openai-compatible/dist/index.js:352-374, :580-590). Never
// `maxOutputTokens` (sent as `max_tokens`).
export function roleProviderSettings(
  role: LlmRole,
  maxCompletionTokens: number = ROLE_BUDGETS[role],
): { providerOptions: { iu: { reasoningEffort: string; max_completion_tokens: number } } } {
  return {
    providerOptions: {
      iu: {
        reasoningEffort: REASONING_EFFORT,
        max_completion_tokens: maxCompletionTokens,
      },
    },
  }
}
