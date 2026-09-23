import type { ModelMessage } from 'ai'

// Pure, env-free helpers behind worker.ts's salvage path (repo rule: anything importing
// env.js is untested by design, so the decision logic and message assembly live here instead).

// Measured 2026-09-20..23 (prod, standard depth): ~20-22% of workers ended with NO digest
// (`round.retry` "worker completed without a valid digest"). The live example (jobId
// f8777749-9452-4ca4-b558-978830081bad) shows 50 `worker.step` events, all `finishReason:
// "tool-calls"`, zero `worker.length`, and a run of 6+ consecutive fetchPage-heavy steps
// immediately before `round.retry` fired — the 80% `prepareStep` check in worker.ts never
// tripped because a single step with 2-4 fetchPage results (each up to ~24k chars) can jump
// input tokens from comfortably under 80% of `profile.maxContextTokens` straight past 100% in
// one hop. `contextGuard`'s `stopWhen` then ends the loop before the model ever calls
// `submit_digest`.
//
// This extrapolates the last step's own growth one step further, so a step that is ALREADY
// growing fast enough to blow through the ceiling next step forces the submit-only step now,
// a step early. It degrades to the existing flat 80% check when there's no prior step (or no
// growth) to diff against.
export function shouldForceSubmit(args: {
  steps: ReadonlyArray<{ usage?: { inputTokens?: number | null | undefined } | null | undefined }>
  maxContextTokens: number
}): boolean {
  const { steps, maxContextTokens } = args
  const last = steps[steps.length - 1]
  const lastInput = last?.usage?.inputTokens ?? 0
  if (lastInput > maxContextTokens * 0.8) return true

  if (steps.length < 2) return false
  const prev = steps[steps.length - 2]
  const prevInput = prev?.usage?.inputTokens ?? 0
  if (prevInput <= 0) return false

  const growth = lastInput - prevInput
  return growth > 0 && lastInput + growth > maxContextTokens
}

// Assembles the one-shot salvage call's messages: the original user turn, the full transcript
// the main run produced (tool calls and their results — `result.response.messages`), and a
// final user turn telling the model its budget is gone. Kept separate from worker.ts so the
// assembly itself — order, roles, that nothing from the transcript is dropped — is testable
// without booting the LLM client.
export function buildSalvageMessages(args: {
  userPrompt: string
  transcript: ReadonlyArray<ModelMessage>
  instruction: string
}): ModelMessage[] {
  return [
    { role: 'user', content: args.userPrompt },
    ...args.transcript,
    { role: 'user', content: args.instruction },
  ]
}
