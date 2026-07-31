import { tool } from 'ai'
import type { Tool } from 'ai'
import { z } from 'zod'
import { tavily } from '@tavily/core'
import { parseHTML } from 'linkedom'
import { Readability } from '@mozilla/readability'
import { env } from '../env.js'
import { assertPublicHttpUrl } from '../lib/ssrf.js'
import { log } from '../lib/log.js'
import { normalizeText, capText } from './extract.js'
import type { RetrievalLedger } from './ledger.js'

const tvly = tavily({ apiKey: env.TAVILY_API_KEY })

// Normalized pages land ~46k chars / ~11.5k tokens (measured); worker maxContextTokens
// budgets are 40k-80k (see depth.ts), so 80k chars (~20k tokens) is affordable worst-case
// and covers whole pages instead of severing them mid-answer.
const TEXT_CAP = 80_000

async function safeFetch(startUrl: string, jobId = '-', maxHops = 3): Promise<Response> {
  let current = startUrl
  for (let hop = 0; ; hop++) {
    await assertPublicHttpUrl(current) // re-validate EVERY hop (initial + each redirect target)
    const res = await fetch(current, {
      headers: { 'user-agent': 'research-gateway/0.1 (+research bot)' },
      signal: AbortSignal.timeout(10_000),
      redirect: 'manual',
    })
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (!loc) return res
      if (hop >= maxHops) throw new Error('too many redirects')
      const next = new URL(loc, current).toString() // resolve relative redirects
      log('tool.redirect', { jobId, from: current, to: next, status: res.status, hop: hop + 1 })
      current = next
      continue
    }
    return res
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = Tool<any, any>

function buildSearchWebTool(
  defaultSearchDepth: 'basic' | 'advanced',
  ledger: RetrievalLedger,
  jobId = '-',
): AnyTool {
  // Per-run search dedup, mirroring fetchPage's. Tavily credits are a hard-limited resource
  // (exceeding the key's cap fails the search outright), and a re-issued identical query
  // returns identical results — so it burns credit for nothing.
  const searched = new Map<string, unknown>()

  return tool({
    description:
      'Search the web to find candidate sources. Returns an answer summary and result snippets.',
    inputSchema: z.object({
      query: z.string().describe('The search query'),
    }),
    // Search depth is set by the job's research depth, not chosen per-call: a `deep` job
    // must search deeply. Exposing it let the model silently downgrade to basic and halve
    // the sources a deep pass found.
    execute: async ({ query }) => {
      const depth = defaultSearchDepth
      const cacheKey = `${depth}:${query.trim().toLowerCase()}`
      const cached = searched.get(cacheKey)
      if (cached !== undefined) {
        log('tool.searchWeb', { jobId, query, searchDepth: depth, via: 'cache' })
        return cached
      }

      // A search failure must degrade to a tool-visible error, never throw: an uncaught
      // throw here propagates out of the agent loop and kills the whole worker, losing
      // every digest it had gathered. fetchPage/libraryDocs already follow this pattern.
      // `timeout` is SECONDS in @tavily/core (default 60) — not milliseconds.
      try {
        const r = await tvly.search(query, {
          searchDepth: depth,
          maxResults: 5,
          includeAnswer: true,
          timeout: 30,
        })
        log('tool.searchWeb', { jobId, query, searchDepth: depth, results: r.results.length })
        const out = {
          answer: r.answer ?? null,
          // A search result is a candidate, not a consulted source: it is recorded on the
          // ledger as `snippet`, NOT `retrieved`. That distinction is load-bearing — a
          // claim resting on a snippet is capped at `medium` confidence (see ground.ts),
          // while only a page actually read can carry `high`.
          results: r.results.map((x) => {
            const c = x.content ?? ''
            if (c.length > 0) ledger.recordSnippet(x.url)
            return {
              title: x.title,
              url: x.url,
              content: c.length > 1_000 ? c.slice(0, 1_000) + '...' : c,
            }
          }),
        }
        // Only successes are cached — a transient failure must not permanently poison a query.
        searched.set(cacheKey, out)
        return out
      } catch (err) {
        log('tool.searchWeb', { jobId, query, searchDepth: depth, error: String(err) })
        return { error: `search failed: ${String(err)}`, results: [] }
      }
    },
  })
}

function buildFetchPageTool(ledger: RetrievalLedger, jobId = '-'): AnyTool {
  // Per-run dedup: a URL fetched once is not fetched again. Re-fetching wastes network,
  // readability/Tavily-extract work, and budget; the model already has the content above.
  const fetched = new Set<string>()

  return tool({
    description:
      'Fetch the main text content of a URL. Uses Mozilla Readability for clean article extraction; falls back to Tavily Extract if readability fails or returns thin content.',
    inputSchema: z.object({
      url: z.string().describe('The URL to fetch'),
    }),
    execute: async ({ url }) => {
      if (fetched.has(url)) {
        log('tool.fetchPage', { jobId, url, via: 'cache' })
        return { url, text: 'Already fetched earlier in this conversation — reuse the previous result for this URL.' }
      }

      // SSRF guard — refuse any non-public URL before making any fetch
      try {
        await assertPublicHttpUrl(url)
      } catch (err) {
        ledger.recordFailed(url, `refused: ${String(err)}`)
        log('tool.fetchPage', { jobId, url, via: 'refused' })
        return { url, error: `refused: ${String(err)}` }
      }

      // Primary: fetch + linkedom + readability
      let rdReason: 'thin' | 'threw' = 'thin'
      let rdChars = 0
      try {
        const res = await safeFetch(url, jobId)
        if (res.ok) {
          const html = await res.text()
          const { document } = parseHTML(html)
          const article = new Readability(document as unknown as ConstructorParameters<typeof Readability>[0]).parse()
          const raw = article?.textContent?.trim()
          const text = raw ? normalizeText(raw) : raw
          rdChars = text?.length ?? 0
          if (text && text.length >= 200) {
            fetched.add(url)
            ledger.recordRetrieved(url)
            log('tool.fetchPage', { jobId, url, via: 'readability', chars: text.length })
            return { url, text: capText(text, TEXT_CAP) }
          }
        }
      } catch {
        // fetch or linkedom failed — fall through to Tavily Extract
        rdReason = 'threw'
      }

      // Fallback: Tavily Extract
      try {
        const ex = await tvly.extract([url], { extractDepth: 'basic', format: 'markdown', timeout: 30 })
        const result = ex.results[0]
        if (result) {
          fetched.add(url)
          ledger.recordRetrieved(url)
          const text = normalizeText(result.rawContent)
          log('tool.fetchPage', { jobId, url, via: 'tavily-extract', chars: text.length, rdReason, rdChars })
          return { url, text: capText(text, TEXT_CAP) }
        }
        const failed = ex.failedResults[0]
        const reason = failed?.error ?? 'Tavily extract returned no content'
        // Both fetch paths are now exhausted — this URL is unverifiable for this run, and
        // the ledger is what makes it structurally ineligible as a citation source.
        ledger.recordFailed(url, reason)
        log('tool.fetchPage', { jobId, url, via: 'error' })
        return { url, error: reason }
      } catch (err) {
        ledger.recordFailed(url, String(err))
        log('tool.fetchPage', { jobId, url, via: 'error' })
        return { url, error: String(err) }
      }
    },
  })
}

function buildLibraryDocsTool(ledger: RetrievalLedger, jobId = '-'): AnyTool | null {
  if (!env.CONTEXT7_API_KEY) return null

  const apiKey = env.CONTEXT7_API_KEY

  return tool({
    description:
      'Look up curated documentation for a specific library or framework. Use this first for any question about a library API, version, or usage pattern — it is the most accurate source for library-specific questions.',
    inputSchema: z.object({
      library: z.string().describe('The library or framework name, e.g. "elysia" or "ai sdk"'),
      topic: z
        .string()
        .describe('The specific topic or API to look up, e.g. "generateText stopWhen"'),
    }),
    execute: async ({ library, topic }) => {
      try {
        const { Context7 } = await import('@upstash/context7-sdk')
        const c7 = new Context7({ apiKey })

        // searchLibrary(query, libraryName) — resolve the library id
        const libs = await c7.searchLibrary(topic, library)
        const topLib = libs[0]
        if (!topLib) {
          log('tool.libraryDocs', { jobId, library, topic, ok: false })
          return { error: `No library found matching "${library}"` }
        }

        // getContext(query, libraryId) — fetch relevant docs
        const docs = await c7.getContext(topic, topLib.id)
        if (!docs || docs.length === 0) {
          log('tool.libraryDocs', { jobId, library, topic, ok: false })
          return { error: `No documentation found for "${library}" on topic "${topic}"` }
        }

        const text = docs.map((d) => `## ${d.title}\n${d.content}`).join('\n\n')
        // Context7's `source` is a URL *or* an opaque snippet identifier. Only real URLs
        // belong in the report's sources — the rest would be uncheckable by a reader.
        for (const d of docs) {
          if (d.source?.startsWith('http')) ledger.recordRetrieved(d.source)
        }

        log('tool.libraryDocs', { jobId, library, topic, ok: true })
        return { library: topLib.name, libraryId: topLib.id, text: capText(text, TEXT_CAP) }
      } catch (err) {
        log('tool.libraryDocs', { jobId, library, topic, ok: false })
        return { error: String(err) }
      }
    },
  }) as AnyTool
}

export function buildTools(
  ledger: RetrievalLedger,
  jobId: string | undefined,
  searchDepth: 'basic' | 'advanced' = 'basic',
): Record<string, AnyTool> {
  const jid = jobId ?? '-'
  const tools: Record<string, AnyTool> = {
    searchWeb: buildSearchWebTool(searchDepth, ledger, jid),
    fetchPage: buildFetchPageTool(ledger, jid),
  }

  const libraryDocsTool = buildLibraryDocsTool(ledger, jid)
  if (libraryDocsTool) {
    tools['libraryDocs'] = libraryDocsTool
  }

  return tools
}
