import { tavily } from '@tavily/core'
import { parseHTML } from 'linkedom'
import { Readability } from '@mozilla/readability'
import { env } from '../env.js'
import { assertPublicHttpUrl } from '../lib/ssrf.js'
import { log } from '../lib/log.js'
import { normalizeText, capText, TEXT_CAP } from './extract.js'
import { resolveSite } from './site-adapters.js'
import { parseJinaResponse, jinaUrl } from './jina.js'
import { parseRenderResponse, renderUrl } from './lightpanda.js'
import type { RetrievalLedger } from './ledger.js'

// The page-fetch chain, extracted from the `fetchPage` tool so it can be RUN AND MEASURED
// without an LLM in the loop.
//
// Why it lives on its own: the chain has five steps that each recover a different failure,
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
// Contract, unchanged from the tool it came from and load-bearing:
//   - It NEVER throws. Every step is a fallback inside a fallback chain; the sidecar being
//     down, Jina 402ing or Tavily rejecting must degrade this call, not kill the worker
//     (which would lose every digest that worker had gathered).
//   - The ledger always hears about the ORIGINAL url, never the rewritten one, because the
//     original is what a citation will name (site-adapters.test.ts guards this).

export type FetchStep = 'site-adapter' | 'readability' | 'lightpanda' | 'jina' | 'tavily-extract'

export interface FetchAttempt {
  step: FetchStep
  ok: boolean
  /** Characters of usable text this step produced. Present on success, and on a `thin` miss. */
  chars?: number
  /** Why the step did not terminate the chain. Absent when `ok`. */
  error?: string
  ms: number
}

export interface FetchChainResult {
  /** The URL asked for — what the ledger recorded and what a citation will name. */
  url: string
  /** The URL actually dialled. Differs from `url` only when a site adapter rewrites it. */
  fetchUrl: string
  /** The step that terminated the chain, or null if every step failed. */
  via: FetchStep | null
  /** Capped text, or null on total failure. */
  text: string | null
  error: string | null
  attempts: FetchAttempt[]
}

export interface FetchChainOptions {
  ledger: RetrievalLedger
  jobId?: string
  /**
   * Called with the credits Tavily billed for an Extract call — including a call that
   * returned no content, because Tavily bills the attempt, not the outcome.
   */
  onTavilyCredits?: (credits: number) => void
}

const tvly = tavily({ apiKey: env.TAVILY_API_KEY })

// Readability output shorter than this is treated as a miss rather than an answer. It is
// the boundary between "this page has content" and "this page has a cookie banner".
const MIN_USABLE_CHARS = 200

// Follows redirects BY HAND so every hop can be re-validated against the SSRF guard. A
// single `fetch` with `redirect: 'follow'` would validate the first address and then follow
// a 302 to anywhere — including the metadata service.
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

/** Records one attempt and returns it, so a step reads as a single expression. */
function attempt(
  attempts: FetchAttempt[],
  step: FetchStep,
  startedAt: number,
  outcome: { ok: boolean; chars?: number; error?: string },
): void {
  attempts.push({ step, ...outcome, ms: Math.round(performance.now() - startedAt) })
}

export async function runFetchChain(url: string, opts: FetchChainOptions): Promise<FetchChainResult> {
  const { ledger, onTavilyCredits } = opts
  const jobId = opts.jobId ?? '-'
  const attempts: FetchAttempt[] = []

  // Some hosts need a different address, a different reader, or both (site-adapters.ts).
  // Everything below fetches `fetchUrl`; everything the ledger and the caller see stays
  // `url`, because that is what a citation will name.
  const site = resolveSite(url)
  const fetchUrl = site.fetchUrl
  if (fetchUrl !== url) log('tool.fetchPage', { jobId, url, via: 'rewrite', fetchUrl })

  const fail = (error: string): FetchChainResult => ({ url, fetchUrl, via: null, text: null, error, attempts })
  const done = (via: FetchStep, text: string): FetchChainResult => {
    ledger.recordRetrieved(url)
    return { url, fetchUrl, via, text: capText(text, TEXT_CAP), error: null, attempts }
  }

  // SSRF guard — refuse any non-public URL before making any fetch. Guards the address
  // actually dialled, not the one asked for.
  try {
    await assertPublicHttpUrl(fetchUrl)
  } catch (err) {
    ledger.recordFailed(url, `refused: ${String(err)}`)
    log('tool.fetchPage', { jobId, url, via: 'refused' })
    return fail(`refused: ${String(err)}`)
  }

  // ── Step 1: plain fetch + linkedom + Readability (or a site adapter's own reader) ──
  let rdReason: 'thin' | 'threw' = 'thin'
  let rdChars = 0
  const t1 = performance.now()
  let step1: FetchStep = 'readability'
  try {
    const res = await safeFetch(fetchUrl, jobId)
    if (res.ok) {
      const html = await res.text()
      const { document } = parseHTML(html)
      // A site adapter reads its own markup; anything else, and any adapter that does not
      // recognise what it got, falls through to Readability unchanged.
      const adapted = site.extract ? site.extract(document as never) : null
      if (adapted) step1 = 'site-adapter'
      const article = adapted
        ? null
        : new Readability(document as unknown as ConstructorParameters<typeof Readability>[0]).parse()
      const raw = adapted ?? article?.textContent?.trim()
      const text = raw ? normalizeText(raw) : raw
      rdChars = text?.length ?? 0
      if (text && text.length >= MIN_USABLE_CHARS) {
        attempt(attempts, step1, t1, { ok: true, chars: text.length })
        log('tool.fetchPage', { jobId, url, via: step1, chars: text.length })
        return done(step1, text)
      }
      attempt(attempts, step1, t1, { ok: false, chars: rdChars, error: `thin (${rdChars} chars)` })
    } else {
      attempt(attempts, step1, t1, { ok: false, error: `HTTP ${res.status}` })
    }
  } catch (err) {
    // fetch or linkedom failed — fall through to the rendering steps.
    rdReason = 'threw'
    attempt(attempts, step1, t1, { ok: false, error: String(err) })
  }

  // ── Step 2: JavaScript rendering, self-hosted ──
  // Sits between Readability and Tavily Extract because it handles the one failure Tavily
  // cannot — a page whose text simply is not in the HTML — while Tavily remains the better
  // fallback for a page that IS static but whose structure Readability could not parse.
  if (env.LIGHTPANDA_URL) {
    const t2 = performance.now()
    try {
      const res = await fetch(renderUrl(env.LIGHTPANDA_URL), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: fetchUrl }),
        // Generous on purpose: the sidecar's own budget is a 20s queue wait plus a 35s
        // render, and it answers a saturated queue with a fast, explicit failure. This only
        // has to outlast that, so a slow render is never cut off by the caller.
        signal: AbortSignal.timeout(60_000),
      })
      const parsed = parseRenderResponse(res.status, await res.json().catch(() => null))
      if (parsed.ok) {
        const text = normalizeText(parsed.text)
        attempt(attempts, 'lightpanda', t2, { ok: true, chars: text.length })
        log('tool.fetchPage', { jobId, url, via: 'lightpanda', chars: text.length, rdReason, rdChars })
        return done('lightpanda', text)
      }
      attempt(attempts, 'lightpanda', t2, { ok: false, error: parsed.error })
      log('tool.fetchPage', { jobId, url, via: 'lightpanda', error: parsed.error })
    } catch (err) {
      // Never fatal — the sidecar being down must degrade this step, not the job.
      attempt(attempts, 'lightpanda', t2, { ok: false, error: String(err) })
      log('tool.fetchPage', { jobId, url, via: 'lightpanda', error: String(err) })
    }
  }

  // ── Step 3: JavaScript rendering, third-party ──
  if (env.JINA_ENABLED) {
    const t3 = performance.now()
    try {
      // Force the full browser engine. Jina otherwise picks between a lightweight fetcher
      // and headless Chrome, and the lightweight one returns exactly the shell this step
      // exists to get past.
      const headers: Record<string, string> = { 'x-engine': 'browser' }
      if (env.JINA_API_KEY) headers['Authorization'] = `Bearer ${env.JINA_API_KEY}`

      let res = await fetch(jinaUrl(fetchUrl), { headers, signal: AbortSignal.timeout(30_000) })

      // A key on an account with no balance returns 402 on EVERY request, which would
      // silently disable this whole step while anonymous access still works. Measured: a
      // real key 402'd (`InsufficientBalanceError`) where no key returned 200. Retry once
      // without it, and say so loudly — a dead key should be visible, not papered over.
      if ((res.status === 402 || res.status === 401) && env.JINA_API_KEY) {
        log('tool.fetchPage', {
          jobId,
          url,
          via: 'jina',
          error: `key rejected (HTTP ${res.status}) — retrying anonymously; recharge or unset JINA_API_KEY`,
        })
        delete headers['Authorization']
        res = await fetch(jinaUrl(fetchUrl), { headers, signal: AbortSignal.timeout(30_000) })
      }

      if (res.ok) {
        const parsed = parseJinaResponse(await res.text())
        if (parsed.ok) {
          const text = normalizeText(parsed.text)
          attempt(attempts, 'jina', t3, { ok: true, chars: text.length })
          log('tool.fetchPage', { jobId, url, via: 'jina', chars: text.length, rdReason, rdChars })
          return done('jina', text)
        }
        attempt(attempts, 'jina', t3, { ok: false, error: parsed.error })
        log('tool.fetchPage', { jobId, url, via: 'jina', error: parsed.error })
      } else {
        attempt(attempts, 'jina', t3, { ok: false, error: `HTTP ${res.status}` })
        log('tool.fetchPage', { jobId, url, via: 'jina', error: `HTTP ${res.status}` })
      }
    } catch (err) {
      // Never fatal — this is a fallback inside a fallback chain.
      attempt(attempts, 'jina', t3, { ok: false, error: String(err) })
      log('tool.fetchPage', { jobId, url, via: 'jina', error: String(err) })
    }
  }

  // ── Step 4: Tavily Extract — the only paid step, and therefore the last ──
  const t4 = performance.now()
  try {
    const ex = await tvly.extract([fetchUrl], {
      extractDepth: 'basic',
      format: 'markdown',
      timeout: 30,
      includeUsage: true,
    })
    // The call resolved — Tavily billed it — regardless of whether this URL ends up in
    // `results` or `failedResults` below. This is what makes a failed-fetch count
    // correctly: a failed *extraction* still billed the *call* that attempted it.
    onTavilyCredits?.(ex.usage?.credits ?? 0)
    const result = ex.results[0]
    if (result) {
      const text = normalizeText(result.rawContent)
      attempt(attempts, 'tavily-extract', t4, { ok: true, chars: text.length })
      log('tool.fetchPage', { jobId, url, via: 'tavily-extract', chars: text.length, rdReason, rdChars })
      return done('tavily-extract', text)
    }
    const failed = ex.failedResults[0]
    const reason = failed?.error ?? 'Tavily extract returned no content'
    // Every fetch path is now exhausted — this URL is unverifiable for this run, and the
    // ledger is what makes it structurally ineligible as a citation source.
    attempt(attempts, 'tavily-extract', t4, { ok: false, error: reason })
    ledger.recordFailed(url, reason)
    log('tool.fetchPage', { jobId, url, via: 'error' })
    return fail(reason)
  } catch (err) {
    attempt(attempts, 'tavily-extract', t4, { ok: false, error: String(err) })
    ledger.recordFailed(url, String(err))
    log('tool.fetchPage', { jobId, url, via: 'error' })
    return fail(String(err))
  }
}
