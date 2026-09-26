import { describe, it, expect, spyOn } from 'bun:test'
import { createHumanSolver, solverBudgetMs, type HumanSolverPorts } from './human-solver.js'
import { createHumanSolveState } from './human-solve-state.js'
import type { HumanSolveRequest } from './fetch-chain.js'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function makeRequest(overrides: Partial<HumanSolveRequest> = {}): HumanSolveRequest {
  const controller = new AbortController()
  return { url: 'https://example.com/page', host: 'example.com', reason: 'cloudflare challenge', signal: controller.signal, ...overrides }
}

interface Harness {
  ports: HumanSolverPorts
  logs: Array<{ event: string; fields: Record<string, unknown> }>
  promptCalls: HumanSolveRequest[]
  runSolverCalls: Array<{ mode: string; req: HumanSolveRequest; timeoutMs: number }>
  clock: { now: number }
  slotActive: number
  setPromptResult: (fn: HumanSolverPorts['promptUser']) => void
  setRunSolverResult: (fn: HumanSolverPorts['runSolver']) => void
}

function makeHarness(): Harness {
  const logs: Harness['logs'] = []
  const promptCalls: HumanSolveRequest[] = []
  const runSolverCalls: Harness['runSolverCalls'] = []
  const clock = { now: 1_000 }
  let slotActive = 0

  let promptImpl: HumanSolverPorts['promptUser'] = async () => ({ ok: true })
  let runSolverImpl: HumanSolverPorts['runSolver'] = async () => ({ ok: true, mode: 'warm' })

  const ports: HumanSolverPorts = {
    waitMs: 60_000,
    now: () => clock.now,
    log: (event, fields = {}) => {
      logs.push({ event, fields })
    },
    state: createHumanSolveState(),
    promptUser: async (req) => {
      promptCalls.push(req)
      return promptImpl(req)
    },
    runSolver: async (mode, req, timeoutMs) => {
      runSolverCalls.push({ mode, req, timeoutMs })
      return runSolverImpl(mode, req, timeoutMs)
    },
    acquireClearedSlot: async () => {
      slotActive++
      return true
    },
    releaseClearedSlot: () => {
      slotActive--
    },
  }

  return {
    ports,
    logs,
    promptCalls,
    runSolverCalls,
    clock,
    get slotActive() {
      return slotActive
    },
    setPromptResult: (fn) => {
      promptImpl = fn
    },
    setRunSolverResult: (fn) => {
      runSolverImpl = fn
    },
  }
}

describe('solverBudgetMs', () => {
  it('subtracts elapsed time and the safety margin', () => {
    expect(solverBudgetMs(60_000, 0)).toBe(50_000)
    expect(solverBudgetMs(60_000, 30_000)).toBe(20_000)
  })

  it('never returns less than the 1s floor, even for a fully-spent budget', () => {
    expect(solverBudgetMs(60_000, 60_000)).toBe(1_000)
    expect(solverBudgetMs(60_000, 1_000_000)).toBe(1_000)
  })
})

describe('createHumanSolver — browser-first', () => {
  it('an unknown host runs a browser-only fetch before any dialog, and never prompts when it succeeds outright', async () => {
    const h = makeHarness()
    h.setRunSolverResult(async () => ({ ok: true, html: '<html>ok</html>', finalUrl: 'https://example.com/page', mode: 'cleared' }))
    const solver = createHumanSolver(h.ports)
    const result = await solver(makeRequest())
    // The solver's own 'cleared' label is relabeled 'browser' — no human was ever involved.
    expect(result).toEqual({ ok: true, html: '<html>ok</html>', finalUrl: 'https://example.com/page', mode: 'browser' })
    expect(h.runSolverCalls.map((c) => c.mode)).toEqual(['fetch'])
    expect(h.promptCalls.length).toBe(0)
  })

  it('escalates to the dialog only once the browser-only fetch comes back challenge', async () => {
    const h = makeHarness()
    h.setRunSolverResult(async (mode) => {
      if (mode === 'fetch') return { ok: false, reason: 'challenge' }
      return { ok: true, html: '<html>ok</html>', finalUrl: 'https://example.com/page', mode: 'solved' }
    })
    const solver = createHumanSolver(h.ports)
    const result = await solver(makeRequest())
    expect(result.ok).toBe(true)
    expect(h.runSolverCalls.map((c) => c.mode)).toEqual(['fetch', 'solve'])
    expect(h.promptCalls.length).toBe(1)
  })

  it('a browser-only failure (chrome_unavailable) never prompts the human, and suppresses globally', async () => {
    const h = makeHarness()
    h.setRunSolverResult(async () => ({ ok: false, reason: 'chrome_unavailable' }))
    const solver = createHumanSolver(h.ports)

    const result = await solver(makeRequest({ host: 'a.example' }))
    expect(result).toEqual({ ok: false, reason: 'chrome_unavailable' })
    expect(h.promptCalls.length).toBe(0)

    // The suppression is global (not per-host) — a DIFFERENT host is suppressed too, and its
    // dialog is never even attempted (runSolver isn't called again for it either).
    const callsBefore = h.runSolverCalls.length
    const second = await solver(makeRequest({ host: 'b.example' }))
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.reason).toBe('solver unavailable')
    expect(h.runSolverCalls.length).toBe(callsBefore) // never even tried the browser again
  })

  it('logs exactly one human_solve.done for a browser-only failure', async () => {
    const h = makeHarness()
    h.setRunSolverResult(async () => ({ ok: false, reason: 'proxy_unavailable' }))
    const solver = createHumanSolver(h.ports)
    await solver(makeRequest())
    const doneLogs = h.logs.filter((l) => l.event === 'human_solve.done')
    expect(doneLogs.length).toBe(1)
    expect(doneLogs[0]?.fields['outcome']).toBe('proxy_unavailable')
  })
})

describe('createHumanSolver — browser-then-solve escalation', () => {
  it('releases the browser slot BEFORE escalating to the dialog on a challenge result', async () => {
    const h = makeHarness()
    const releaseOrder: string[] = []
    const originalRelease = h.ports.releaseClearedSlot
    h.ports.releaseClearedSlot = () => {
      releaseOrder.push('release')
      originalRelease()
    }
    h.setRunSolverResult(async (mode) => {
      if (mode === 'fetch') return { ok: false, reason: 'challenge' }
      return { ok: true, html: '<html>solved</html>', finalUrl: 'https://example.com/page', mode: 'solved' }
    })
    h.setPromptResult(async () => {
      releaseOrder.push('prompt')
      return { ok: true }
    })

    const solver = createHumanSolver(h.ports)
    const result = await solver(makeRequest())

    expect(result.ok).toBe(true)
    // release happened before the dialog (the escalation), never held across it.
    expect(releaseOrder).toEqual(['release', 'prompt'])
    expect(h.slotActive).toBe(0)
  })

  it('escalates through planDialog, so a dialog-rate-limited host does not get a second dialog', async () => {
    const h = makeHarness()
    // Exhaust the global dialog budget on OTHER hosts first — this never happens via plan()
    // (a browser-only attempt must not consume the dialog rate limit), only via planDialog.
    for (let i = 0; i < 6; i++) h.ports.state.planDialog(`filler-${i}.example`, h.clock.now)

    h.setRunSolverResult(async (mode) => {
      if (mode === 'fetch') return { ok: false, reason: 'challenge' }
      return { ok: true, mode: 'warm' }
    })
    const solver = createHumanSolver(h.ports)
    const result = await solver(makeRequest())

    expect(result).toEqual({ ok: false, reason: 'dialog rate limit' })
    expect(h.promptCalls.length).toBe(0) // never reached the dialog — suppressed by admission
  })
})

describe('createHumanSolver — abort races the queued wait, not just the running step', () => {
  it('a cancelled solve queued behind another in-flight solve returns aborted immediately', async () => {
    const h = makeHarness()
    const firstGate = deferred<void>()
    h.setPromptResult(async (req) => {
      if (req.host === 'first.example') await firstGate.promise
      return { ok: true }
    })
    h.setRunSolverResult(async (mode) => {
      if (mode === 'fetch') return { ok: false, reason: 'challenge' } // force escalation to the dialog for both hosts
      return { ok: true, mode: 'warm' }
    })
    const solver = createHumanSolver(h.ports)

    // Occupy the global solve lock with a slow first solve (different host — the lock is
    // process-wide, not per-host).
    const firstDone = solver(makeRequest({ host: 'first.example' }))

    const secondController = new AbortController()
    const secondReq = makeRequest({ host: 'second.example', signal: secondController.signal })
    const secondDone = solver(secondReq)

    // Cancel the second request while it is still queued behind the first (which is blocked on
    // firstGate) — it must resolve to 'aborted' right away, without waiting for the first solve.
    secondController.abort()
    const second = await secondDone
    expect(second).toEqual({ ok: false, reason: 'aborted' })
    expect(h.promptCalls.some((r) => r.host === 'second.example')).toBe(false)

    firstGate.resolve()
    await firstDone
  })

  it('never leaks a browser-only slot when the caller aborts while the slot is still queued', async () => {
    const h = makeHarness()
    const slotGate = deferred<boolean>()
    h.ports.acquireClearedSlot = async () => {
      const got = await slotGate.promise
      return got
    }
    let released = 0
    h.ports.releaseClearedSlot = () => {
      released++
    }
    const controller = new AbortController()
    const solver = createHumanSolver(h.ports)
    const pending = solver(makeRequest({ signal: controller.signal }))

    // Let the chain (runExclusiveForHost's tail -> attemptSolve -> runBrowser ->
    // acquireClearedSlotOrAbort) actually reach its `await` on the still-pending slot BEFORE
    // aborting — otherwise the top-of-function `signal.aborted` guard would short-circuit
    // before the slot was ever requested, which is a different (also correct, but untested-by-
    // this-case) code path.
    await Promise.resolve()
    await Promise.resolve()
    controller.abort()
    const result = await pending
    expect(result).toEqual({ ok: false, reason: 'aborted' })
    expect(released).toBe(0) // not granted yet, so nothing to release yet

    // The slot resolves as granted AFTER the caller already gave up — must be released, not
    // leaked.
    slotGate.resolve(true)
    await new Promise((r) => setTimeout(r, 0))
    expect(released).toBe(1)
  })
})

describe('createHumanSolver — abort-listener hygiene and unexpected errors', () => {
  it('does not leak an abort listener on the request signal for a browser-only fetch that never aborts', async () => {
    const h = makeHarness()
    h.setRunSolverResult(async () => ({ ok: true, html: '<html>ok</html>', finalUrl: 'https://example.com/page', mode: 'cleared' }))
    const solver = createHumanSolver(h.ports)
    const req = makeRequest()
    const addSpy = spyOn(req.signal, 'addEventListener')
    const removeSpy = spyOn(req.signal, 'removeEventListener')

    const result = await solver(req)

    expect(result.ok).toBe(true)
    // Every 'abort' listener this call ever registered (acquireClearedSlotOrAbort's own, plus
    // raceAbort's) must have been removed again — none is allowed to outlive the call and
    // accumulate on a signal that may be reused across many requests.
    expect(addSpy.mock.calls.length).toBeGreaterThan(0)
    expect(removeSpy.mock.calls.length).toBe(addSpy.mock.calls.length)
  })

  it('logs human_solve.unexpected_error and resolves {ok:false, reason:"error"} for a throw that is NOT caused by an abort', async () => {
    const h = makeHarness()
    h.setRunSolverResult(async (mode) => {
      if (mode === 'fetch') return { ok: false, reason: 'challenge' } // force escalation to the dialog
      return { ok: true, mode: 'warm' }
    })
    h.setPromptResult(async () => {
      throw new Error('boom')
    })
    const solver = createHumanSolver(h.ports)

    const result = await solver(makeRequest())

    expect(result).toEqual({ ok: false, reason: 'error' })
    const errorLog = h.logs.find((l) => l.event === 'human_solve.unexpected_error')
    expect(errorLog?.fields['error']).toContain('boom')
  })
})

describe('createHumanSolver — single-flight per host', () => {
  it('a second request for the same host waits for the first, and its OWN browser-only attempt resolves it — never a second dialog', async () => {
    const h = makeHarness()
    let solveCount = 0
    let fetchCount = 0
    h.setRunSolverResult(async (mode) => {
      if (mode === 'fetch') {
        fetchCount++
        // First call: not yet cleared, so it escalates. Second call (chained onto the first's
        // tail): the warm cookie the first solve just left behind clears it outright — plan()
        // sends BOTH calls to a browser-only attempt first, exactly the same way, so the second
        // call's own success is what resolves it, never a bypass to a second dialog.
        if (fetchCount === 1) return { ok: false, reason: 'challenge' }
        return { ok: true, html: '<html>ok</html>', finalUrl: 'https://example.com/page', mode: 'cleared' }
      }
      solveCount++
      return { ok: true, html: '<html>ok</html>', finalUrl: 'https://example.com/page', mode: 'solved' }
    })
    const solver = createHumanSolver(h.ports)

    const [a, b] = await Promise.all([solver(makeRequest()), solver(makeRequest())])
    expect(a.ok).toBe(true)
    expect(solveCount).toBe(1) // the dialog only ever ran once
    expect(fetchCount).toBe(2) // both calls tried the browser first
    expect(b.ok).toBe(true)
  })
})
