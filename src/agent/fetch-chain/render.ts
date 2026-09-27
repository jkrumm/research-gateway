import { normalizeText } from '../extract.js'
import { classifyBlock, describeBlock } from '../challenge.js'
import { parseRenderResponse, renderUrl } from '../lightpanda.js'
import { log } from '../../lib/log.js'
import { attempt } from './context.js'
import type { ChainContext } from './context.js'
import type { FetchChainResult } from './types.js'

// ── Step 2: JavaScript rendering, self-hosted ──
// Sits between Readability and Tavily Extract because it handles the one failure Tavily
// cannot — a page whose text simply is not in the HTML — while Tavily remains the better
// fallback for a page that IS static but whose structure Readability could not parse.
// Skipped for a PDF (isPdfBody) exactly like it is skipped for a `skipToExtract` URL — a
// JS renderer has nothing to add to a document that has no DOM. Also skipped outright when
// step 1 hit a DECISIVE block THIS chain — lightpanda cannot pass a JS challenge a plain
// fetch already failed, so spending a render probe on it would only cost more reputation
// for a certain miss (independent of the cooldown-based skip below, which only applies on
// a LATER chain once noteBlocked has actually run).
export async function runRenderStage(ctx: ChainContext): Promise<FetchChainResult | null> {
  const { renderBaseUrl, isPdfBody } = ctx
  const renderSkip = ctx.originDecisiveBlock ? 'origin challenged' : ctx.stageSkipReason('render')
  if (!renderBaseUrl || isPdfBody) return null

  if (renderSkip) {
    attempt(ctx.attempts, 'lightpanda', performance.now(), { ok: false, error: `skipped: ${renderSkip}` })
    log('tool.fetchPage', { jobId: ctx.jobId, url: ctx.url, via: 'render-skipped', reason: renderSkip })
    return null
  }

  const t2 = performance.now()
  try {
    const res = await ctx.hostGate.run(
      ctx.host,
      ctx.policy,
      () =>
        fetch(renderUrl(renderBaseUrl), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: ctx.fetchUrl }),
          // Generous on purpose: the sidecar's own budget is a 20s queue wait plus a 35s
          // render, and it answers a saturated queue with a fast, explicit failure. This
          // only has to outlast that, so a slow render is never cut off by the caller.
          signal: AbortSignal.any([ctx.budget, AbortSignal.timeout(60_000)]),
        }),
      ctx.budget,
    )
    const parsed = parseRenderResponse(res.status, await res.json().catch(() => null))
    if (parsed.ok) {
      const text = normalizeText(parsed.text)
      // The renderer executed the page's JS and still landed on a challenge page — a
      // real browser without a human solving it gets the same interstitial a plain fetch
      // does, so this is a miss like any other, not a success-shaped failure.
      const verdict = classifyBlock({ status: 200, headers: {}, bodySample: text })
      if (verdict) {
        const reason = describeBlock(verdict, 200)
        const ms = attempt(ctx.attempts, 'lightpanda', t2, { ok: false, error: reason, blocked: reason })
        ctx.opts.onRender?.({ ok: false, ms })
        ctx.hostGate.noteBlocked(ctx.host, { reason: verdict.signal, kind: 'challenge' })
        ctx.markBlocked()
        log('tool.fetchPage', { jobId: ctx.jobId, url: ctx.url, via: 'lightpanda', error: reason })
      } else {
        const ms = attempt(ctx.attempts, 'lightpanda', t2, { ok: true, chars: text.length })
        ctx.opts.onRender?.({ ok: true, ms })
        log('tool.fetchPage', { jobId: ctx.jobId, url: ctx.url, via: 'lightpanda', chars: text.length, rdReason: ctx.rdReason, rdChars: ctx.rdChars })
        return ctx.done('lightpanda', text)
      }
    } else {
      const ms = attempt(ctx.attempts, 'lightpanda', t2, { ok: false, error: parsed.error })
      ctx.opts.onRender?.({ ok: false, ms })
      log('tool.fetchPage', { jobId: ctx.jobId, url: ctx.url, via: 'lightpanda', error: parsed.error })
    }
  } catch (err) {
    // Never fatal — the sidecar being down must degrade this step, not the job.
    const ms = attempt(ctx.attempts, 'lightpanda', t2, { ok: false, error: String(err) })
    ctx.opts.onRender?.({ ok: false, ms })
    log('tool.fetchPage', { jobId: ctx.jobId, url: ctx.url, via: 'lightpanda', error: String(err) })
  }
  return null
}
