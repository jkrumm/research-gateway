import { normalizeText } from '../extract.js'
import { fetchYoutubeTranscript } from '../ytdlp.js'
import { describeAttempts } from '../fetch-guard.js'
import { log } from '../../lib/log.js'
import { attempt } from './context.js'
import type { ChainContext } from './context.js'
import { hostOf } from './net.js'
import { keptSparseResult, runRescue } from './rescue.js'
import type { FetchChainResult } from './types.js'

// ── Step yt-dlp: the real read for a video URL, tried before the paid fallback ──
// Reached only for a `skipToExtract` URL — see fetch-chain.ts's header comment for why
// steps 1-2 are never attempted at all for one of these.
export async function runYtdlpStage(ctx: ChainContext): Promise<FetchChainResult | null> {
  log('tool.fetchPage', { jobId: ctx.jobId, url: ctx.url, via: 'skip-to-extract', fetchUrl: ctx.fetchUrl })

  const tY = performance.now()
  // The spawn takes no AbortSignal, so check the budget before starting it. Distinguished
  // from a genuine timeout below — `budget` folds in `opts.signal`, so a CANCELLED job would
  // otherwise be misreported as "budget exhausted".
  if (ctx.budget.aborted) return ctx.fail(ctx.opts.signal?.aborted ? 'cancelled' : ctx.budgetReason)
  const ytResult = await fetchYoutubeTranscript(ctx.dialUrl, { jobId: ctx.jobId })
  if (ytResult) {
    const ms = attempt(ctx.attempts, 'yt-dlp', tY, { ok: true, chars: ytResult.chars })
    ctx.opts.onYtdlp?.({ ok: true, ms })
    log('tool.fetchPage', {
      jobId: ctx.jobId,
      url: ctx.url,
      via: 'yt-dlp',
      chars: ytResult.chars,
      source: ytResult.source,
      lang: ytResult.lang,
    })
    return ctx.done('yt-dlp', ytResult.text)
  }
  const ms = attempt(ctx.attempts, 'yt-dlp', tY, { ok: false, error: 'no transcript available' })
  ctx.opts.onYtdlp?.({ ok: false, ms })
  log('tool.fetchPage', { jobId: ctx.jobId, url: ctx.url, via: 'yt-dlp', error: 'no transcript available — falling back to tavily-extract' })
  // Falls through to Step 3 (Tavily Extract) below — it still recovers a video's
  // description/metadata even when yt-dlp found no transcript.
  return null
}

// ── Step 3: Tavily Extract — the only paid step, and therefore the last ──
export async function runTavilyStage(ctx: ChainContext): Promise<FetchChainResult> {
  // Tavily Extract terminally failed: record it, commit `failed` to the ledger with the whole
  // chain's story (not Tavily's generic last word — see describeAttempts), then the rescues.
  const tavilyFailed = async (reason: string): Promise<FetchChainResult> => {
    attempt(ctx.attempts, 'tavily-extract', t3, { ok: false, error: reason })
    // A kept sparse origin read is a success, so no `failed` ledger record precedes it.
    const sparse = keptSparseResult(ctx)
    if (sparse) return sparse
    const chain = describeAttempts(ctx.attempts, reason)
    ctx.ledger.recordFailed(ctx.url, chain)
    log('tool.fetchPage', { jobId: ctx.jobId, url: ctx.url, via: 'error', reason: chain, host: hostOf(ctx.dialUrl) })
    return await runRescue(ctx, chain)
  }

  const t3 = performance.now()
  // A CANCELLED job (`opts.signal` itself aborted) fails fast here rather than falling into
  // human/Wayback — `budget` folds the job signal in on top of the timeout, so without this
  // check a cancelled job would be misreported as "budget exhausted" AND still spend a human
  // solve / Wayback rescue on a chain nobody is waiting for anymore. Same early-return shape as
  // any other terminal failure: no ledger write, no further steps.
  if (ctx.opts.signal?.aborted) return ctx.fail('cancelled')
  // Tavily's SDK takes a seconds `timeout`, not an AbortSignal, so the budget cannot abort an
  // in-flight extract: check it first (a paid call must not fire after the budget is spent)
  // and clamp the SDK's own timeout to whatever the budget has left.
  if (ctx.budget.aborted) return await runRescue(ctx, ctx.budgetReason)
  const remainingMs = ctx.budgetMs - (performance.now() - ctx.chainStartedAt)
  const tavilyTimeoutSec = Math.max(1, Math.min(30, Math.ceil(remainingMs / 1000)))
  try {
    const ex = await ctx.tavilyExtract([ctx.dialUrl], {
      extractDepth: 'basic',
      format: 'markdown',
      timeout: tavilyTimeoutSec,
      includeUsage: true,
    })
    // The call resolved — Tavily billed it — regardless of whether this URL ends up in
    // `results` or `failedResults` below. This is what makes a failed-fetch count
    // correctly: a failed *extraction* still billed the *call* that attempted it.
    ctx.opts.onTavilyCredits?.(ex.usage?.credits ?? 0)
    const result = ex.results[0]
    if (result) {
      const text = normalizeText(result.rawContent)
      attempt(ctx.attempts, 'tavily-extract', t3, { ok: true, chars: text.length })
      // `rdReason`/`rdChars` describe why step 1 fell through, so they are meaningless when
      // step 1 never ran — logging `thin (0 chars)` for a skipped step would read as
      // "Readability found nothing" rather than "Readability was never asked", which is the
      // same dishonesty the `attempts` array is deliberately kept free of.
      log('tool.fetchPage', {
        jobId: ctx.jobId,
        url: ctx.url,
        via: 'tavily-extract',
        chars: text.length,
        ...(ctx.site.skipToExtract ? { skipped: true } : { rdReason: ctx.rdReason, rdChars: ctx.rdChars }),
      })
      return ctx.done('tavily-extract', text)
    }
    const failed = ex.failedResults[0]
    const reason = failed?.error ?? 'Tavily extract returned no content'
    // Every step of the paid path is now exhausted — the Wayback Machine gets one rescue
    // attempt below before this URL is unverifiable for this run, and the ledger is what
    // makes it structurally ineligible as a citation source.
    return await tavilyFailed(reason)
  } catch (err) {
    return await tavilyFailed(String(err))
  }
}
