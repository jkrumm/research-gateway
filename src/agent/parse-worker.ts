import { parseHTML } from 'linkedom'
import { Readability } from '@mozilla/readability'
import { normalizeText } from './extract.js'
import { resolveSite } from './site-adapters.js'

// The Bun Worker entry `parse-pool.ts` spawns — runs the synchronous HTML parse (linkedom +
// a site adapter or Readability, then `normalizeText`) off the main event loop, so an
// oversized-but-under-cap document can no longer stall heartbeats, the idle watchdog and the
// HTTP listener the way it did on 2026-09-20 (see loop-watch.ts's header). `PARSE_INPUT_CAP`
// still bounds what is handed here — this file only moves WHERE the bounded parse runs, not
// how large a document it will accept.
//
// Dependency-free of env.js/log.js like site-adapters.ts/extract.ts: a worker thread has no
// useful console correlation to a job anyway, and the pool that spawns this is itself
// env-free (see parse-pool.ts's header) — nothing here should need env to stay that way.
//
// Message contract is mirrored, not shared, with parse-pool.ts on purpose: a worker boundary
// is a structured-clone boundary, and duplicating four fields is cheaper than a shared-types
// module that both a main-thread and a worker-thread entrypoint would need to import safely.
interface ParseRequest {
  id: number
  html: string
  url: string
}

type ParseResponse =
  | { id: number; via: 'site-adapter' | 'readability'; text: string | null }
  | { id: number; error: string }

addEventListener('message', (event: MessageEvent<ParseRequest>) => {
  const { id, html, url } = event.data
  try {
    const { document } = parseHTML(html)
    // A site adapter reads its own markup; anything else, and any adapter that does not
    // recognise what it got, falls through to Readability unchanged — identical to the
    // inline step-1 branch this replaces in fetch-chain.ts.
    const site = resolveSite(url)
    const adapted = site.extract ? site.extract(document as never) : null
    const article = adapted
      ? null
      : new Readability(document as unknown as ConstructorParameters<typeof Readability>[0]).parse()
    const raw = adapted ?? article?.textContent?.trim()
    const text = raw ? normalizeText(raw) : (raw ?? null)
    const response: ParseResponse = { id, via: adapted ? 'site-adapter' : 'readability', text }
    postMessage(response)
  } catch (err) {
    const response: ParseResponse = { id, error: String(err) }
    postMessage(response)
  }
})
