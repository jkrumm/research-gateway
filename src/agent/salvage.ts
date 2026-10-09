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

// The name of the only tool offered on the salvage call — kept as one constant so worker.ts's
// `repairToolCall` and this instruction never drift on what the model is actually allowed to
// call.
export const SALVAGE_TOOL_NAME = 'submit_digest'

// Measured 2026-09-23 (jobId 2ad752ba-e7af-49f8-ae81-5cee738f4d4d): the PREVIOUS instruction
// ("Budget reached. Submit your digest now...") never told the model WHY its tool list had
// just shrunk to one entry. Faced with a transcript full of brainNotes/searchWeb/fetchPage
// calls and then only submit_digest on offer, the model confabulated an explanation and wrote
// it into the digest's own summary — a claim that tools were unavailable — which then read, to
// the report's own reader, as if the run itself had broken. This version states the real reason
// (a budget, not a fault) and explicitly forbids commentary on tool/budget/error status in the
// output — deliberately avoiding the very words ("unavailable", "disabled", "broken") a model
// reaches for when narrating a tool-access problem, so there is nothing left to echo.
export function buildSalvageInstruction(): string {
  return [
    'The research phase for this sub-question has ended because the evidence-gathering budget is spent — not due to any problem with the tools themselves. Do not comment on tools, budgets, retries, or errors anywhere in your answer.',
    `Using ONLY the tool results already present earlier in this conversation, call ${SALVAGE_TOOL_NAME} now:`,
    '- summary and findings: what those retrieved sources actually establish, citing only their URLs.',
    '- openGaps: anything you could not establish from what you already retrieved, phrased as a self-contained research question a fresh worker could investigate — never as a note about what went wrong.',
  ].join('\n')
}

// Why a salvage call produced no digest. 18 of 197 salvages came back empty (2026-10-09), so the
// next audit needs the cause, and the retry needs to know whether a nudge can help.
export type SalvageFailure = 'invalid-call' | 'text-only' | 'no-output'

export function classifySalvageFailure(reply: { text: string; toolCalls: ReadonlyArray<unknown> }): SalvageFailure {
  if (reply.toolCalls.length > 0) return 'invalid-call' // a call arrived but did not parse as a digest
  return reply.text.trim().length > 0 ? 'text-only' : 'no-output'
}

// The second and last salvage attempt, appended after the first reply. Short and mechanical: the
// first reply did not call the tool, so say only that and what to do.
export function buildSalvageRetryInstruction(failure: SalvageFailure): string {
  const reasons: Record<SalvageFailure, string> = {
    'invalid-call': `Your ${SALVAGE_TOOL_NAME} call was malformed or named the wrong tool.`,
    'text-only': `You answered in plain text instead of calling ${SALVAGE_TOOL_NAME}.`,
    'no-output': `You returned no ${SALVAGE_TOOL_NAME} call.`,
  }
  return `${reasons[failure]} Call ${SALVAGE_TOOL_NAME} now with a valid summary, findings and openGaps, built only from the tool results already in this conversation. If few findings are supported, submit those and put the rest in openGaps.`
}
