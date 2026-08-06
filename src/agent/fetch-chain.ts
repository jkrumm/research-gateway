import { tavily } from '@tavily/core'
import { parseHTML } from 'linkedom'
import { Readability } from '@mozilla/readability'
import { env } from '../env.js'
import { assertPublicHttpUrl } from '../lib/ssrf.js'
import { log } from '../lib/log.js'
import { normalizeText, capText, TEXT_CAP } from './extract.js'
import { resolveSite } from './site-adapters.js'
import { isRawContentType, isDefinitivelyMissing } from './response-kind.js'
import { parseRenderResponse, renderUrl } from './lightpanda.js'
import type { RetrievalLedger } from './ledger.js'

// The page-fetch chain, extracted from the `fetchPage` tool so it can be RUN AND MEASURED
// without an LLM in the loop.
//
// The chain is normally steps 1 -> 2 -> 3 (plain fetch/site-adapter/Readability, lightpanda,
// Tavily Extract). One class of URL skips straight to step 3: when `resolveSite` (via a site
// adapter's `plan()`) marks `skipToExtract`, steps 1-2 are never attempted at all. YouTube is
// the case that forced this — steps 1-2 don't fail on a `watch?v=` URL, they SUCCEED with
// ~1,731 chars of video-player chrome ("Tap to unmute"), which clears every quality check in
// this file and gets recorded as `retrieved`. Only step 3 reads the actual transcript
// (measured 22k-218k chars). See site-adapters.ts's header comment for the full numbers.
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
// Contract, unchanged from the tool it came from and load-bearing:
//   - It NEVER throws. Every step is a fallback inside a fallback chain; the sidecar being
//     down or Tavily rejecting must degrade this call, not kill the worker (which would lose
//     every digest that worker had gathered).
//   - The ledger always hears about the ORIGINAL url, never the rewritten one, because the
//     original is what a citation will name (site-adapters.test.ts guards this).

export type FetchStep = 'raw' | 'site-adapter' | 'readability' | 'lightpanda' | 'tavily-extract'

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
  /**
   * Called for EVERY lightpanda attempt this chain makes — success, parse-failure, and
   * thrown error alike — so renders are countable even though none of those three outcomes
   * terminates the chain the same way. Not called when `env.LIGHTPANDA_URL` is unset, since
   * then no attempt was made at all.
   */
  onRender?: (r: { ok: boolean; ms: number }) => void
}

const tvly = tavily({ apiKey: env.TAVILY_API_KEY })

// Readability output shorter than this is treated as a miss rather than an answer. It is
// the boundary between "this page has content" and "this page has a cookie banner".
const MIN_USABLE_CHARS = 200

// Whether a response is verbatim-answer or document-to-extract, and whether a status means
// "absent" rather than "not to you" — both live in response-kind.ts so they are unit-tested.

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

/**
 * Records one attempt and returns its elapsed ms, so a step reads as a single expression AND
 * callers that also need to report the timing elsewhere (onRender, below) use the exact same
 * number rather than a second `performance.now()` call that could disagree with it.
 */
function attempt(
  attempts: FetchAttempt[],
  step: FetchStep,
  startedAt: number,
  outcome: { ok: boolean; chars?: number; error?: string },
): number {
  const ms = Math.round(performance.now() - startedAt)
  attempts.push({ step, ...outcome, ms })
  return ms
}

export async function runFetchChain(url: string, opts: FetchChainOptions): Promise<FetchChainResult> {
  const { ledger, onTavilyCredits, onRender } = opts
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
    // When an adapter rewrote the address, BOTH forms name the page that was genuinely read,
    // so both are recorded. This is not a loophole in the "ledger hears the ORIGINAL url"
    // contract — it is the same principle `normalizeUrl` already encodes ("the model
    // routinely cites the same page with a fragment, a trailing slash, or a `www.` prefix
    // that the fetch did not use — those are the SAME page and must match, or honest
    // citations get dropped"). normalizeUrl keeps the path and query, so it canNOT collapse
    // these pairs by itself: `youtu.be/<id>` vs `youtube.com/watch?v=<id>` and
    // `reddit.com/r/x` vs `old.reddit.com/r/x` are different keys to it. Without this, a
    // worker that fetched one form and cited the other has its finding stripped at the
    // worker boundary — the exact silent failure mode HANDOVER.md's rule 4 was written for.
    if (fetchUrl !== url) ledger.recordRetrieved(fetchUrl)
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

  // Steps 1-2 record no attempts at all when skipped, rather than a fabricated "didn't run"
  // entry — `attempts` stays an honest record of what actually happened, and a caller reading
  // it back (fetch-bench.ts, `tool.fetchPage` logs) sees exactly one `tavily-extract` entry for
  // these URLs, not two dishonest failures in front of it.
  let rdReason: 'thin' | 'threw' = 'thin'
  let rdChars = 0

  if (site.skipToExtract) {
    log('tool.fetchPage', { jobId, url, via: 'skip-to-extract', fetchUrl })
  } else {
    // ── Step 1: plain fetch + linkedom + Readability (or a site adapter's own reader) ──
    const t1 = performance.now()
    let step1: FetchStep = 'readability'
    try {
      const res = await safeFetch(fetchUrl, jobId)

      // A definitively-absent resource stops here. Every remaining step would ask the same
      // origin the same question and be told the same thing, and the last of them bills for it.
      if (isDefinitivelyMissing(res.status)) {
        const reason = `HTTP ${res.status} — the resource does not exist at this URL`
        attempt(attempts, 'readability', t1, { ok: false, error: reason })
        ledger.recordFailed(url, reason)
        log('tool.fetchPage', { jobId, url, via: 'missing', status: res.status })
        return fail(reason)
      }

      if (!res.ok) {
        attempt(attempts, step1, t1, { ok: false, error: `HTTP ${res.status}` })
      } else {
        // Read the body ONCE — a Response body is a stream and cannot be consumed twice, so
        // the content-type branch and the HTML branch have to share this.
        const body = await res.text()
        const contentType = res.headers.get('content-type')

        // A non-HTML body IS the answer — hand it back verbatim rather than asking an HTML
        // parser to find an article in it.
        if (isRawContentType(contentType)) {
          const raw = normalizeText(body)
          if (raw.length > 0) {
            attempt(attempts, 'raw', t1, { ok: true, chars: raw.length })
            log('tool.fetchPage', { jobId, url, via: 'raw', chars: raw.length, contentType })
            return done('raw', raw)
          }
          // An empty body is a miss like any other — fall through to the rendering steps, which
          // is the right answer for a URL that serves an empty JSON body to a bot and a real
          // page to a browser.
          attempt(attempts, 'raw', t1, { ok: false, chars: 0, error: 'empty body' })
        } else {
          const { document } = parseHTML(body)
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
        }
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
          const ms = attempt(attempts, 'lightpanda', t2, { ok: true, chars: text.length })
          onRender?.({ ok: true, ms })
          log('tool.fetchPage', { jobId, url, via: 'lightpanda', chars: text.length, rdReason, rdChars })
          return done('lightpanda', text)
        }
        const ms = attempt(attempts, 'lightpanda', t2, { ok: false, error: parsed.error })
        onRender?.({ ok: false, ms })
        log('tool.fetchPage', { jobId, url, via: 'lightpanda', error: parsed.error })
      } catch (err) {
        // Never fatal — the sidecar being down must degrade this step, not the job.
        const ms = attempt(attempts, 'lightpanda', t2, { ok: false, error: String(err) })
        onRender?.({ ok: false, ms })
        log('tool.fetchPage', { jobId, url, via: 'lightpanda', error: String(err) })
      }
    }
  }

  // ── Step 3: Tavily Extract — the only paid step, and therefore the last ──
  const t3 = performance.now()
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
      attempt(attempts, 'tavily-extract', t3, { ok: true, chars: text.length })
      // `rdReason`/`rdChars` describe why step 1 fell through, so they are meaningless when
      // step 1 never ran — logging `thin (0 chars)` for a skipped step would read as
      // "Readability found nothing" rather than "Readability was never asked", which is the
      // same dishonesty the `attempts` array is deliberately kept free of.
      log('tool.fetchPage', {
        jobId,
        url,
        via: 'tavily-extract',
        chars: text.length,
        ...(site.skipToExtract ? { skipped: true } : { rdReason, rdChars }),
      })
      return done('tavily-extract', text)
    }
    const failed = ex.failedResults[0]
    const reason = failed?.error ?? 'Tavily extract returned no content'
    // Every fetch path is now exhausted — this URL is unverifiable for this run, and the
    // ledger is what makes it structurally ineligible as a citation source.
    attempt(attempts, 'tavily-extract', t3, { ok: false, error: reason })
    ledger.recordFailed(url, reason)
    log('tool.fetchPage', { jobId, url, via: 'error' })
    return fail(reason)
  } catch (err) {
    attempt(attempts, 'tavily-extract', t3, { ok: false, error: String(err) })
    ledger.recordFailed(url, String(err))
    log('tool.fetchPage', { jobId, url, via: 'error' })
    return fail(String(err))
  }
}
