// Fetch boundary for the Karakeep half of `brainNotes`. Mirrors brain-search.ts's contract:
// NEVER throw — an uncaught throw kills the worker and every digest it gathered — and degrade to
// an empty result plus a log line on any failure. The pure parsing/ranking lives in karakeep.ts,
// so this module owns only the network.
//
// Every outbound call carries a plain HTTP hang guard (10s), not an agent budget: the
// agent-limits rule covers LLM workers, not a bounded REST call to a non-LLM API.

import { env } from '../env.js'
import { log } from '../lib/log.js'
import {
  buildKarakeepSearchUrl,
  parseBookmarkSearchResponse,
  parseHighlightsResponse,
  rankAndBuildBookmarks,
} from './karakeep.js'
import type { KarakeepBookmarkResult } from './karakeep.js'

const TIMEOUT_MS = 10_000
// Search a few more than we return, so ranking has something to choose between; fetch
// highlights only for the bookmarks that actually make the cut.
const SEARCH_LIMIT = 10
const MAX_RESULTS = 3

export type KarakeepSearchResult =
  | { ok: true; bookmarks: KarakeepBookmarkResult[] }
  | { ok: false; error: string }

type JsonResult = { ok: true; data: unknown } | { ok: false; error: string }

async function getJson(url: string, jobId: string, context: string): Promise<JsonResult> {
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${env.KARAKEEP_API_KEY}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) {
      const error = `karakeep ${context} HTTP ${res.status}`
      log('tool.brainNotes', { jobId, karakeep: true, context, ok: false, error })
      return { ok: false, error }
    }
    return { ok: true, data: await res.json() }
  } catch (err) {
    const error = `karakeep ${context} failed: ${String(err)}`
    log('tool.brainNotes', { jobId, karakeep: true, context, ok: false, error })
    return { ok: false, error }
  }
}

async function fetchHighlights(baseUrl: string, id: string, jobId: string): Promise<string[]> {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/v1/bookmarks/${encodeURIComponent(id)}/highlights`
  const res = await getJson(url, jobId, 'highlights')
  return res.ok ? parseHighlightsResponse(res.data) : []
}

/** Full-text search over the owner's Karakeep bookmarks, folded into `brainNotes`. Returns the
 * top-ranked bookmarks (each under its preview URL) with highlights attached, or an error
 * result — never a throw. Unconfigured is an error result, so the caller can treat it as "this
 * half is absent" rather than a failure. */
export async function searchKarakeep(query: string, terms: string[], jobId = '-'): Promise<KarakeepSearchResult> {
  if (!env.KARAKEEP_URL || !env.KARAKEEP_API_KEY) {
    return { ok: false, error: 'karakeep is not configured on this host' }
  }

  const searchUrl = buildKarakeepSearchUrl(env.KARAKEEP_URL, query, SEARCH_LIMIT)
  const res = await getJson(searchUrl, jobId, 'search')
  if (!res.ok) return { ok: false, error: res.error }

  const raw = parseBookmarkSearchResponse(res.data)
  const ranked = rankAndBuildBookmarks({ bookmarks: raw, terms, baseUrl: env.KARAKEEP_URL, maxResults: MAX_RESULTS })

  const highlightsById = new Map<string, string[]>()
  for (const bookmark of ranked) {
    highlightsById.set(bookmark.id, await fetchHighlights(env.KARAKEEP_URL, bookmark.id, jobId))
  }

  log('tool.brainNotes', { jobId, karakeep: true, query, results: ranked.length, ok: true })
  return {
    ok: true,
    bookmarks: ranked.map((bookmark) => ({ ...bookmark, highlights: highlightsById.get(bookmark.id) ?? [] })),
  }
}
