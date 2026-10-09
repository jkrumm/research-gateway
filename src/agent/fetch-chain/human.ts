import { assertPublicHttpUrl } from '../../lib/ssrf.js'
import { log } from '../../lib/log.js'
import { getActiveSpan } from '../../lib/otel.js'
import { noteJobOutcome } from '../job-outcomes.js'
import { classifyHumanResult } from '../human-outcome.js'
import { classifyBlock, describeBlock } from '../challenge.js'
import { extractText } from '../html-parse.js'
import { looksBinary } from '../response-kind.js'
import { isArchiveUrl } from '../archive.js'
import { attempt, MIN_USABLE_CHARS, NEVER_ABORT } from './context.js'
import type { ChainContext } from './context.js'
import type { FetchChainResult, FetchStep, HumanSolveRequest, HumanSolveResult } from './types.js'

// ── Step human (rescue, before Wayback): a pluggable human-in-the-loop solver. Only tried
// when the caller wired one in (`opts.humanSolve`), the host's policy allows it, AND this
// chain has a reason to believe a human-driven browser succeeds where the automated rungs
// could not (`sawBlock` — a verdict this chain observed, or the origin stage being skipped
// because a prior chain already established the host is blocking). Not for a `skipToExtract`
// URL (YouTube's transcript is not something a human solving a captcha recovers) or an
// already-archived URL (nothing to "solve" on an archive.org replay).
//
// Unlike every other step, this one does NOT run against the chain's own budget — a human
// needs minutes, not the ~90s this chain otherwise allows end to end — so it is given
// `opts.signal` directly (or a signal that never aborts, if the caller passed none). The
// solver owns its own hang guard.
export const humanEligible = (ctx: ChainContext): boolean =>
  ctx.opts.humanSolve !== undefined && ctx.policy.humanSolve && !ctx.policy.skip.includes('human') && ctx.sawBlock && !ctx.site.skipToExtract && !isArchiveUrl(ctx.dialUrl)

// One `human_solve` event on the active fetchPage span plus a per-job tally the root span rolls
// up (`human.<outcome>`): the outcome used to exist only as a `human_solve.*` log line.
function recordHumanOutcome(ctx: ChainContext, result: HumanSolveResult): void {
  const { outcome, escalated, reason } = classifyHumanResult(result)
  getActiveSpan().addEvent('human_solve', { outcome, escalated, host: ctx.host, ...(reason ? { reason } : {}) })
  noteJobOutcome(ctx.jobId, `human.${outcome}`)
}

export async function tryHumanSolve(ctx: ChainContext, reason: string): Promise<FetchChainResult | null> {
  const tH = performance.now()
  // Hoisted so the catch below names the mechanism that actually ran (a throw after a
  // browser-mode result is a 'browser' failure, not a human one).
  let step: FetchStep = 'human'
  let recorded = false
  try {
    const req: HumanSolveRequest = { url: ctx.dialUrl, host: ctx.host, reason, signal: ctx.opts.signal ?? NEVER_ABORT }
    const result = await ctx.opts.humanSolve!(req)
    recordHumanOutcome(ctx, result)
    recorded = true
    if (!result.ok) {
      const ms = attempt(ctx.attempts, 'human', tH, { ok: false, error: result.reason })
      ctx.opts.onHuman?.({ ok: false, ms, reason: result.reason })
      return null
    }
    // 'browser' is a solver-side success with no human ever prompted (human-solver.ts's
    // `runBrowser` relabels the solver's own 'cleared' this way — see fetch-chain/types.ts's
    // `HumanSolveResult` header). Every attempt/log from here on names the mechanism that
    // ACTUALLY produced this page, not the stage that triggered it, so a bench reading
    // `attempts`/`fetch.step` can tell a captcha a human clicked through apart from a page the
    // solver's own Chrome cleared unassisted.
    step = result.mode === 'browser' ? 'browser' : 'human'
    // The solver runs on a different machine (the mini's console session, per human-solve.ts's
    // header) and reports back whatever URL it landed on — an SSRF guard on the ORIGINAL
    // `fetchUrl` says nothing about where a challenge/redirect chain the human clicked through
    // actually ended up. Re-validated here, before this chain treats `result.finalUrl`/`html`
    // as trustworthy, exactly like every redirect hop in `safeFetch` above. A failure here is
    // an ordinary failed human attempt — never `retrieved` — so it falls through to Wayback
    // like any other miss.
    try {
      await assertPublicHttpUrl(result.finalUrl)
    } catch {
      const reason2 = 'unsafe final url'
      const ms = attempt(ctx.attempts, step, tH, { ok: false, error: reason2, blocked: reason2 })
      ctx.opts.onHuman?.({ ok: false, ms, mode: result.mode, reason: reason2 })
      return null
    }
    // A settled page can still BE a 404/410 — bin/solver.ts reads
    // `performance.getEntriesByType('navigation')[0]?.responseStatus` alongside the HTML, so a
    // definitively-missing page (MPB's German "Seite nicht gefunden", 211 chars — thin enough
    // to have cleared MIN_USABLE_CHARS at other steps but not this one) is caught here instead
    // of being recorded as a successful read. Mirrors the origin step's `isDefinitivelyMissing`
    // branch exactly: `fail`, no Wayback rescue afterward — a 404 origin stops the whole chain
    // there too. `result.status` absent/0 means unknown, never treated as missing or an error.
    if (result.status === 404 || result.status === 410) {
      const reason2 = `HTTP ${result.status} — the resource does not exist at this URL`
      const ms = attempt(ctx.attempts, step, tH, { ok: false, error: reason2 })
      ctx.opts.onHuman?.({ ok: false, ms, mode: result.mode, reason: reason2 })
      ctx.ledger.recordMissing(result.finalUrl, reason2)
      log('tool.fetchPage', { jobId: ctx.jobId, url: ctx.url, via: 'missing', status: result.status })
      return ctx.fail(reason2)
    }
    if (result.status !== undefined && result.status >= 400) {
      const reason2 = `HTTP ${result.status}`
      const ms = attempt(ctx.attempts, step, tH, { ok: false, error: reason2 })
      ctx.opts.onHuman?.({ ok: false, ms, mode: result.mode, reason: reason2 })
      return null
    }
    // Checked on the raw HTML, before parsing — same reasoning as the origin/render checks
    // above: a human solver that gave up and just returned the interstitial's markup is a
    // miss, not a success-shaped one.
    const verdict = classifyBlock({ status: 200, headers: {}, bodySample: result.html })
    if (verdict) {
      const reason2 = describeBlock(verdict, 200)
      const ms = attempt(ctx.attempts, step, tH, { ok: false, error: reason2, blocked: reason2 })
      ctx.opts.onHuman?.({ ok: false, ms, mode: result.mode, reason: reason2 })
      return null
    }
    // NOT `budget` — the chain-wide budget is almost always already spent by the time a
    // multi-minute human solve resolves, and parsing against an aborted signal throws
    // immediately, discarding every solve that ever succeeds. This gets its own short-lived
    // signal instead: 30s is generous for parsing HTML already in memory, and `opts.signal`
    // (the job/tool abort, not the chain budget) still cancels it if the caller went away.
    const parseSignal = AbortSignal.any([AbortSignal.timeout(30_000), ctx.opts.signal ?? NEVER_ABORT])
    const { text } = await extractText(ctx.dialUrl, result.html, parseSignal)
    if (!text || text.length < MIN_USABLE_CHARS || looksBinary(text)) {
      let reason2: string
      if (!text) reason2 = 'empty after parse'
      else if (looksBinary(text)) reason2 = 'binary content'
      else reason2 = `thin (${text.length} chars)`
      const ms = attempt(ctx.attempts, step, tH, { ok: false, chars: text?.length ?? 0, error: reason2 })
      ctx.opts.onHuman?.({ ok: false, ms, mode: result.mode, reason: reason2 })
      return null
    }
    const ms = attempt(ctx.attempts, step, tH, { ok: true, chars: text.length })
    ctx.opts.onHuman?.({ ok: true, ms, mode: result.mode })
    // Deliberately NOT hostGate.noteOk(host) — the solver browser getting through (a real
    // Chrome, possibly after a human click) says nothing about whether our plain/impersonated
    // fetches still get blocked; clearing the cooldown here would make the next chain re-probe
    // the origin and spend reputation on a probe this success gives no reason to expect works.
    log('tool.fetchPage', { jobId: ctx.jobId, url: ctx.url, via: step, chars: text.length, mode: result.mode })
    return ctx.done(step, text)
  } catch (err) {
    // A solver call that throws never reached recordHumanOutcome above; count it as abandoned.
    if (!recorded) recordHumanOutcome(ctx, { ok: false, reason: 'error' })
    const ms = attempt(ctx.attempts, step, tH, { ok: false, error: String(err) })
    ctx.opts.onHuman?.({ ok: false, ms, reason: String(err) })
    return null
  }
}
