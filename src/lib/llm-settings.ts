// Pure by design (no `env.js` import — see CLAUDE.md's "modules importing env.ts are not
// unit-tested" rule) so the shape of what actually lands in the outgoing request body is
// testable without booting the env-parsing chain. `llm.ts` is the only consumer.

// Reasoning effort for every IU model call in this repo, top-level per the 2026-09-13
// gateway probe (`effort` as an `extra_body` shape is rejected; it's always
// `reasoning_effort`). Never `temperature` on this leg — house rule, and unsupported
// together with tools + reasoning_effort on some IU models.
export const REASONING_EFFORT = 'high'

// The Luna family rejects function tools with any reasoning effort on /chat/completions
// ("use /v1/responses or set reasoning_effort to 'none'") — and every call here is a tool
// call. Probed 2026-09-23 against gpt-6-luna: unset, low and high all fail (HTTP 503 wrapping
// a 400), only an explicit 'none' answers, so omitting the field is not a workaround either.
// 'none' is also what gpt-5.6-luna effectively ran with before, when no effort was sent.
export function reasoningEffortFor(modelId: string): 'none' | typeof REASONING_EFFORT {
  return /luna/i.test(modelId) ? 'none' : REASONING_EFFORT
}

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
export function roleProviderSettings(args: {
  role: LlmRole
  modelId: string
  maxCompletionTokens?: number | undefined
}): { providerOptions: { iu: { reasoningEffort: string; max_completion_tokens: number } } } {
  return {
    providerOptions: {
      iu: {
        reasoningEffort: reasoningEffortFor(args.modelId),
        max_completion_tokens: args.maxCompletionTokens ?? ROLE_BUDGETS[args.role],
      },
    },
  }
}

// Effort without a role budget — the consistency pass has no budget of its own yet, but its
// tool call still needs the Luna effort rule above or gpt-6-luna rejects it outright.
export function effortProviderSettings(modelId: string): { providerOptions: { iu: { reasoningEffort: string } } } {
  return { providerOptions: { iu: { reasoningEffort: reasoningEffortFor(modelId) } } }
}
