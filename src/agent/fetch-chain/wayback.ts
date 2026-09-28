import { log } from '../../lib/log.js'
import { readBoundedText, MAX_BODY_BYTES } from '../../lib/bounded-read.js'
import { readabilityText } from '../html-parse.js'
import { waybackLookupUrl, isArchiveUrl, parseSnapshotDate, archiveBanner, snapshotAgeDays } from '../archive.js'
import { attempt, MIN_USABLE_CHARS } from './context.js'
import type { ChainContext } from './context.js'
import { safeFetch, defaultFetcher } from './net.js'
import type { FetchChainResult } from './types.js'

// ── Step wayback (rescue): the Wayback Machine — only reached once Tavily Extract has
// terminally failed. See fetch-chain.ts's header comment for the measured evidence and the
// two deliberate exclusions.
export async function runWaybackStage(ctx: ChainContext, originalReason: string): Promise<FetchChainResult> {
  // No parse/protocol re-check here: `assertPublicHttpUrl(fetchUrl)` at the top of the chain
  // already threw on anything that is not a parseable, public http(s) URL.
  if (ctx.site.skipToExtract || isArchiveUrl(ctx.fetchUrl)) return ctx.fail(originalReason)

  const tW = performance.now()
  try {
    // A wayback lookup needs a bigger redirect budget than a live fetch, because the archive
    // REPLAYS the origin's own canonicalisation redirects on top of its own snapshot-resolution
    // one. MEASURED on a Cloudy Nights topic URL: 302 (9999 -> snapshot), 301 (origin drops
    // `index.php?`), 302 (re-resolve), 301 (origin lowercases the slug), 302 (re-resolve), 200
    // — five hops, where the chain's default of 3 failed the whole rescue with "too many
    // redirects". Every hop is still re-validated against the SSRF guard inside safeFetch, so
    // this widens the budget, not the trust.
    const { res } = await safeFetch(waybackLookupUrl(ctx.fetchUrl), ctx.jobId, 8, ctx.budget, defaultFetcher, ctx.assertPublicUrl)
    if (!res.ok) {
      const ms = attempt(ctx.attempts, 'wayback', tW, { ok: false, error: `HTTP ${res.status}` })
      ctx.opts.onArchive?.({ ok: false, ms, snapshotAgeDays: null })
      return ctx.fail(originalReason)
    }
    // The same bound as every other network body (bounded-read.ts): an archived copy of a huge
    // page stalls the loop just as hard as the live one, and a body cut at MAX_BODY_BYTES is
    // not a document Readability can read — a miss like any other, never an error out of the
    // chain.
    const bounded = await readBoundedText(res, MAX_BODY_BYTES, (info) =>
      log('tool.fetchPage', { jobId: ctx.jobId, url: ctx.url, via: 'oversized', step: 'wayback', ...info }),
    )
    if (bounded.truncated) {
      const ms = attempt(ctx.attempts, 'wayback', tW, { ok: false, error: `body exceeds ${MAX_BODY_BYTES} byte cap` })
      ctx.opts.onArchive?.({ ok: false, ms, snapshotAgeDays: null })
      return ctx.fail(originalReason)
    }
    // Parsing runs in the same worker pool as step 1 (html-parse.ts) — Readability only, no
    // site adapter, matching what the inline wayback step always did.
    const { text } = await readabilityText(bounded.text, ctx.budget)
    if (!text || text.length < MIN_USABLE_CHARS) {
      const ms = attempt(ctx.attempts, 'wayback', tW, { ok: false, chars: text?.length ?? 0, error: `thin (${text?.length ?? 0} chars)` })
      ctx.opts.onArchive?.({ ok: false, ms, snapshotAgeDays: null })
      return ctx.fail(originalReason)
    }
    const isoDate = parseSnapshotDate({
      memento: res.headers.get('memento-datetime'),
      contentLocation: res.headers.get('content-location') ?? res.url,
    })
    const withBanner = archiveBanner(ctx.url, isoDate) + text
    const ms = attempt(ctx.attempts, 'wayback', tW, { ok: true, chars: withBanner.length })
    ctx.opts.onArchive?.({ ok: true, ms, snapshotAgeDays: snapshotAgeDays(isoDate, new Date()) })
    log('tool.fetchPage', { jobId: ctx.jobId, url: ctx.url, via: 'wayback', chars: withBanner.length, snapshot: isoDate })
    return ctx.done('wayback', withBanner)
  } catch (err) {
    const ms = attempt(ctx.attempts, 'wayback', tW, { ok: false, error: String(err) })
    ctx.opts.onArchive?.({ ok: false, ms, snapshotAgeDays: null })
    return ctx.fail(originalReason)
  }
}
