import { describe, it, expect } from 'bun:test'
import { parseHTML } from 'linkedom'
import { Readability } from '@mozilla/readability'
import { normalizeText } from './extract.js'
import { ParsePool } from './parse-pool.js'

// The pre-pool inline code path this module replaced in fetch-chain.ts — kept here only as
// the parity baseline, not re-exported anywhere, so a regression in either side shows up as a
// diff between the two instead of both silently drifting together.
function parseInline(html: string): string | null {
  const { document } = parseHTML(html)
  const article = new Readability(document as unknown as ConstructorParameters<typeof Readability>[0]).parse()
  const raw = article?.textContent?.trim()
  return raw ? normalizeText(raw) : (raw ?? null)
}

const ARTICLE_HTML = `<html><head><title>Test Article</title></head><body><article>${'<p>Paragraph text repeated for bulk so Readability has a real article to score.</p>'.repeat(30)}</article></body></html>`

function buildBigHtml(targetChars: number): string {
  // Many SHORT paragraphs rather than few long ones: Readability's cost scales with node
  // count (it scores every candidate node), so this stresses the parser far more per
  // character than a few giant paragraphs would, and reads closer to a real heavy page
  // (a long forum thread or a paginated listing) than a wall of Lorem Ipsum.
  const paragraph = '<p>Filler sentence for load testing the parser.</p>\n'
  const count = Math.ceil(targetChars / paragraph.length)
  return `<html><head><title>Big document</title></head><body><article>${paragraph.repeat(count)}</article></body></html>`
}

/** Runs `work`, sampling a 20ms interval throughout, and returns the worst gap between ticks. */
async function measureMaxGap(work: () => Promise<unknown>): Promise<number> {
  let maxGap = 0
  let last = performance.now()
  const timer = setInterval(() => {
    const now = performance.now()
    const gap = now - last
    last = now
    if (gap > maxGap) maxGap = gap
  }, 20)
  try {
    await work()
    // Let one more tick land AFTER the work: a synchronous block only shows up as the gap
    // between the last tick before it and the first one after it, and clearing the interval
    // straight away would never record that gap at all (it measured 0ms before this).
    await new Promise((resolve) => setTimeout(resolve, 60))
  } finally {
    clearInterval(timer)
  }
  return maxGap
}

describe('ParsePool parity', () => {
  it('parses a fixture article to the same text as the old inline code path', async () => {
    const pool = new ParsePool()
    const result = await pool.parse({ html: ARTICLE_HTML, url: 'https://example.invalid/article' })
    expect(result.via).toBe('readability')
    expect(result.text).not.toBeNull()
    expect(result.text).toBe(parseInline(ARTICLE_HTML))
  })
})

describe('ParsePool liveness', () => {
  // Measured, not asserted, into existence: the whole point of this file is that a document
  // large enough to matter must not block the loop this process shares with every job's
  // heartbeat, the idle watchdog and the HTTP listener (loop-watch.ts's header has the
  // incident). ~1.5M chars sits under PARSE_INPUT_CAP (2,000,000) — the cap this pool does
  // NOT enforce itself (that is the caller's job, in fetch-chain.ts, before it ever reaches
  // here) — so this is a legitimate, cap-passing document, not an adversarial one.
  it('keeps the main thread responsive while the pool parses a large document', async () => {
    const bigHtml = buildBigHtml(1_500_000)
    const pool = new ParsePool()

    const viaPool = await measureMaxGap(() => pool.parse({ html: bigHtml, url: 'https://example.invalid/big' }))
    // The contract: whatever this document costs to parse, it must cost the WORKER, not this
    // thread's 20ms tick. 250ms is generous headroom over normal scheduler jitter.
    expect(viaPool).toBeLessThan(250)

    // Printed, not asserted: the pool's whole point is that this number is allowed to be
    // large. Quoted in the PR alongside `viaPool` above.
    const viaInline = await measureMaxGap(async () => {
      parseInline(bigHtml)
    })
    console.log(`[parse-pool liveness] pool max tick gap: ${viaPool.toFixed(1)}ms, inline max tick gap: ${viaInline.toFixed(1)}ms`)
  })
})

describe('ParsePool hang guard', () => {
  it('terminates a worker that never replies and rejects that parse as a hang, not an error', async () => {
    const workerUrl = new URL('./__fixtures__/never-replies-worker.ts', import.meta.url)
    // A tiny guard so the test does not wait out the production 60s default — the fixture
    // itself never answers regardless of how long the guard is.
    const pool = new ParsePool({ size: 1, hangGuardMs: 30, workerUrl })
    await expect(pool.parse({ html: '<html></html>', url: 'https://example.invalid/hang' })).rejects.toThrow(/parse hang guard/)
  })

  it('serves the next parse after a hang, on the replaced worker', async () => {
    const workerUrl = new URL('./__fixtures__/never-replies-worker.ts', import.meta.url)
    const pool = new ParsePool({ size: 1, hangGuardMs: 30, workerUrl })
    await expect(pool.parse({ html: '<html></html>', url: 'https://example.invalid/one' })).rejects.toThrow(/parse hang guard/)
    // Same fixture never replies either way, so this proves only that the pool tried again on
    // a fresh worker rather than staying stuck on the dead one — it still hangs, and still
    // resolves via the SAME guard, rather than queueing forever behind the first job.
    await expect(pool.parse({ html: '<html></html>', url: 'https://example.invalid/two' })).rejects.toThrow(/parse hang guard/)
  })
})

describe('ParsePool crash recovery', () => {
  it('replaces a crashed worker and the next parse succeeds', async () => {
    const workerUrl = new URL('./__fixtures__/crash-once-parse-worker.ts', import.meta.url)
    const pool = new ParsePool({ size: 1, workerUrl })
    await expect(pool.parse({ html: '<html></html>', url: 'crash:trigger' })).rejects.toThrow()
    const result = await pool.parse({ html: '<html></html>', url: 'https://example.invalid/ok' })
    expect(result.text).toBe('ok')
  })
})
