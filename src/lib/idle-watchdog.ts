// A liveness check for one `generateText` call, not a time budget for it. The agent loop has
// no step/turn limit and no wall-clock ceiling (settled 2026-09-12) — the only thing that may
// abort a call is silence: no step/tool activity for `idleMs`. `generateText` in this codebase
// is non-streaming, so there is no token-level signal inside a single step; `arm()` is instead
// called from every step/tool-execution callback the AI SDK exposes to `generateText`
// (`onStepEnd`, `onToolExecutionStart`, `onToolExecutionEnd`), so the clock resets on any
// observable progress and only fires when a single step has produced nothing at all for the
// whole idle window — including a step stuck mid-request, which `abortSignal` actually cancels
// (the SDK threads it through to the underlying fetch).
export interface IdleWatchdog {
  readonly signal: AbortSignal
  // Reset the idle clock — call on every step/tool event.
  arm: () => void
  // Stop the timer. Always call this once the `generateText` call settles (finally), or the
  // timer leaks for `idleMs` past a call that already finished.
  clear: () => void
}

export function createIdleWatchdog(idleMs: number): IdleWatchdog {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined

  const clear = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }

  const arm = (): void => {
    clear()
    if (controller.signal.aborted) return
    timer = setTimeout(() => {
      controller.abort(new Error(`idle: no step/tool activity for ${idleMs}ms`))
    }, idleMs)
    // Never keep the process alive on its own — matches `_sweepTimer`/heartbeat timers
    // elsewhere in this codebase.
    if (typeof timer.unref === 'function') timer.unref()
  }

  return { signal: controller.signal, arm, clear }
}
