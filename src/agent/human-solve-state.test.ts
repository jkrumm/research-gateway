import { describe, it, expect } from 'bun:test'
import {
  createHumanSolveState,
  parseSolverOutput,
  parseDialogOutput,
  SUPPRESS_HOST_MS,
  UNREACHABLE_SUPPRESS_MS,
  DIALOG_RATE_LIMIT_MAX,
  DIALOG_RATE_LIMIT_WINDOW_MS,
  HUMAN_SOLVE_REASONS,
} from './human-solve-state.js'

describe('createHumanSolveState — plan (browser-first)', () => {
  it('defaults to browser for an unknown host — never straight to solve', () => {
    const state = createHumanSolveState()
    expect(state.plan('example.com', 1_000)).toEqual({ action: 'browser' })
  })

  it('a previously-solved host still goes through browser first, same as an unknown one', () => {
    const state = createHumanSolveState()
    state.record('example.com', 'solved', 1_000)
    expect(state.plan('example.com', 1_000)).toEqual({ action: 'browser' })
  })

  it('cleared-ok, cleared-challenge and error all leave the host on the browser path', () => {
    const state = createHumanSolveState()
    state.record('example.com', 'cleared-ok', 5_000)
    expect(state.plan('example.com', 5_000)).toEqual({ action: 'browser' })
    state.record('example.com', 'cleared-challenge', 6_000)
    expect(state.plan('example.com', 6_000)).toEqual({ action: 'browser' })
    state.record('example.com', 'error', 7_000)
    expect(state.plan('example.com', 7_000)).toEqual({ action: 'browser' })
  })

  it('suppresses a declined host for SUPPRESS_HOST_MS then reopens to browser', () => {
    const state = createHumanSolveState()
    state.record('example.com', 'declined', 1_000)
    expect(state.plan('example.com', 1_000)).toEqual({ action: 'suppressed', reason: 'declined' })
    expect(state.plan('example.com', 1_000 + SUPPRESS_HOST_MS - 1)).toEqual({
      action: 'suppressed',
      reason: 'declined',
    })
    expect(state.plan('example.com', 1_000 + SUPPRESS_HOST_MS + 1)).toEqual({ action: 'browser' })
  })

  it('unanswered and timeout suppress the same way as declined', () => {
    const state = createHumanSolveState()
    state.record('a.example', 'unanswered', 1_000)
    state.record('b.example', 'timeout', 1_000)
    expect(state.plan('a.example', 1_000)).toEqual({ action: 'suppressed', reason: 'unanswered' })
    expect(state.plan('b.example', 1_000)).toEqual({ action: 'suppressed', reason: 'timeout' })
  })

  it('unreachable (MacBook/dialog path) does NOT block a browser-only attempt — no dialog is involved', () => {
    const state = createHumanSolveState()
    state.record('a.example', 'unreachable', 1_000)
    expect(state.plan('a.example', 1_000)).toEqual({ action: 'browser' })
    expect(state.plan('never-seen-before.example', 1_000)).toEqual({ action: 'browser' })
  })

  it('a browser-only plan() never consumes the dialog rate limit budget', () => {
    const state = createHumanSolveState()
    for (let i = 0; i < DIALOG_RATE_LIMIT_MAX + 5; i++) {
      expect(state.plan(`host-${i}.example`, 1_000)).toEqual({ action: 'browser' })
    }
    // Still un-consumed — planDialog for a fresh host still gets 'solve'.
    expect(state.planDialog('fresh.example', 1_000)).toEqual({ action: 'solve' })
  })

  it('local-unavailable (chrome/proxy down) suppresses every host globally for browser too, distinct from macbook-unreachable', () => {
    const state = createHumanSolveState()
    state.record('a.example', 'local-unavailable', 1_000)
    expect(state.plan('a.example', 1_000)).toEqual({ action: 'suppressed', reason: 'solver unavailable' })
    expect(state.plan('never-seen-before.example', 1_000)).toEqual({
      action: 'suppressed',
      reason: 'solver unavailable',
    })
    expect(state.plan('a.example', 1_000 + UNREACHABLE_SUPPRESS_MS + 1)).toEqual({ action: 'browser' })
  })

  it('bounds the map: the oldest host is evicted once the cap is exceeded', () => {
    const state = createHumanSolveState()
    for (let i = 0; i < 501; i++) {
      state.record(`host-${i}.example`, 'declined', 1_000)
    }
    // host-0 was the first inserted; it should have been evicted, so it is no longer
    // suppressed.
    expect(state.plan('host-0.example', 1_000)).toEqual({ action: 'browser' })
    expect(state.plan('host-500.example', 1_000)).toEqual({ action: 'suppressed', reason: 'declined' })
  })
})

describe('createHumanSolveState — planDialog (the escalation gate)', () => {
  it('defaults to solve for a fresh host', () => {
    const state = createHumanSolveState()
    expect(state.planDialog('example.com', 1_000)).toEqual({ action: 'solve' })
  })

  it('suppresses a declined/unanswered/timeout host the same 6h window plan() does', () => {
    const state = createHumanSolveState()
    state.record('example.com', 'declined', 1_000)
    expect(state.planDialog('example.com', 1_000)).toEqual({ action: 'suppressed', reason: 'declined' })
    expect(state.planDialog('example.com', 1_000 + SUPPRESS_HOST_MS + 1)).toEqual({ action: 'solve' })
  })

  it('unreachable suppresses every host globally for UNREACHABLE_SUPPRESS_MS', () => {
    const state = createHumanSolveState()
    state.record('a.example', 'unreachable', 1_000)
    expect(state.planDialog('a.example', 1_000)).toEqual({ action: 'suppressed', reason: 'macbook unreachable' })
    expect(state.planDialog('never-seen-before.example', 1_000)).toEqual({
      action: 'suppressed',
      reason: 'macbook unreachable',
    })
    expect(state.planDialog('a.example', 1_000 + UNREACHABLE_SUPPRESS_MS + 1)).toEqual({ action: 'solve' })
  })

  it('local-unavailable suppresses the dialog gate too', () => {
    const state = createHumanSolveState()
    state.record('a.example', 'local-unavailable', 1_000)
    expect(state.planDialog('a.example', 1_000)).toEqual({ action: 'suppressed', reason: 'solver unavailable' })
  })

  it('suppresses further dialogs once DIALOG_RATE_LIMIT_MAX prompts fire within the window, across distinct hosts', () => {
    const state = createHumanSolveState()
    for (let i = 0; i < DIALOG_RATE_LIMIT_MAX; i++) {
      expect(state.planDialog(`host-${i}.example`, 1_000)).toEqual({ action: 'solve' })
    }
    expect(state.planDialog('one-too-many.example', 1_000)).toEqual({ action: 'suppressed', reason: 'dialog rate limit' })
    // A never-seen host that would otherwise get 'solve' is suppressed too — the limit is
    // global, not per-host.
    expect(state.planDialog('also-new.example', 1_000)).toEqual({ action: 'suppressed', reason: 'dialog rate limit' })
  })

  it('the dialog rate limit rolls off after DIALOG_RATE_LIMIT_WINDOW_MS', () => {
    const state = createHumanSolveState()
    for (let i = 0; i < DIALOG_RATE_LIMIT_MAX; i++) {
      state.planDialog(`host-${i}.example`, 1_000)
    }
    expect(state.planDialog('over-limit.example', 1_000 + DIALOG_RATE_LIMIT_WINDOW_MS - 1)).toEqual({
      action: 'suppressed',
      reason: 'dialog rate limit',
    })
    expect(state.planDialog('back-to-normal.example', 1_000 + DIALOG_RATE_LIMIT_WINDOW_MS + 1)).toEqual({ action: 'solve' })
  })
})

describe('parseSolverOutput', () => {
  it('parses a single-line ok result', () => {
    const out = JSON.stringify({ ok: true, html: '<html></html>', finalUrl: 'https://example.com/', mode: 'cleared' })
    expect(parseSolverOutput(out)).toEqual({
      ok: true,
      html: '<html></html>',
      finalUrl: 'https://example.com/',
      mode: 'cleared',
    })
  })

  it('parses a single-line error result', () => {
    const out = JSON.stringify({ ok: false, reason: 'declined' })
    expect(parseSolverOutput(out)).toEqual({ ok: false, reason: 'declined' })
  })

  it('takes the last parseable JSON line, ignoring noise above it', () => {
    const out = `some stray log line\n{"not":"the result"}\n${JSON.stringify({ ok: false, reason: 'timeout' })}`
    expect(parseSolverOutput(out)).toEqual({ ok: false, reason: 'timeout' })
  })

  it('falls back to an error result when nothing parses', () => {
    expect(parseSolverOutput('garbage\nmore garbage').ok).toBe(false)
  })

  it('rejects html over the 5 MB cap', () => {
    const huge = 'x'.repeat(6 * 1024 * 1024)
    const out = JSON.stringify({ ok: true, html: huge, finalUrl: 'https://example.com/', mode: 'solved' })
    expect(parseSolverOutput(out).ok).toBe(false)
  })

  it('parses a warm-mode ok result (no html/finalUrl)', () => {
    expect(parseSolverOutput(JSON.stringify({ ok: true, mode: 'warm' }))).toEqual({ ok: true, mode: 'warm' })
  })

  it('parses an ok result carrying the settled page status', () => {
    const out = JSON.stringify({ ok: true, html: '<html></html>', finalUrl: 'https://example.com/', mode: 'cleared', status: 404 })
    expect(parseSolverOutput(out)).toEqual({
      ok: true,
      html: '<html></html>',
      finalUrl: 'https://example.com/',
      mode: 'cleared',
      status: 404,
    })
  })

  it('an ok result with no status field still parses (status is optional — Chrome <109 or unknown)', () => {
    const out = JSON.stringify({ ok: true, html: '<html></html>', finalUrl: 'https://example.com/', mode: 'solved' })
    const parsed = parseSolverOutput(out)
    expect(parsed.ok).toBe(true)
    if (parsed.ok && parsed.mode !== 'warm') expect(parsed.status).toBeUndefined()
  })

  it('every reason in the closed set round-trips', () => {
    for (const reason of HUMAN_SOLVE_REASONS) {
      expect(parseSolverOutput(JSON.stringify({ ok: false, reason }))).toEqual({ ok: false, reason })
    }
  })

  it('an unknown reason string falls back to the generic error result, not a typo carried through', () => {
    const out = JSON.stringify({ ok: false, reason: 'totally-made-up-reason' })
    expect(parseSolverOutput(out)).toEqual({ ok: false, reason: 'error' })
  })
})

describe('parseDialogOutput', () => {
  it('parses an ok result', () => {
    expect(parseDialogOutput('{"ok":true}')).toEqual({ ok: true })
  })

  it('parses a declined/unanswered result', () => {
    expect(parseDialogOutput('{"ok":false,"reason":"declined"}')).toEqual({ ok: false, reason: 'declined' })
    expect(parseDialogOutput('{"ok":false,"reason":"unanswered"}')).toEqual({ ok: false, reason: 'unanswered' })
  })

  it('takes the last parseable line', () => {
    const out = `stderr noise\n{"ok":false,"reason":"declined"}\n${JSON.stringify({ ok: true })}`
    expect(parseDialogOutput(out)).toEqual({ ok: true })
  })

  it('falls back to an error result when nothing parses', () => {
    expect(parseDialogOutput('not json').ok).toBe(false)
  })

  it('an unknown reason string falls back to the generic error result', () => {
    expect(parseDialogOutput('{"ok":false,"reason":"not-a-real-reason"}')).toEqual({ ok: false, reason: 'error' })
  })
})
