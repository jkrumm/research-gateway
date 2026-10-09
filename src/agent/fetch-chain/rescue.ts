import type { ChainContext } from './context.js'
import type { FetchChainResult } from './types.js'
import { log } from '../../lib/log.js'
import { humanEligible, tryHumanSolve } from './human.js'
import { runWaybackStage } from './wayback.js'

// The live sliver origin.ts held back as sparse, delivered through the normal `ctx.done` path
// (so the ledger registers exactly the text returned) — or null when there is none. A sparse
// page is not a block: it must never reach human solve, and a fresh sliver beats Wayback.
export function keptSparseResult(ctx: ChainContext): FetchChainResult | null {
  const sparse = ctx.sparseOrigin
  if (!sparse) return null
  log('tool.fetchPage', { jobId: ctx.jobId, url: ctx.url, via: sparse.step, chars: sparse.text.length, sparseFallback: true })
  return ctx.done(sparse.step, sparse.text, sparse.dialledUrl)
}

// Tries the human stage (when eligible) before falling back to Wayback — the ordering
// fetch-chain.ts's header comment describes. `budgetMs` being spent does not skip this call
// (the human stage ignores the chain budget by design); it only affects whether the Wayback
// rescue afterward gets a real attempt or fails fast on its own `safeFetch(..., budget)` call.
export async function runRescue(ctx: ChainContext, reason: string): Promise<FetchChainResult> {
  const sparse = keptSparseResult(ctx)
  if (sparse) return sparse
  if (humanEligible(ctx)) {
    const humanResult = await tryHumanSolve(ctx, reason)
    if (humanResult) return humanResult
  }
  return await runWaybackStage(ctx, reason)
}
