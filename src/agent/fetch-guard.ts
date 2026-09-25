// Pure helpers around the fetchPage tool — env-free, so they are unit-tested directly (the tool
// itself lives in tools.ts, which imports env).
//
// Measured 2026-09-25 on five deep/standard Wild Rift jobs: nearly every worker ended without
// calling submit_digest. A step fans out 4-6 fetchPage calls, a page returns up to TEXT_CAP
// (80k chars), and the next step's input jumps from ~10k to 100k+ tokens in one hop — past
// `maxContextTokens`, which salvage.ts's one-step-ahead predictor cannot see coming. The context
// guard then stops the loop and the one-shot salvage replays the over-full transcript; about
// half of those salvages returned no digest or a digest with ZERO findings. One job's wrchina
// pages were read in full (15,429 chars) and the digest carrying them was discarded — the
// report then called them "JS shells". The fix is not a better predictor: bound the page text a
// worker can take in, and tell the model when it is spent, so it submits on its own terms.

import type { FetchAttempt } from './fetch-chain.js'
import type { LedgerSnapshot, RetrievalLedger } from './ledger.js'

// Page text is the one input that grows without bound; everything else in a worker's context
// (instructions, the sub-question, search results, its own reasoning) is roughly fixed. ~4
// chars per token for web prose, and a bit over half the context left for page text.
const PAGE_CHARS_PER_CONTEXT_TOKEN = 2.2
// Below this a page read is a fragment not worth the round trip — the budget counts as spent.
const MIN_USEFUL_CHARS = 2_000

export const PAGE_BUDGET_SPENT =
  "This worker's page-text budget is spent — no more pages can be read. Call submit_digest now with the findings the pages you already read support; put anything still open in openGaps."

export interface PageBudget {
  /** False once the budget is spent — check BEFORE starting a fetch, so no fetch runs for nothing. */
  hasRoom(): boolean
  /** Charge a page's text against the budget and return what the model gets: whole, or cut at
   * the remaining budget with an explicit note — or null when the budget is already spent
   * (parallel fetches all pass `hasRoom` before any of them is charged). A null page was NOT
   * read and must not be recorded as retrieved (see `commitRead`). */
  take(text: string): string | null
}

// CJK text runs ~1 token per character against ~0.25 for Latin prose, so a character-only
// budget would let a Chinese page overflow the context it exists to protect.
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/g
const CJK_EXTRA_WEIGHT = 3

function weightOf(text: string): number {
  return text.length + (text.match(CJK_RE)?.length ?? 0) * CJK_EXTRA_WEIGHT
}

export function createPageBudget(maxContextTokens: number): PageBudget {
  let remaining = Math.floor(maxContextTokens * PAGE_CHARS_PER_CONTEXT_TOKEN)
  return {
    hasRoom: () => remaining >= MIN_USEFUL_CHARS,
    take(text) {
      if (remaining < MIN_USEFUL_CHARS) return null
      const weight = weightOf(text)
      if (weight <= remaining) {
        remaining -= weight
        return text
      }
      const cut = Math.floor((text.length * remaining) / weight)
      remaining = 0
      return `${text.slice(0, cut)}\n\n[cut at ${cut} of ${text.length} characters: this worker's page-text budget ran out on this page. Anything further down was NOT read — do not treat its absence as evidence. Submit your digest next.]`
    },
  }
}

/** Move one fetch's staged ledger records into the worker's ledger. `retrieved` is committed
 * only when the model actually received the page text: a page the budget withheld was fetched
 * but never read, and the grounding invariant is about what the MODEL read. A failure or a
 * 404 is committed either way — those are facts about the URL, not about this worker. */
export function commitRead(args: { staged: LedgerSnapshot; into: RetrievalLedger; delivered: boolean }): void {
  const { staged, into, delivered } = args
  if (delivered) for (const url of staged.retrieved) into.recordRetrieved(url)
  for (const m of staged.missing) into.recordMissing(m.url, m.reason)
  for (const url of staged.snippet) into.recordSnippet(url)
  for (const f of staged.failed) into.recordFailed(f.url, f.reason)
}

/** The whole chain's failure, step by step — "readability: HTTP 403 · lightpanda: HTTP 403 ·
 * tavily-extract: Failed to fetch url" — instead of only the last step's generic error, which
 * is all the ledger (and so the report) used to see. */
export function describeAttempts(attempts: readonly FetchAttempt[], fallback: string): string {
  const failed = attempts.filter((a) => !a.ok && a.error)
  if (failed.length === 0) return fallback
  return failed.map((a) => `${a.step}: ${(a.error ?? '').slice(0, 120)}`).join(' · ')
}

// Reader/CORS proxies the model invents to route around a page it could not read. Measured
// 2026-09-25: ~31 of one job's 42 failed fetches were model-made proxy URLs (allorigins,
// corsproxy, codetabs, cors.lol, thingproxy — none reachable), and r.jina.ai / microlink
// copies sneaked a page past its own robots rules. The chain already renders JavaScript
// (lightpanda) and falls back to Tavily Extract and Wayback, so a proxy adds nothing but a
// second, unaccountable copy of the page.
const PROXY_HOSTS = [
  'r.jina.ai',
  's.jina.ai',
  'api.microlink.io',
  'microlink.io',
  'api.allorigins.win',
  'allorigins.win',
  'corsproxy.io',
  'api.codetabs.com',
  'api.cors.lol',
  'cors.lol',
  'thingproxy.freeboard.io',
  'cors-anywhere.herokuapp.com',
  'proxy.cors.sh',
]

export function isProxyUrl(url: string): boolean {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  return PROXY_HOSTS.some((p) => host === p || host.endsWith(`.${p}`))
}

export const PROXY_REFUSED =
  'Proxy and reader-service URLs are not fetched. Fetch the original page URL directly — the fetch chain already renders JavaScript and falls back to an extraction service and the Wayback Machine. If the original could not be read, report it as unverified.'
