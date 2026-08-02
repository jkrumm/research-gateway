import { describe, it, expect } from 'bun:test'
import { parseHTML } from 'linkedom'
// linkedom is a runtime dependency and needs no env, so the extractor can be exercised
// against real markup rather than a hand-rolled DOM stub.
import { extractRedditThread, type MinimalDocument } from './extract-reddit.js'

const doc = (html: string): MinimalDocument =>
  parseHTML(`<html><body>${html}</body></html>`).document as never

const entry = (score: string | null, body: string | null) =>
  `<div class="entry">
     ${score === null ? '' : `<span class="score unvoted">${score}</span>`}
     ${body === null ? '' : `<div class="usertext-body"><div class="md"><p>${body}</p></div></div>`}
   </div>`

describe('extractRedditThread', () => {
  it('keeps the title and every comment body — the tree Readability discards', () => {
    const out = extractRedditThread(
      doc(`<a class="title">Thinking about leaving Bun</a>
           ${entry('240 points', 'RSS climbed past 900 MiB.')}
           ${entry('12 points', 'Switching to Node fixed it.')}`),
    )
    expect(out).toContain('Thinking about leaving Bun')
    expect(out).toContain('RSS climbed past 900 MiB.')
    expect(out).toContain('Switching to Node fixed it.')
  })

  it('carries the score, which is the only endorsement signal on the page', () => {
    // A claim at +240 and a claim at -3 are not equally worth citing, and once the text is
    // flattened the worker has no other way to tell them apart.
    const out = extractRedditThread(doc(entry('240 points', 'Widely endorsed claim.')))
    expect(out).toContain('[240 points] Widely endorsed claim.')
  })

  it('reads each score from its own entry rather than pairing lists positionally', () => {
    // A deleted comment keeps its container but loses its body. Index-matching scores to
    // bodies would shift every later score onto the wrong comment from here on.
    const out = extractRedditThread(
      doc(`${entry('99 points', null)}${entry('5 points', 'Second comment.')}`),
    )
    expect(out).toContain('[5 points] Second comment.')
    expect(out).not.toContain('[99 points]')
  })

  it('emits a comment with no score rather than dropping it', () => {
    const out = extractRedditThread(doc(entry(null, 'Unscored but real.')))
    expect(out).toBe('Unscored but real.')
  })

  it('returns null when the page has no Reddit body markup, so the caller falls back', () => {
    // Returning '' here instead would hand the worker a silently empty page — the exact
    // failure mode that made Reddit worth fixing.
    expect(extractRedditThread(doc('<article><p>An ordinary web page.</p></article>'))).toBeNull()
  })

  it('falls back to the flat body list when the .entry structure is absent', () => {
    const out = extractRedditThread(
      doc(`<a class="title">Link post</a>
           <div class="usertext-body"><div class="md"><p>Orphaned body.</p></div></div>`),
    )
    expect(out).toContain('Link post')
    expect(out).toContain('Orphaned body.')
  })

  it('uses <title> when the thread has no a.title', () => {
    const html = parseHTML(
      `<html><head><title>Fallback title</title></head><body>${entry('1 point', 'Body.')}</body></html>`,
    ).document as never
    expect(extractRedditThread(html)).toContain('Fallback title')
  })
})
