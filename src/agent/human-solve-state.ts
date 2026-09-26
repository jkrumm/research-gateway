// Per-host memory for the human-solve escalation path (agent/human-solve.ts is the I/O
// boundary that calls this; this module is pure and takes an injected clock — `now: number`
// on every call rather than reading `Date.now()` itself — so it is unit-testable with no
// wall-clock waits, same convention as admission.ts / fetch-guard.ts).
//
// In-memory by design, not persisted: a deploy (or a process restart) forgets every declined
// host, cleared cookie window, and the global dialog rate limit below. Accepted — a human-solve
// escalation is rare enough that re-learning this state costs at most one more dialog per host,
// and durability here would mean shipping a second small store next to job-store.ts for a path
// that already has its own multi-minute human-in-the-loop latency. Documented in deploy/MINI.md.

import { z } from 'zod'

// A recently-solved host is refetched locally on the mini ("cleared" mode, no dialog, no
// MacBook contact at all) rather than solved again — the cf_clearance cookie stays warm in the
// solver Chrome profile for a while after the challenge clears. 12h is optimistic for
// cf_clearance specifically (Cloudflare's own default passage is closer to 30 minutes, and
// site-configurable shorter or longer) — kept anyway because a stale clearance is cheap to
// find out about now that the whole "try cleared first" path is mini-local: it just costs one
// quick fetch that comes back `challenge`, and the caller escalates to `solve` from there. A
// long TTL only ever wastes that one local round trip; a short one would re-prompt the human
// for hosts that were still genuinely clear.
export const CLEARED_TTL_MS = 12 * 60 * 60 * 1000
// A host the human declined, or never answered for, is not re-prompted again immediately —
// the dialog would just interrupt them a second time for the same site.
export const SUPPRESS_HOST_MS = 6 * 60 * 60 * 1000
// Global: once ssh to the MacBook fails outright, don't retry every subsequent host against
// an unreachable machine for a few minutes.
export const UNREACHABLE_SUPPRESS_MS = 5 * 60 * 1000
// Global, not per-host: a fan-out of distinct hosts can each still be a first-ever prompt (no
// host-level suppression applies to any of them yet), so the per-host checks above don't bound
// how often the owner's screen actually gets a dialog. This is the backstop for that — social-
// engineering hardening, not a host-trust signal.
export const DIALOG_RATE_LIMIT_MAX = 6
export const DIALOG_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000

// Bounded map — this state lives for the process's whole lifetime with no other cap. Evicts
// the oldest entry (Map preserves insertion order) rather than growing without bound.
const MAX_HOSTS = 500

export type PlanAction = { action: 'fetch-cleared' } | { action: 'solve' } | { action: 'suppressed'; reason: string }

export type SolveOutcome =
  | 'solved'
  | 'cleared-ok'
  | 'cleared-challenge'
  | 'declined'
  | 'unanswered'
  | 'unreachable'
  | 'local-unavailable'
  | 'timeout'
  | 'error'

// The closed set of reasons a human-solve attempt can fail with — shared by bin/solver.ts's own
// result type, this module's zod parsing schemas below, and human-solver.ts's mapping into
// SolveOutcome. A typo in any of those three now becomes a compile error (or, for the schemas,
// an actual parse failure) instead of a string that silently never matches anywhere.
export const HUMAN_SOLVE_REASONS = [
  // Orchestration-level (never reaches bin/solver.ts; produced by human-solve.ts/human-solver.ts)
  'aborted',
  'busy',
  'unreachable',
  // Solver-process-level
  'chrome_unavailable',
  'proxy_unavailable',
  'open_tab_failed',
  'challenge',
  'unsafe-redirect',
  'timeout',
  // Dialog-level (JXA over ssh)
  'unanswered',
  'declined',
  'dialog_error',
  // Catch-all for anything else (a crash, an unparseable request, a signal) — detail always
  // goes to a log field alongside this, never encoded into the reason string itself.
  'error',
] as const
export type HumanSolveReason = (typeof HUMAN_SOLVE_REASONS)[number]

interface HostState {
  clearedAt?: number | undefined
  suppressedUntil?: number | undefined
  suppressReason?: string | undefined
}

export interface HumanSolveState {
  plan(host: string, now: number): PlanAction
  record(host: string, outcome: SolveOutcome, now: number): void
}

export function createHumanSolveState(): HumanSolveState {
  const hosts = new Map<string, HostState>()
  let macbookUnreachableUntil = 0
  // Distinct from macbookUnreachableUntil above: this is the solver's OWN Chrome or SSRF proxy
  // failing to come up, not the MacBook ssh/dialog path — a different failure with the same
  // "don't hammer it on every subsequent host" shape, so it gets its own short global window
  // rather than being folded into 'macbook unreachable' (which would misreport a solver-local
  // problem as a MacBook-reachability one).
  let localUnavailableUntil = 0
  // Timestamps of prompts allowed within the current rolling window — pruned lazily on every
  // check, so this array never grows past DIALOG_RATE_LIMIT_MAX entries.
  let dialogPromptTimestamps: number[] = []

  function touch(host: string): HostState {
    let state = hosts.get(host)
    if (state) return state
    if (hosts.size >= MAX_HOSTS) {
      const oldestKey = hosts.keys().next().value
      if (oldestKey !== undefined) hosts.delete(oldestKey)
    }
    state = {}
    hosts.set(host, state)
    return state
  }

  // Records a would-be prompt at plan()-decision time (the point a dialog is about to be
  // shown) and reports whether the rolling-hour budget still allows it.
  function admitDialogPrompt(now: number): boolean {
    dialogPromptTimestamps = dialogPromptTimestamps.filter((t) => now - t < DIALOG_RATE_LIMIT_WINDOW_MS)
    if (dialogPromptTimestamps.length >= DIALOG_RATE_LIMIT_MAX) return false
    dialogPromptTimestamps.push(now)
    return true
  }

  return {
    plan(host, now) {
      // The local-unavailable (Chrome/proxy down) guard stays ahead of EVERYTHING else,
      // including a warm cleared host below: fetch-cleared still runs bin/solver.ts locally on
      // the mini, so it needs the same Chrome/proxy a solve does, unlike the MacBook dialog.
      if (now < localUnavailableUntil) {
        return { action: 'suppressed', reason: 'solver unavailable' }
      }
      const state = hosts.get(host)
      if (state?.suppressedUntil !== undefined && now < state.suppressedUntil) {
        return { action: 'suppressed', reason: state.suppressReason ?? 'suppressed' }
      }
      // Checked BEFORE the macbookUnreachable guard below: a warm-cleared host is fetched
      // entirely locally on the mini (bin/solver.ts's 'fetch' mode, no dialog, no MacBook
      // contact at all), so an unreachable MacBook is not evidence against it — the old
      // ordering wrongly suppressed a still-fresh cleared cookie just because the LAST attempt
      // to solve some OTHER host's dialog happened to fail to reach the MacBook.
      if (state?.clearedAt !== undefined && now - state.clearedAt < CLEARED_TTL_MS) {
        return { action: 'fetch-cleared' }
      }
      if (now < macbookUnreachableUntil) {
        return { action: 'suppressed', reason: 'macbook unreachable' }
      }
      if (!admitDialogPrompt(now)) {
        return { action: 'suppressed', reason: 'dialog rate limit' }
      }
      return { action: 'solve' }
    },
    record(host, outcome, now) {
      switch (outcome) {
        case 'solved':
        case 'cleared-ok': {
          const state = touch(host)
          state.clearedAt = now
          state.suppressedUntil = undefined
          state.suppressReason = undefined
          break
        }
        case 'cleared-challenge': {
          const state = touch(host)
          state.clearedAt = undefined
          break
        }
        case 'declined': {
          const state = touch(host)
          state.suppressedUntil = now + SUPPRESS_HOST_MS
          state.suppressReason = 'declined'
          break
        }
        case 'unanswered':
        case 'timeout': {
          const state = touch(host)
          state.suppressedUntil = now + SUPPRESS_HOST_MS
          state.suppressReason = outcome
          break
        }
        case 'unreachable':
          macbookUnreachableUntil = now + UNREACHABLE_SUPPRESS_MS
          break
        case 'local-unavailable':
          localUnavailableUntil = now + UNREACHABLE_SUPPRESS_MS
          break
        case 'error':
          // A transient solver error is not evidence about this host — leave its
          // cleared/suppressed state exactly as it was.
          break
      }
    },
  }
}

// ── Solver stdout parsing ────────────────────────────────────────────────────────

const MAX_HTML_LEN = 5 * 1024 * 1024

const SolverOkPage = z.object({
  ok: z.literal(true),
  html: z.string().max(MAX_HTML_LEN),
  finalUrl: z.string(),
  mode: z.enum(['solved', 'cleared']),
})
// The 'warm' result of a launch/verify-only run (mode 'warm' — no tab, no html) — run before
// the MacBook dialog so Chrome/proxy failures short-circuit to a suppression instead of
// prompting the human for a browser that isn't there.
const SolverOkWarm = z.object({
  ok: z.literal(true),
  mode: z.literal('warm'),
})
const SolverErr = z.object({
  ok: z.literal(false),
  reason: z.enum(HUMAN_SOLVE_REASONS),
})
const SolverOutputSchema = z.union([SolverOkPage, SolverOkWarm, SolverErr])
export type SolverOutput = z.infer<typeof SolverOutputSchema>

function parseLastJsonLine<T>(stdout: string, schema: z.ZodType<T>): T | null {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  for (let i = lines.length - 1; i >= 0; i--) {
    let candidate: unknown
    try {
      candidate = JSON.parse(lines[i]!)
    } catch {
      continue
    }
    const parsed = schema.safeParse(candidate)
    if (parsed.success) return parsed.data
  }
  return null
}

/** The solver prints exactly one JSON result as its last stdout line; everything else is
 * logging noise on the same stream if a dependency ever misbehaves. Scans backward so a
 * stray non-JSON trailing line doesn't hide a valid result above it. */
export function parseSolverOutput(stdout: string): SolverOutput {
  return parseLastJsonLine(stdout, SolverOutputSchema) ?? { ok: false, reason: 'error' }
}

// ── MacBook dialog (JXA over ssh) output parsing ─────────────────────────────────

const DialogOutputSchema = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), reason: z.enum(HUMAN_SOLVE_REASONS) }),
])
export type DialogOutput = z.infer<typeof DialogOutputSchema>

/** Same "last parseable JSON line" contract as parseSolverOutput, for the tiny `{ok:true} |
 * {ok:false, reason}` the MacBook's JXA dialog program prints (only ever 'declined' or
 * 'unanswered' in practice — the wider closed set is accepted here too so a ssh/osascript-level
 * failure this file didn't originate can still be recorded as 'error' instead of falling
 * through to the generic unparseable-output fallback below). */
export function parseDialogOutput(stdout: string): DialogOutput {
  return parseLastJsonLine(stdout, DialogOutputSchema) ?? { ok: false, reason: 'error' }
}
