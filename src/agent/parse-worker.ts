// Worker-thread entrypoint for the fetch chain's synchronous HTML parsing (issue #21).
//
// linkedom's `parseHTML` and Mozilla Readability's `parse` are synchronous CPU work. Run on a
// page's worth of HTML they can block the single Bun event loop long enough that /health and
// the HTTP listener stop answering while deep jobs run (measured 2026-09-23: 6-9 min outages
// at RESEARCH_MAX_CONCURRENCY, two jobs reaped). This file runs inside a Bun Worker — spawned
// and pooled by html-parse.ts — so that work never runs on the loop that serves requests.
//
// The handler catches every parse error and answers `{ ok: false }` instead of throwing, so
// the caller degrades to the fallback steps exactly as it did when parsing ran inline and
// threw. Dependency-free by design (no env/log/fetch import): it imports only the same pure
// modules fetch-chain.ts's inline parser already used.

import { parseHTML } from 'linkedom'
import { Readability } from '@mozilla/readability'
import { resolveSite } from './site-adapters.js'
import { normalizeText } from './extract.js'

export type ParseRequest =
  | { kind: 'extract'; url: string; body: string }
  | { kind: 'readability'; body: string }

export type ParseResponse =
  | { ok: true; via: 'site-adapter' | 'readability'; text: string | null }
  | { ok: false; error: string }

declare const self: Worker

// The Wayback step's reader: plain Readability, no site adapter.
function viaReadability(body: string): string | null {
  const { document } = parseHTML(body)
  const article = new Readability(document as unknown as ConstructorParameters<typeof Readability>[0]).parse()
  const raw = article?.textContent?.trim()
  const text = raw ? normalizeText(raw) : raw
  return text ?? null
}

self.onmessage = (e: MessageEvent<ParseRequest>): void => {
  try {
    const req = e.data
    if (req.kind === 'readability') {
      self.postMessage({ ok: true, via: 'readability', text: viaReadability(req.body) } satisfies ParseResponse)
      return
    }

    const { document } = parseHTML(req.body)
    // The site adapter (if any) is re-resolved from the ORIGINAL url, exactly as the caller
    // did, so the same reader applies to the same host without shipping a function across the
    // worker boundary. `null` falls through to Readability unchanged.
    const site = resolveSite(req.url)
    const adapted = site.extract ? site.extract(document as never) : null
    const article = adapted
      ? null
      : new Readability(document as unknown as ConstructorParameters<typeof Readability>[0]).parse()
    const raw = adapted ?? article?.textContent?.trim()
    const text = raw ? normalizeText(raw) : raw
    self.postMessage({
      ok: true,
      via: adapted ? 'site-adapter' : 'readability',
      text: text ?? null,
    } satisfies ParseResponse)
  } catch (err) {
    self.postMessage({ ok: false, error: String(err) } satisfies ParseResponse)
  }
}
