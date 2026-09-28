import { log } from '../lib/log.js'
import { createContext } from './fetch-chain/context.js'
import { runOriginStage } from './fetch-chain/origin.js'
import { runRenderStage } from './fetch-chain/render.js'
import { runYtdlpStage, runTavilyStage } from './fetch-chain/extract.js'
import type { FetchChainOptions, FetchChainResult } from './fetch-chain/types.js'

export { FETCH_STEPS } from './fetch-chain/types.js'
export type { FetchAttempt, FetchChainResult, FetchChainOptions, HumanSolveRequest, HumanSolveResult, HumanSolve } from './fetch-chain/types.js'
export { hostOf } from './fetch-chain/net.js'

// The page-fetch chain, extracted from the `fetchPage` tool so it can be RUN AND MEASURED
// without an LLM in the loop.
//
// The chain has two shapes. For most URLs it is steps 1 -> 2 -> 3 (plain fetch/site-adapter/
// Readability, lightpanda, Tavily Extract). One class of URL skips straight to a fourth,
// YouTube-only step: when `resolveSite` (via a site adapter's `plan()`) marks `skipToExtract`,
// steps 1-2 are never attempted at all. YouTube is the case that forced this — steps 1-2
// don't fail on a `watch?v=` URL, they SUCCEED with ~1,731 chars of video-player chrome ("Tap
// to unmute"), which clears every quality check in this file and gets recorded as `retrieved`.
// See site-adapters.ts's header comment for the full numbers.
//
// That fourth step is yt-dlp (agent/ytdlp.ts), tried FIRST: one `-J` metadata extraction plus
// one direct GET of the caption track it names, both spawned/fetched locally rather than
// billed to Tavily. MEASURED 2026-08-06 against three videos (see ytdlp.ts's header): 3.6-4.2s
// end to end, 20k-80k chars. Tavily Extract remains the fallback for when yt-dlp fails (no
// caption track, a rate limit, a binary error) — it still recovers a video's description and
// metadata even when a transcript is unavailable, which is why the chain still ends in step 3
// for this URL class too rather than failing outright.
//
// Why it lives on its own: the chain has four steps that each recover a different failure,
// and until now the only record of which one fired was a log line inside a job. That made
// every fetch-level question ("does the renderer earn its container?", "what would adding a
// step buy?") answerable only by running the full job benchmark — 15 runs, ~90 minutes,
// ~$1.35 — which then could not resolve the answer anyway, because job-level pagesFailed
// moved 10.8% → 11.3% at cv 1.00. Fetch effects sit under the job-level noise floor.
//
// So the chain now returns a per-step trace alongside the text. `scripts/fetch-bench.ts`
// replays a fixed corpus through the deployed chain and prints which step terminated and
// with how many characters, in minutes and deterministically. The trace is additive: the
// log lines are byte-identical to what they were inside the tool, so anything that read
// them still reads them.
//
// A fifth step, the Wayback Machine, runs ONLY after step 3 (Tavily Extract) has already
// terminally failed — it is a rescue for origins that refuse this crawler outright, not a
// general alternative to fetching live. MEASURED 2026-08-17: a dpreview forum thread 403s a
// plain fetch, 403s lightpanda, AND fails Tavily Extract ("Failed to fetch url") — every step
// above fails. The same URL through `https://web.archive.org/web/9999/<url>` (see archive.ts)
// 302s to a 2023 snapshot that reads with plain Readability: 20,076 chars, 0 Tavily credits.
// It is skipped for `skipToExtract` URLs (a YouTube watch page's archived copy is player
// chrome, not a transcript — the failure Wayback exists to rescue does not apply there) and
// for URLs that are already archive.org addresses (no recursion). It does NOT run ahead of the
// `isDefinitivelyMissing` early return — a 404 origin still stops before Tavily as it does
// today; recovering dead links from the archive is a deliberate follow-up, not this change.
// A page recovered this way is recorded `retrieved`, not a new ledger tier, because it
// genuinely was read; staleness travels in-band via `archiveBanner` instead.
//
// Contract, unchanged from the tool it came from and load-bearing:
//   - It NEVER throws. Every step is a fallback inside a fallback chain; the sidecar being
//     down or Tavily rejecting must degrade this call, not kill the worker (which would lose
//     every digest that worker had gathered).
//   - The ledger always hears about the ORIGINAL url, never the rewritten one, because the
//     original is what a citation will name (site-adapters.test.ts guards this).
//
// The chain itself is split across fetch-chain/ — a shared, explicit `ChainContext`
// (fetch-chain/context.ts) threads identity/budget/ports/flags through one function per
// stage (origin.ts, render.ts, extract.ts's yt-dlp/Tavily steps, human.ts, wayback.ts,
// rescue.ts). This file is only the readable top-level sequence: which stage runs after
// which, and the handful of conditionals that decide skipping.

export async function runFetchChain(url: string, opts: FetchChainOptions): Promise<FetchChainResult> {
  const ctx = createContext(url, opts)

  // SSRF guard — refuse any non-public URL before making any fetch. Guards the address
  // actually dialled, not the one asked for.
  try {
    await ctx.assertPublicUrl(ctx.fetchUrl)
  } catch (err) {
    ctx.ledger.recordFailed(url, `refused: ${String(err)}`)
    log('tool.fetchPage', { jobId: ctx.jobId, url, via: 'refused' })
    return ctx.fail(`refused: ${String(err)}`)
  }

  if (ctx.site.skipToExtract) {
    const ytResult = await runYtdlpStage(ctx)
    if (ytResult) return ytResult
  } else {
    const originResult = await runOriginStage(ctx)
    if (originResult) return originResult
    const renderResult = await runRenderStage(ctx)
    if (renderResult) return renderResult
  }

  return await runTavilyStage(ctx)
}
