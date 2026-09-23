import { tavily } from '@tavily/core'
import { env } from '../env.js'
import { assertPublicHttpUrl } from '../lib/ssrf.js'
import { log } from '../lib/log.js'
import { getActiveSpan } from '../lib/otel.js'
import { normalizeText, capText, TEXT_CAP } from './extract.js'
import { resolveSite } from './site-adapters.js'
import { isRawContentType, isDefinitivelyMissing, MAX_BODY_BYTES, parseInputOverflow } from './response-kind.js'
import type { BoundedBody } from './response-kind.js'
import { getParsePool } from './parse-pool.js'
import { parseRenderResponse, renderUrl } from './lightpanda.js'
import { fetchYoutubeTranscript } from './ytdlp.js'
import { waybackLookupUrl, isArchiveUrl, parseSnapshotDate, archiveBanner, snapshotAgeDays } from './archive.js'
import type { RetrievalLedger } from './ledger.js'

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

export type FetchStep = 'raw' | 'site-adapter' | 'readability' | 'lightpanda' | 'yt-dlp' | 'tavily-extract' | 'wayback'

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
   * terminates the chain the same way. Not called when the render step is off, since then no
   * attempt was made at all.
   */
  onRender?: (r: { ok: boolean; ms: number }) => void
  /**
   * Base URL of the rendering sidecar; falsy takes the render step out of the chain. Defaults
   * to `env.LIGHTPANDA_URL`, which is what production wants — the parameter exists so which
   * steps run is an ARGUMENT rather than ambient state. `env.ts` parses `process.env` once at
   * first import, so a test that assigns the variable and then asserts on the waterfall was
   * asserting on module load order; on the CI runner that ordering differed and the chain fell
   * through to the network. Injecting it removes the coupling instead of re-timing it.
   */
  renderBaseUrl?: string | undefined
  /**
   * Called for EVERY yt-dlp transcript attempt this chain makes (skipToExtract URLs only) —
   * success and failure alike, mirroring `onRender` above exactly. Not called for non-video
   * URLs, since no attempt was made at all.
   */
  onYtdlp?: (r: { ok: boolean; ms: number }) => void
  /**
   * Called for EVERY Wayback rescue attempt `tryWayback` makes — a non-ok HTTP status, a
   * thin-content miss, a thrown error, and success alike — mirroring `onRender`/`onYtdlp`
   * above exactly. NOT called when the step was skipped entirely (a `skipToExtract` URL, an
   * already-archived URL, or the chain terminating before Tavily Extract even fails), since
   * then no archive request was ever made. `snapshotAgeDays` is null on every failure path and
   * on a success whose snapshot date didn't parse — only a successful rescue with a readable
   * `Memento-Datetime`/path date carries a number.
   */
  onArchive?: (r: { ok: boolean; ms: number; snapshotAgeDays: number | null }) => void
}

const tvly = tavily({ apiKey: env.TAVILY_API_KEY })

// Readability output shorter than this is treated as a miss rather than an answer. It is
// the boundary between "this page has content" and "this page has a cookie banner".
const MIN_USABLE_CHARS = 200

// Whether a response is verbatim-answer or document-to-extract, and whether a status means
// "absent" rather than "not to you" — both live in response-kind.ts so they are unit-tested.

// Reads a response body through a byte-counting reader, so nothing unbounded is ever
// downloaded or allocated in one piece.
//
// `await res.text()` was the hole `PARSE_INPUT_CAP` could not close. It materializes the
// ENTIRE body before anything in this file can look at it, and the UTF-8 decode runs on the
// event loop this one Bun process shares with every job's heartbeat, the idle watchdog and
// the HTTP listener — so a host that answers with gigabytes (adversarial, or an accidentally
// huge artifact) was downloaded and allocated in full before a single byte was compared
// against the cap. The cap bounded the synchronous parse and nothing else. That is the stall
// shape behind the 2026-09-20 reaped-on-read on a LIVE process (lib/loop-watch.ts).
//
// Reading it HERE is what makes every call site safe by construction: step 1 and the Wayback
// rescue both went through `res.text()`, and the next one would have had to remember a guard.
//
// Returns raw BYTES, not decoded text: decoding happens once at each call site, only for the
// bodies that need it as text. This keeps the reader reusable for a body a future step must
// hand somewhere else unmodified (e.g. a binary format), where decoding as UTF-8 here would
// have corrupted it before that step ever saw it.
//
// Over the cap is NOT an error, it is a miss like any other — the caller falls through to its
// next step. `truncated` distinguishes a body that was cut from one read to the end.
//
// `maxBytes` defaults to MAX_BODY_BYTES; a future caller with a different (larger) cap for a
// different body shape can pass its own.
async function readBoundedBody(res: Response, jobId: string, maxBytes = MAX_BODY_BYTES): Promise<BoundedBody> {
  const body = res.body
  // A 204/304 or a HEAD has no body at all: `res.text()` returned '' for these, and so does this.
  if (!body) return { bytes: new Uint8Array(0), truncated: false }

  const declared = Number(res.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) {
    // Cheap early-out: the origin declared its size up front, so not one byte is pulled.
    await body.cancel().catch(() => {})
    log('tool.fetchPage', { jobId, via: 'oversized', declaredBytes: declared, capBytes: maxBytes })
    return { bytes: new Uint8Array(0), truncated: true }
  }

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      bytes += value.byteLength
      if (bytes > maxBytes) {
        // CANCEL rather than drain: the remainder is never read off the socket or retained.
        // The counted bytes are what tells an operator this response was cut.
        await reader.cancel().catch(() => {})
        log('tool.fetchPage', { jobId, via: 'oversized', readBytes: bytes, capBytes: maxBytes })
        return { bytes: concatChunks(chunks, bytes), truncated: true }
      }
    }
    return { bytes: concatChunks(chunks, bytes), truncated: false }
  } catch (err) {
    // A body that errors mid-read (a dropped connection) must release the reader too, and the
    // error still has to reach the caller's catch — a truncated body is not a substitute.
    await reader.cancel().catch(() => {})
    throw err
  }
}

/** Joins chunks read off a stream into one array, allocated exactly once. */
function concatChunks(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  const out = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

// Follows redirects BY HAND so every hop can be re-validated against the SSRF guard. A
// single `fetch` with `redirect: 'follow'` would validate the first address and then follow
// a 302 to anywhere — including the metadata service.
//
// Returns the final URL alongside the response: with `redirect: 'manual'` the response is
// the REDIRECT TARGET's, and callers that attribute anything to the requested URL (the
// ledger's missing tier) must attribute it to where the answer actually came from. The body
// is deliberately NOT read here — only the caller knows whether this status is one it will
// consume (a 200 to parse) or discard (a 4xx/5xx nothing uses), so only it should pay for the
// download. An intermediate redirect hop's body is never consumed by anything, so it is
// cancelled here rather than left to whatever the runtime does with a dangling stream.
async function safeFetch(startUrl: string, jobId = '-', maxHops = 3): Promise<{ res: Response; finalUrl: string }> {
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
      if (!loc) return { res, finalUrl: current }
      if (hop >= maxHops) throw new Error('too many redirects')
      // This hop's body is never read by anything — release the connection now rather than
      // leaving it open until GC gets to it.
      await res.body?.cancel().catch(() => {})
      const next = new URL(loc, current).toString() // resolve relative redirects
      log('tool.redirect', { jobId, from: current, to: next, status: res.status, hop: hop + 1 })
      current = next
      continue
    }
    return { res, finalUrl: current }
  }
}

// Lowercase host of a URL, or '' if it does not parse — used by the `tool.fetchPage` error
// log (Part 2 below) and by the `fetch.host` span attribute, so recurring blocked hosts are
// greppable AND groupable. That aggregation is how site-adapters.ts picks its next entry
// (see that file's header).
export function hostOf(u: string): string {
  try {
    return new URL(u).hostname.toLowerCase()
  } catch {
    return ''
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
  const { ledger, onTavilyCredits, onRender, onYtdlp, onArchive } = opts
  const jobId = opts.jobId ?? '-'
  const renderBaseUrl = opts.renderBaseUrl ?? env.LIGHTPANDA_URL
  const attempts: FetchAttempt[] = []

  // Some hosts need a different address, a different reader, or both (site-adapters.ts).
  // Everything below fetches `fetchUrl`; everything the ledger and the caller see stays
  // `url`, because that is what a citation will name.
  const site = resolveSite(url)
  const fetchUrl = site.fetchUrl
  if (fetchUrl !== url) {
    log('tool.fetchPage', { jobId, url, via: 'rewrite', fetchUrl })
    getActiveSpan().addEvent('fetch.rewrite', { url, fetchUrl })
  }

  // The waterfall is reported as EVENTS on whatever span is active — the caller's
  // `tool.fetchPage` span — rather than as a span of its own: one chain run is one fetch, and
  // its steps are a timeline you want to read inside it. Emitted from the two terminal
  // helpers below so every return path carries exactly the record `attempts` holds, once.
  // `getActiveSpan()` is a no-op span when there is none, so fetch-bench.ts and the tests pay
  // nothing for this.
  let eventsEmitted = false
  const emitAttempts = (): void => {
    if (eventsEmitted) return
    eventsEmitted = true
    const span = getActiveSpan()
    for (const a of attempts) {
      span.addEvent('fetch.step', {
        step: a.step,
        ok: a.ok,
        chars: a.chars,
        error: a.error?.slice(0, 200),
        ms: a.ms,
      })
    }
  }

  const fail = (error: string): FetchChainResult => {
    emitAttempts()
    return { url, fetchUrl, via: null, text: null, error, attempts }
  }
  const done = (via: FetchStep, text: string): FetchChainResult => {
    emitAttempts()
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
  // Why step 1 handed the page to the renderers instead of answering with it. Carried into
  // every rendering attempt's log line, because "lightpanda was asked" means nothing without
  // knowing what Readability had been given.
  type Step1Miss = 'thin' | 'threw' | 'oversized'
  let rdReason: Step1Miss = 'thin'
  let rdChars = 0

  if (site.skipToExtract) {
    log('tool.fetchPage', { jobId, url, via: 'skip-to-extract', fetchUrl })

    // ── Step yt-dlp: the real read for a video URL, tried before the paid fallback ──
    const tY = performance.now()
    const ytResult = await fetchYoutubeTranscript(fetchUrl, { jobId })
    if (ytResult) {
      const ms = attempt(attempts, 'yt-dlp', tY, { ok: true, chars: ytResult.chars })
      onYtdlp?.({ ok: true, ms })
      log('tool.fetchPage', {
        jobId,
        url,
        via: 'yt-dlp',
        chars: ytResult.chars,
        source: ytResult.source,
        lang: ytResult.lang,
      })
      return done('yt-dlp', ytResult.text)
    }
    const ms = attempt(attempts, 'yt-dlp', tY, { ok: false, error: 'no transcript available' })
    onYtdlp?.({ ok: false, ms })
    log('tool.fetchPage', { jobId, url, via: 'yt-dlp', error: 'no transcript available — falling back to tavily-extract' })
    // Falls through to Step 3 (Tavily Extract) below — it still recovers a video's
    // description/metadata even when yt-dlp found no transcript.
  } else {
    // ── Step 1: plain fetch + linkedom + Readability (or a site adapter's own reader) ──
    const t1 = performance.now()
    let step1: FetchStep = 'readability'
    try {
      // A definitively-absent resource stops here. Every remaining step would ask the same
      // origin the same question and be told the same thing, and the last of them bills for it.
      // Recorded as `missing`, not `failed`: the origin ANSWERED — 404/410 is definitive
      // evidence that the resource does not exist at this URL, and the only kind of
      // negative claim the ledger ever backs. See ground.ts.
      //
      // Recorded against safeFetch's FINAL url, never the requested one: with redirects
      // followed by hand, `res` is the redirect target's response, and a redirect to a 404
      // says the TARGET does not exist — the requested URL's fate is unknown, and a
      // fabricated missing record there would wrongly demote or drop claims about it.
      const { res, finalUrl } = await safeFetch(fetchUrl, jobId)
      if (isDefinitivelyMissing(res.status)) {
        const reason = `HTTP ${res.status} — the resource does not exist at this URL`
        await res.body?.cancel().catch(() => {})
        attempt(attempts, 'readability', t1, { ok: false, error: reason })
        ledger.recordMissing(finalUrl, reason)
        log('tool.fetchPage', { jobId, url, via: 'missing', status: res.status })
        return fail(reason)
      }

      if (!res.ok) {
        // Nothing downstream ever reads a non-ok body — cancel it rather than downloading a
        // response no step will use.
        await res.body?.cancel().catch(() => {})
        attempt(attempts, step1, t1, { ok: false, error: `HTTP ${res.status}` })
      } else {
        // Only NOW does anything download the body — the one status this chain actually
        // consumes. The content-type branch and the HTML branch have to share the same
        // decoded string, so it is decoded once here.
        const contentType = res.headers.get('content-type')
        const bounded = await readBoundedBody(res, jobId)

        // A non-HTML body IS the answer — hand it back verbatim rather than asking an HTML
        // parser to find an article in it. It gets no cap of its own: `normalizeText`'s passes
        // are linear and bounded now by the byte reader, and `done` caps what a worker actually
        // receives at TEXT_CAP with the notice that says so. Cutting it here would discard the
        // payload of the very URL class this branch exists for — a large JSON or CSV dump is
        // exactly what a model cites, and its first 2M characters are not waste.
        if (isRawContentType(contentType)) {
          const raw = normalizeText(new TextDecoder().decode(bounded.bytes))
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
          const bodyText = new TextDecoder().decode(bounded.bytes)
          const oversized = parseInputOverflow(bodyText, bounded.truncated)
          if (oversized) {
            // A miss like every other, never an error: the chain falls through to the
            // renderers, and lightpanda — a real browser in its own process and memory budget
            // — is exactly the right reader for a page too heavy to parse here. `rdChars`
            // stays 0 the way the `threw` path leaves it: no extraction ran, and the shape of
            // the problem is in the attempt's error string.
            rdReason = 'oversized'
            attempt(attempts, step1, t1, { ok: false, chars: bodyText.length, error: oversized })
          } else {
            // The parse itself — linkedom + a site adapter or Readability — runs on
            // parse-pool.ts's Worker, not this event loop. `PARSE_INPUT_CAP` still bounds
            // what is handed to it; this is what keeps a bounded-but-heavy document from
            // stalling heartbeats/the idle watchdog/the listener the way an inline parse did
            // (see loop-watch.ts). A hang, a crash, or a thrown parse error all reject the
            // same as the pre-pool inline `throw` did, so they fall to the outer `catch`
            // below exactly as before.
            try {
              const parsed = await getParsePool().parse({ html: bodyText, url })
              if (parsed.via === 'site-adapter') step1 = 'site-adapter'
              const text = parsed.text
              rdChars = text?.length ?? 0
              if (text && text.length >= MIN_USABLE_CHARS) {
                attempt(attempts, step1, t1, { ok: true, chars: text.length })
                log('tool.fetchPage', { jobId, url, via: step1, chars: text.length })
                return done(step1, text)
              }
              attempt(attempts, step1, t1, { ok: false, chars: rdChars, error: `thin (${rdChars} chars)` })
            } catch (parseErr) {
              rdReason = 'threw'
              attempt(attempts, step1, t1, { ok: false, error: String(parseErr) })
            }
          }
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
    if (renderBaseUrl) {
      const t2 = performance.now()
      try {
        const res = await fetch(renderUrl(renderBaseUrl), {
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

  // ── Step wayback (rescue): the Wayback Machine — only reached once Tavily Extract has
  // terminally failed. See the header comment for the measured evidence and the two
  // deliberate exclusions.
  const tryWayback = async (originalReason: string): Promise<FetchChainResult> => {
    // No parse/protocol re-check here: `assertPublicHttpUrl(fetchUrl)` at the top of the chain
    // already threw on anything that is not a parseable, public http(s) URL.
    if (site.skipToExtract || isArchiveUrl(fetchUrl)) return fail(originalReason)

    const tW = performance.now()
    try {
      // A wayback lookup needs a bigger redirect budget than a live fetch, because the archive
      // REPLAYS the origin's own canonicalisation redirects on top of its own snapshot-resolution
      // one. MEASURED on a Cloudy Nights topic URL: 302 (9999 -> snapshot), 301 (origin drops
      // `index.php?`), 302 (re-resolve), 301 (origin lowercases the slug), 302 (re-resolve), 200
      // — five hops, where the chain's default of 3 failed the whole rescue with "too many
      // redirects". Every hop is still re-validated against the SSRF guard inside safeFetch, so
      // this widens the budget, not the trust.
      const { res } = await safeFetch(waybackLookupUrl(fetchUrl), jobId, 8)
      if (!res.ok) {
        // Nothing downstream reads a non-ok wayback response either.
        await res.body?.cancel().catch(() => {})
        const ms = attempt(attempts, 'wayback', tW, { ok: false, error: `HTTP ${res.status}` })
        onArchive?.({ ok: false, ms, snapshotAgeDays: null })
        return fail(originalReason)
      }
      // The same two bounds as step 1, and for the same reason: an archived copy of a huge
      // page stalls the loop just as hard as the live one, and a body that was CUT at
      // MAX_BODY_BYTES is not a document Readability can read. Wayback is the last step, so
      // this degrades to `fail` like every other miss here — never an error out of the chain.
      const bounded = await readBoundedBody(res, jobId)
      const bodyText = new TextDecoder().decode(bounded.bytes)
      const oversized = parseInputOverflow(bodyText, bounded.truncated)
      if (oversized) {
        const ms = attempt(attempts, 'wayback', tW, { ok: false, chars: bodyText.length, error: oversized })
        onArchive?.({ ok: false, ms, snapshotAgeDays: null })
        return fail(originalReason)
      }
      // Off the main thread via parse-pool.ts, same as step 1 — an archived copy of a huge
      // page is just as capable of stalling the loop as the live one would be. A hang, a
      // crash or a thrown parse error here is caught by this `try`'s own `catch` below,
      // exactly like the inline `parseHTML`/`Readability` throw it replaces.
      // The archive URL, not the original: no site adapter reads Wayback's wrapped markup, so
      // this stays Readability-only exactly as the inline parse was.
      const parsed = await getParsePool().parse({ html: bodyText, url: res.url || waybackLookupUrl(fetchUrl) })
      const text = parsed.text
      if (!text || text.length < MIN_USABLE_CHARS) {
        const ms = attempt(attempts, 'wayback', tW, { ok: false, chars: text?.length ?? 0, error: `thin (${text?.length ?? 0} chars)` })
        onArchive?.({ ok: false, ms, snapshotAgeDays: null })
        return fail(originalReason)
      }
      const isoDate = parseSnapshotDate({
        memento: res.headers.get('memento-datetime'),
        contentLocation: res.headers.get('content-location') ?? res.url,
      })
      const withBanner = archiveBanner(url, isoDate) + text
      const ms = attempt(attempts, 'wayback', tW, { ok: true, chars: withBanner.length })
      onArchive?.({ ok: true, ms, snapshotAgeDays: snapshotAgeDays(isoDate, new Date()) })
      log('tool.fetchPage', { jobId, url, via: 'wayback', chars: withBanner.length, snapshot: isoDate })
      return done('wayback', withBanner)
    } catch (err) {
      const ms = attempt(attempts, 'wayback', tW, { ok: false, error: String(err) })
      onArchive?.({ ok: false, ms, snapshotAgeDays: null })
      return fail(originalReason)
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
    // Every step of the paid path is now exhausted — the Wayback Machine gets one rescue
    // attempt below before this URL is unverifiable for this run, and the ledger is what
    // makes it structurally ineligible as a citation source.
    attempt(attempts, 'tavily-extract', t3, { ok: false, error: reason })
    ledger.recordFailed(url, reason)
    log('tool.fetchPage', { jobId, url, via: 'error', reason, host: hostOf(fetchUrl) })
    return await tryWayback(reason)
  } catch (err) {
    const reason = String(err)
    attempt(attempts, 'tavily-extract', t3, { ok: false, error: reason })
    ledger.recordFailed(url, reason)
    log('tool.fetchPage', { jobId, url, via: 'error', reason, host: hostOf(fetchUrl) })
    return await tryWayback(reason)
  }
}
