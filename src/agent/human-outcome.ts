import type { HumanSolveResult } from './fetch-chain/types.js'

// The outcome of one human-solve attempt, as a span-attribute-shaped value. Pure.
//   browser    — the solver's own Chrome cleared the page, nobody was prompted
//   solved     — the owner solved it in the dialog flow (escalated)
//   suppressed — not attempted: solver down, MacBook unreachable, rate limit or busy
//   abandoned  — attempted and gave up (declined, unanswered, timed out, aborted, errored, a throw)
// `escalated` is true once the owner's dialog was (or would have been) in play.
export const HUMAN_OUTCOMES = ['browser', 'solved', 'suppressed', 'abandoned'] as const
export type HumanOutcome = (typeof HUMAN_OUTCOMES)[number]

// chrome_/proxy_unavailable are the same local-unavailable suppression as 'solver unavailable',
// just reported by the first attempt that hit it. 'timeout' is deliberately NOT a dialog reason:
// a browser-first attempt times out too, and the result carries no mode to tell them apart.
// A host-suppressed attempt reports the stored reason ('declined', ...) — human-solver.ts marks it
// `suppressed: true`, so it is told apart from a dialog that was actually shown and declined.
const SUPPRESSED = new Set(['solver unavailable', 'macbook unreachable', 'dialog rate limit', 'busy', 'chrome_unavailable', 'proxy_unavailable'])
const DIALOG_REASONS = new Set(['declined', 'unanswered', 'unreachable', 'dialog_error'])

export function classifyHumanResult(result: HumanSolveResult): {
  outcome: HumanOutcome
  escalated: boolean
  reason?: string
} {
  if (result.ok) return { outcome: result.mode === 'browser' ? 'browser' : 'solved', escalated: result.mode !== 'browser' }
  if (result.suppressed || SUPPRESSED.has(result.reason)) return { outcome: 'suppressed', escalated: false, reason: result.reason }
  return { outcome: 'abandoned', escalated: DIALOG_REASONS.has(result.reason), reason: result.reason }
}
