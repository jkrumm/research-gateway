import type { ChainContext } from './context.js'
import type { FetchChainResult } from './types.js'
import { humanEligible, tryHumanSolve } from './human.js'
import { runWaybackStage } from './wayback.js'

// Tries the human stage (when eligible) before falling back to Wayback — the ordering
// fetch-chain.ts's header comment describes. `budgetMs` being spent does not skip this call
// (the human stage ignores the chain budget by design); it only affects whether the Wayback
// rescue afterward gets a real attempt or fails fast on its own `safeFetch(..., budget)` call.
export async function runRescue(ctx: ChainContext, reason: string): Promise<FetchChainResult> {
  if (humanEligible(ctx)) {
    const humanResult = await tryHumanSolve(ctx, reason)
    if (humanResult) return humanResult
  }
  return await runWaybackStage(ctx, reason)
}
