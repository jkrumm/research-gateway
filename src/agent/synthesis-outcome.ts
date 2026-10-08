import { SubmittedReport } from './schema.js'
import type { WorkerDigest } from './schema.js'
import { assembleReport } from './assemble.js'

// Env-free on purpose (schema.js + assemble.js only) so the classification is testable
// without secrets. synthesize.ts is the only caller.

export type SynthesisReply =
  | { kind: 'submitted'; report: SubmittedReport }
  | { kind: 'length' }
  // The model called submit_report but the arguments failed the schema (or the SDK marked
  // the call invalid).
  | { kind: 'malformed-call'; issues: string }
  // No tool call at all; the reply is prose.
  | { kind: 'text-only'; text: string }
  | { kind: 'no-output' }
  // Valid call, but resolveSynthesisReport refused it (schema echo / no usable citations).
  | { kind: 'guard' }

export interface ReplyShape {
  finishReason: string
  text: string
  toolCalls: ReadonlyArray<{ toolName: string; input: unknown; invalid?: boolean | undefined }>
}

export function classifySynthesisReply(reply: ReplyShape): SynthesisReply {
  const call = reply.toolCalls.find((c) => c.toolName === 'submit_report')
  if (call) {
    const parsed = call.invalid ? null : SubmittedReport.safeParse(call.input)
    if (parsed?.success) return { kind: 'submitted', report: parsed.data }
    // A call cut off mid-arguments is a budget problem, not a model mistake.
    if (reply.finishReason === 'length') return { kind: 'length' }
    const issues = parsed && !parsed.success ? parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : 'invalid tool call'
    return { kind: 'malformed-call', issues }
  }
  if (reply.finishReason === 'length') return { kind: 'length' }
  const text = reply.text.trim()
  return text ? { kind: 'text-only', text } : { kind: 'no-output' }
}

// A plain-text reply is only worth salvaging when it is the report itself: long enough to be
// one, not a JSON blob, not an apology. Below this it is cheaper to retry than to guess.
const MIN_SALVAGE_CHARS = 1500

// The report prose comes from the model's text; citations, sources and unverified come from
// the digests exactly as assembleReport carries them. Nothing here can vouch for a URL — the
// grounding ledger still gates every citation downstream.
export function reportFromText(text: string, digests: WorkerDigest[]): SubmittedReport | null {
  const body = text.trim()
  if (body.length < MIN_SALVAGE_CHARS || /^\{/.test(body)) return null
  return { ...assembleReport(digests), report: body }
}

// Plain prose that is the report beats the digest-assembled fallback: keep it. Any other kind
// passes through untouched.
export function trySalvage(reply: SynthesisReply, digests: WorkerDigest[]): SynthesisReply {
  if (reply.kind !== 'text-only') return reply
  const report = reportFromText(reply.text, digests)
  return report ? { kind: 'submitted', report } : reply
}

// Failures a second, compact attempt can plausibly fix. `length` has its own doubled-budget
// path and is deliberately absent.
export function isCompactRetryable(
  reply: SynthesisReply,
): reply is Extract<SynthesisReply, { kind: 'malformed-call' | 'text-only' | 'no-output' | 'guard' }> {
  return reply.kind === 'malformed-call' || reply.kind === 'text-only' || reply.kind === 'no-output' || reply.kind === 'guard'
}
