import { normalizeText } from '../extract.js'
import { extractText } from '../html-parse.js'
import { isRawContentType, isDefinitivelyMissing, isPdf, looksBinary } from '../response-kind.js'
import { extractPdfText } from '../pdf.js'
import { MAX_PDF_BYTES, pdfTruncationNotice } from '../pdf-extract.js'
import { readBoundedBytesByCap, readCappedText, MAX_BODY_BYTES } from '../../lib/bounded-read.js'
import { classifyBlock, describeBlock, isJavaScriptShell, type BlockVerdict } from '../challenge.js'
import { parseRetryAfter } from '../host-gate.js'
import { log } from '../../lib/log.js'
import { attempt, MIN_USABLE_CHARS, BLOCK_CHECK_STATUSES, IMPERSONATE_ELIGIBLE_STATUSES, BLOCK_SAMPLE_BYTES } from './context.js'
import type { ChainContext } from './context.js'
import { safeFetch, defaultFetcher } from './net.js'
import type { Fetcher } from './net.js'
import type { FetchChainResult, FetchStep } from './types.js'

// Whether a response is verbatim-answer or document-to-extract, and whether a status means
// "absent" rather than "not to you" — both live in response-kind.ts so they are unit-tested.

type BlockOutcome = { status: number; decisive: boolean; markerless: boolean } | null

// The bookkeeping every decisive/corroborating block verdict needs, shared by the two call
// sites that used to duplicate it verbatim: the non-2xx status branch below (retryAfterSec is
// real there) and the 200-challenge branch in `readOriginHtml` (no Retry-After header to read
// off a successful response, so it stays undefined there — `noteBlocked`'s param is optional).
// `originDecisiveBlock` only follows `verdict.decisive` — never hardcoded `true` — because a
// corroborating-only verdict at a already-suspicious status (401/403/429/503) IS non-decisive,
// while at a 2xx `classifyBlock` can only ever return a decisive verdict at all (challenge.ts's
// `BLOCKED_STATUSES` gate on the corroborating branch excludes 2xx), so the two call sites
// agree without either one special-casing it.
function recordBlockVerdict(
  ctx: ChainContext,
  verdict: BlockVerdict,
  status: number,
  step: FetchStep,
  t: number,
  retryAfterSec?: number,
): string {
  const reason = describeBlock(verdict, status)
  attempt(ctx.attempts, step, t, { ok: false, error: reason, blocked: reason })
  ctx.hostGate.noteBlocked(ctx.host, { retryAfterSec, reason: verdict.signal, kind: 'challenge' })
  ctx.markBlocked()
  ctx.markDecisiveOriginBlock(verdict.decisive)
  return reason
}

// The non-2xx branch of step 1: status check, a bounded body sample, `classifyBlock`, and the
// three-way decisive/rate-limit/markerless split — split out of `runOrigin` so that pipeline
// reads as one sequence rather than a status handler nested four levels inside it. Returns the
// `block` half of `runOrigin`'s result union directly (this branch of the origin pipeline never
// terminates the chain itself — only `readOriginBody` below does).
async function classifyOriginBlock(ctx: ChainContext, res: Response, step: FetchStep, t: number): Promise<BlockOutcome> {
  if (!BLOCK_CHECK_STATUSES.has(res.status)) {
    attempt(ctx.attempts, step, t, { ok: false, error: `HTTP ${res.status}` })
    return null
  }
  const bodySample = await readCappedText(res.body, BLOCK_SAMPLE_BYTES).catch(() => '')
  const retryAfterSec = parseRetryAfter(res.headers.get('retry-after'), Date.now())
  const verdict = classifyBlock({ status: res.status, headers: res.headers, bodySample })
  if (verdict) {
    recordBlockVerdict(ctx, verdict, res.status, step, t, retryAfterSec)
    return { status: res.status, decisive: verdict.decisive, markerless: false }
  }
  if (res.status === 429) {
    // A 429 with no vendor fingerprint is still a rate limit, not a generic error — the
    // origin told us to slow down even though classifyBlock found no WAF marker. This sets a
    // cooldown (waiting IS the right response to a rate limit) but never `sawBlock` — a human
    // solving a captcha does nothing for "you're going too fast", and the call site below
    // never even offers this status to the impersonation rung.
    const reason = 'blocked: rate limited (HTTP 429)'
    attempt(ctx.attempts, step, t, { ok: false, error: reason, blocked: reason })
    ctx.hostGate.noteBlocked(ctx.host, { retryAfterSec, reason: 'rate limited (HTTP 429, no vendor signature)', kind: 'rate-limit' })
    return { status: res.status, decisive: false, markerless: false }
  }
  // A 401/403/503 with NO vendor fingerprint — an ordinary "forbidden"/"unauthorized" page
  // carries no evidence of anti-bot blocking on its own, so unlike the verdict branch above
  // this does NOT call `noteBlocked` or mark a block here. It still unlocks the impersonation
  // rung below (a second, differently-fingerprinted origin hit is cheap insurance against
  // exactly this ambiguous case); the call site is what decides whether two independent
  // marker-less blocks add up to human-eligible.
  attempt(ctx.attempts, step, t, { ok: false, error: `HTTP ${res.status}` })
  return { status: res.status, decisive: false, markerless: true }
}

// The html branch of step 1: the 200-challenge check, the js-shell shortcut, then extraction
// and the MIN_USABLE_CHARS floor. Split out of `readOriginBody` so the "is this actually a
// challenge page" decision reads as its own step rather than as the tail of the body pipeline.
// `stepRef` is a one-cell mutable holder, not a ChainContext field: it exists only to let
// `runOrigin`'s catch block report the SAME step label this function was about to record under
// if something throws after `via` is known (extractText succeeded but `hostGate.noteOk`/`log`
// then threw) — a local concern of one `runOrigin` call, never shared across stages the way the
// context flags are.
async function readOriginHtml(
  ctx: ChainContext,
  res: Response,
  body: string,
  label: FetchStep,
  t1: number,
  attemptStartedAt: number,
  stepRef: { current: FetchStep },
): Promise<{ terminal: FetchChainResult } | { terminal: null; block: BlockOutcome }> {
  // A 200 response can still BE the challenge — Cloudflare's managed-challenge interstitial is
  // served with a 200 (challenge.ts's header comment), so a decisive verdict counts here even
  // though this status is never in BLOCK_CHECK_STATUSES. Checked before extraction: no point
  // asking Readability to find an article inside a "Just a moment..." interstitial.
  const verdict = classifyBlock({ status: res.status, headers: res.headers, bodySample: body })
  if (verdict) {
    recordBlockVerdict(ctx, verdict, res.status, label, t1)
    // Not gated into the impersonation rung — the caller below only offers that rung for the
    // BLOCK_CHECK_STATUSES status set (401/403/503), which never includes a 200.
    return { terminal: null, block: { status: res.status, decisive: verdict.decisive, markerless: false } }
  }
  if (isJavaScriptShell(body)) {
    // Not a block — the origin sent its normal anti-crawler shell (site-adapters.ts's Reddit
    // case). Rendering, not a human, is the fix, so this falls through to step 2 without
    // touching the host gate's block bookkeeping.
    attempt(ctx.attempts, label, t1, { ok: false, error: 'js-shell' })
    return { terminal: null, block: null }
  }

  // Parsing runs in a worker pool (html-parse.ts), off the event loop — linkedom + Readability
  // are synchronous CPU work that would otherwise block /health (issue #21).
  const { via, text } = await extractText(ctx.url, body, ctx.budget)
  // The impersonation rung always records under its own label — `via` here is a site
  // adapter/Readability choice that has nothing to do with which fetcher dialled the origin,
  // and a success through impit is `via: 'impersonate'` so fetch-bench/probe can count what
  // the rung buys, never `readability`.
  const step: FetchStep = label === 'impersonate' ? 'impersonate' : via
  stepRef.current = step
  if (label !== 'impersonate') ctx.noteReadabilityMiss('thin', text?.length ?? 0)
  if (text && text.length >= MIN_USABLE_CHARS && !looksBinary(text)) {
    attempt(ctx.attempts, step, t1, { ok: true, chars: text.length })
    ctx.hostGate.noteOk(ctx.host, { startedAt: attemptStartedAt })
    log('tool.fetchPage', { jobId: ctx.jobId, url: ctx.url, via: step, chars: text.length })
    return { terminal: ctx.done(step, text) }
  }
  const error = text && looksBinary(text) ? 'binary content' : `thin (${text?.length ?? 0} chars)`
  attempt(ctx.attempts, step, t1, { ok: false, chars: text?.length ?? 0, error })
  return { terminal: null, block: null }
}

// The step-1 body cap plus the PDF verdict it was decided from: a PDF needs the whole document
// for poppler (MAX_PDF_BYTES), every non-PDF body is bounded at MAX_BODY_BYTES. A PDF served
// under a wrong or absent Content-Type is recognised by the `%PDF-` magic in the bytes handed
// here — bundled into one return so the caller's `chooseCap` closure (bounded-read.ts's
// `readBoundedBytesByCap` only returns a number) can still hand the verdict back without a
// second, redundant `isPdf` call on the same bytes once the read is done.
function bodyCapFor(contentType: string | null, bytes: Uint8Array): { capBytes: number; isPdfBody: boolean } {
  const isPdfBody = isPdf(contentType, bytes)
  return { capBytes: isPdfBody ? MAX_PDF_BYTES : MAX_BODY_BYTES, isPdfBody }
}

// The body pipeline of step 1, once a 2xx response is in hand: read it once as bytes, then
// dispatch to whichever of pdf/raw/html actually applies. Split out of `runOrigin` so the
// top-level function reads as "status check, then body", not both interleaved.
async function readOriginBody(
  ctx: ChainContext,
  res: Response,
  label: FetchStep,
  t1: number,
  attemptStartedAt: number,
  stepRef: { current: FetchStep },
): Promise<{ terminal: FetchChainResult } | { terminal: null; block: BlockOutcome }> {
  // Read the body ONCE, as BYTES — a Response body is a stream and cannot be consumed twice,
  // and PDF detection needs the raw bytes (the `%PDF-` magic) before any text decoding. This is
  // what closes the bug this whole change fixes: the VPS fetched arxiv.org/pdf/1706.03762,
  // `res.text()` decoded 1,984,323 bytes of PDF binary as UTF-8 "text", and
  // Readability/normalizeText handed that back as a `retrieved` success. A PDF needs the whole
  // document for poppler, so it is read at MAX_PDF_BYTES; every non-PDF body is bounded at
  // MAX_BODY_BYTES. The cap is chosen from the DECLARED Content-Type up front, but a PDF served
  // under a wrong or absent Content-Type only announces itself in the `%PDF-` magic at the
  // start of the body, so the cap is re-decided once a real prefix of the body has arrived
  // (bounded-read.ts buffers at least 8 bytes before trusting the chooser) — a mislabeled PDF
  // delivered one byte at a time still reaches the 40 MB cap, not the 8 MB one. The verdict
  // `bodyCapFor` reached on that prefix is captured via closure rather than re-derived from the
  // final bytes, so there is exactly one place that decides it. A truncated read is treated as
  // a miss, same as any other step-1 failure, and falls through to rendering/Tavily.
  const contentType = res.headers.get('content-type')
  let isPdfBody = false
  const { bytes, truncated, cap: capBytes } = await readBoundedBytesByCap(res.body, (prefix) => {
    const decision = bodyCapFor(contentType, prefix)
    isPdfBody = decision.isPdfBody
    return decision.capBytes
  })

  if (truncated) {
    // An oversized PDF still IS a PDF — the renderer (step 2) has nothing to add to a
    // document with no DOM, so skip it here exactly like the identified-PDF branch below,
    // even though pdftotext never runs against these truncated bytes. A truncated non-PDF
    // body (an HTML page, a raw JSON/CSV dump) has no complete document to hand any reader,
    // so it is a miss like any other — never a partial answer passed to a parser or a
    // citation.
    if (isPdfBody) ctx.markPdfBody()
    attempt(ctx.attempts, label, t1, { ok: false, error: `body exceeds ${capBytes} byte cap` })
    return { terminal: null, block: null }
  }
  if (isPdfBody) {
    ctx.markPdfBody()
    const pdf = await extractPdfText(bytes, { jobId: ctx.jobId })
    if (pdf.ok) {
      // `pdf.truncated` means pdftotext's OWN output was cut at its byte cap while still
      // writing — a real, complete-so-far extraction, not a failure, but the worker reading
      // this text MUST know it is incomplete rather than treat it as the whole paper. Appended
      // honestly rather than silently dropped (previously discarded at this exact call site).
      const text = pdf.truncated ? `${pdf.text}${pdfTruncationNotice()}` : pdf.text
      attempt(ctx.attempts, 'pdf', t1, { ok: true, chars: text.length })
      ctx.hostGate.noteOk(ctx.host, { startedAt: attemptStartedAt })
      log('tool.fetchPage', { jobId: ctx.jobId, url: ctx.url, via: 'pdf', chars: text.length, truncated: pdf.truncated })
      return { terminal: ctx.done('pdf', text) }
    }
    // pdftotext missing, failed, or below the text floor (a scanned PDF with no text layer)
    // — falls through to Tavily Extract, which OCRs PDFs server-side. Never a reason to pass
    // the bytes through as text.
    attempt(ctx.attempts, 'pdf', t1, { ok: false, error: pdf.error })
    log('tool.fetchPage', { jobId: ctx.jobId, url: ctx.url, via: 'pdf', error: pdf.error })
    return { terminal: null, block: null }
  }

  const body = new TextDecoder().decode(bytes)

  // A non-HTML body IS the answer — hand it back verbatim rather than asking an HTML parser
  // to find an article in it.
  if (isRawContentType(contentType)) {
    const raw = normalizeText(body)
    if (raw.length > 0 && !looksBinary(raw)) {
      attempt(ctx.attempts, 'raw', t1, { ok: true, chars: raw.length })
      ctx.hostGate.noteOk(ctx.host, { startedAt: attemptStartedAt })
      log('tool.fetchPage', { jobId: ctx.jobId, url: ctx.url, via: 'raw', chars: raw.length, contentType })
      return { terminal: ctx.done('raw', raw) }
    }
    // An empty or binary body is a miss like any other — fall through to the rendering
    // steps, which is the right answer for a URL that serves an empty JSON body to a bot and
    // a real page to a browser. `looksBinary` catches a binary response (image/zip/octet-
    // stream) served under a Content-Type this chain otherwise treats as raw text, and that
    // isPdf's magic-byte check didn't own.
    const error = raw.length === 0 ? 'empty body' : 'binary content'
    attempt(ctx.attempts, 'raw', t1, { ok: false, chars: raw.length, error })
    return { terminal: null, block: null }
  }

  return await readOriginHtml(ctx, res, body, label, t1, attemptStartedAt, stepRef)
}

// ── Step 1: plain fetch + linkedom + Readability (or a site adapter's own reader) —
// or, for a host this process already learned needs it (`impersonationMemory.prefers`), the
// TLS-impersonation rung directly, so a chain that already knows the plain request 403s
// spends only ONE gated origin hit instead of two.
//
// `runOrigin` is the pipeline shared by both rungs — status handling, block
// classification, pdf/raw/html/extract — parameterized by which fetcher dials the origin
// and which `FetchStep` label an attempt/success is recorded under. It returns a terminal
// `FetchChainResult` when the chain should stop here, or `{ terminal: null, block }` to
// fall through: `block` is non-null only when the response landed on a status this chain
// treats as an anti-bot signal (401/403/429/503), regardless of whether `classifyBlock`
// found a vendor marker (idealo's bare 403 carries none) — that is what the impersonation
// gate below keys on.
//
// The pipeline itself is split into `classifyOriginBlock` (the non-2xx branch),
// `readOriginBody` (the pdf/raw/html dispatch once a 2xx is in hand) and `readOriginHtml`
// (the html-specific 200-challenge/js-shell/extract sub-branch); this function is left as the
// one place that dials the origin, recognises a definitively-missing resource, and catches
// whatever any of the above throws.
async function runOrigin(
  ctx: ChainContext,
  fetcher: Fetcher,
  label: FetchStep,
): Promise<{ terminal: FetchChainResult } | { terminal: null; block: BlockOutcome }> {
  const t1 = performance.now()
  // A SEPARATE clock from `t1` above: `t1` is `performance.now()` (monotonic, process-
  // relative — used only for the `ms` telemetry on each attempt), while `hostGate`'s
  // `noteOk`/`cooldown` bookkeeping runs on `Date.now()` (its default clock). Passed as
  // `startedAt` to every `noteOk` call this attempt makes, so a success can never clear a
  // cooldown a CONCURRENT chain set after this attempt had already begun (host-gate.ts's
  // `noteOk` staleness guard).
  const attemptStartedAt = Date.now()
  // The step label the outer catch reports under — starts at `label`, and tracks
  // `readOriginHtml`'s reassignment (once `via` is known) so a throw AFTER that point (e.g.
  // `hostGate.noteOk`/`log`) is still attributed to the step that was actually about to
  // succeed, exactly as the single-function version did.
  const stepRef = { current: label }
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
    const { res, finalUrl } = await ctx.hostGate.run(ctx.host, ctx.policy, () => safeFetch(ctx.fetchUrl, ctx.jobId, 3, ctx.budget, fetcher), ctx.budget)
    if (isDefinitivelyMissing(res.status)) {
      const reason = `HTTP ${res.status} — the resource does not exist at this URL`
      attempt(ctx.attempts, stepRef.current, t1, { ok: false, error: reason })
      ctx.ledger.recordMissing(finalUrl, reason)
      log('tool.fetchPage', { jobId: ctx.jobId, url: ctx.url, via: 'missing', status: res.status })
      return { terminal: ctx.fail(reason) }
    }

    if (!res.ok) {
      return { terminal: null, block: await classifyOriginBlock(ctx, res, label, t1) }
    }

    return await readOriginBody(ctx, res, label, t1, attemptStartedAt, stepRef)
  } catch (err) {
    // fetch or parse failed — fall through to the rendering steps.
    if (label !== 'impersonate') ctx.noteReadabilityMiss('threw')
    attempt(ctx.attempts, stepRef.current, t1, { ok: false, error: String(err) })
    return { terminal: null, block: null }
  }
}

// Steps 1-2 record no attempts at all when skipped, rather than a fabricated "didn't run"
// entry — `attempts` stays an honest record of what actually happened, and a caller reading
// it back (fetch-bench.ts, `tool.fetchPage` logs) sees exactly one `tavily-extract` entry for
// these URLs, not two dishonest failures in front of it.
export async function runOriginStage(ctx: ChainContext): Promise<FetchChainResult | null> {
  const originSkip = ctx.stageSkipReason('origin')
  if (originSkip) {
    // The rung this chain would have run had it not been skipped — `impersonate` for a host
    // already learned to need it, `readability` otherwise — never hardcoded, so the skipped
    // attempt's `step` names the rung that was actually bypassed.
    const skippedStep: FetchStep = ctx.impersonationMemory.prefers(ctx.host) ? 'impersonate' : 'readability'
    attempt(ctx.attempts, skippedStep, performance.now(), { ok: false, error: `skipped: ${originSkip}` })
    // Human-eligible only for a POLICY skip (a table entry the host earned by measurement —
    // see host-policy.ts) or a CHALLENGE-kind cooldown (a vendor-marker verdict a human can
    // plausibly solve). A marker-less rate-limit cooldown means "slow down", not "blocked" —
    // a human solving a captcha does nothing for it, same reasoning as the 429 branch above.
    const cd = ctx.hostGate.cooldown(ctx.host)
    if (ctx.policy.skip.includes('origin') || cd?.kind === 'challenge') ctx.markBlocked()
    log('tool.fetchPage', { jobId: ctx.jobId, url: ctx.url, via: 'origin-skipped', reason: originSkip })
  } else if (ctx.impersonationMemory.prefers(ctx.host)) {
    // Learned on an earlier chain this run: plain fetch 403s this host, impersonation reads
    // it — skip straight to the rung that actually works, one gated origin hit instead of two.
    const r = await runOrigin(ctx, ctx.impersonatedFetcher, 'impersonate')
    if (r.terminal) return r.terminal
    if (r.block) ctx.impersonationMemory.noteFailed(ctx.host) // blocked again — the learned preference no longer holds
  } else {
    const r = await runOrigin(ctx, defaultFetcher, 'readability')
    if (r.terminal) return r.terminal
    if (r.block && r.block.status !== 429 && IMPERSONATE_ELIGIBLE_STATUSES.has(r.block.status)) {
      // The one seam a second origin rung slots into: a plain-fetch block on a host with no
      // reason yet to believe impersonation is hopeless (ebay.com/g2.com/mpb.com's policy
      // entries skip this by leaving origin/render off the table entirely — see
      // host-policy.ts). Runs through the SAME gate/cooldown bookkeeping as the plain hit,
      // never a second ungated origin hit.
      const impersonateStartedAt = Date.now() // hostGate's clock domain — see `attemptStartedAt` above
      const ir = await runOrigin(ctx, ctx.impersonatedFetcher, 'impersonate')
      if (ir.terminal) {
        ctx.impersonationMemory.noteWorks(ctx.host)
        ctx.hostGate.noteOk(ctx.host, { startedAt: impersonateStartedAt }) // clears the cooldown the plain block just set — the host IS readable to us
        return ir.terminal
      }
      // On a VENDOR-MARKED block: `runOrigin` already ran `hostGate.noteBlocked`/set
      // `sawBlock`/`originDecisiveBlock` for THIS (impersonated) attempt — nothing further to
      // do here. On a MARKER-LESS block on BOTH rungs, neither call touched `sawBlock` or the
      // cooldown (a single forbidden page with no vendor fingerprint is too thin evidence for
      // a host-wide cooldown) — but two INDEPENDENT rungs agreeing the host is forbidden is
      // enough to let a human try, so this is the one place that sets `sawBlock` for that
      // case. Excluded on purpose: a marker-less 401 on the plain request (an auth wall a
      // captcha-solve can't fix — never human-eligible) and an impersonation-side 429 (a rate
      // limit, not a block).
      if (r.block.markerless && r.block.status !== 401 && ir.block && ir.block.status !== 429) {
        ctx.markBlocked()
      }
    }
  }
  return null
}
