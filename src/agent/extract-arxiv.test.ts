import { describe, it, expect } from 'bun:test'
import { parseHTML } from 'linkedom'
// linkedom is a runtime dependency and needs no env, so the extractor can be exercised
// against real markup rather than a hand-rolled DOM stub — same convention as
// extract-reddit.test.ts.
import { extractArxivHtml } from './extract-arxiv.js'

const doc = (html: string) => parseHTML(`<html><body>${html}</body></html>`).document as never

describe('extractArxivHtml', () => {
  it('extracts prose, substitutes math alttext, and renders a table as pipe-joined rows', () => {
    const document = doc(`<article class="ltx_document">
      <p class="ltx_p">We assume <math alttext="Y\\mid X\\sim\\mathcal{F}_{\\bm{\\theta}}"><mrow>ignored mathml</mrow></math> throughout.</p>
      <table class="ltx_tabular">
        <tr><td>Model</td><td>CRPS</td></tr>
        <tr><td>EMOS</td><td>0.42</td></tr>
      </table>
    </article>`)
    const out = extractArxivHtml(document)
    expect(out).toContain('$Y\\mid X\\sim\\mathcal{F}_{\\bm{\\theta}}$')
    expect(out).toContain('Model | CRPS')
    expect(out).toContain('EMOS | 0.42')
  })

  it('substitutes math alttext inside a table cell too, not just prose', () => {
    const document = doc(`<article class="ltx_document">
      <table class="ltx_tabular">
        <tr><td>Bound</td><td><math alttext="\\epsilon"><mrow>ignored</mrow></math></td></tr>
      </table>
    </article>`)
    const out = extractArxivHtml(document)
    expect(out).toContain('Bound | $\\epsilon$')
  })

  it('falls back to the math node\'s own text when it carries no alttext', () => {
    const document = doc(`<article class="ltx_document">
      <p class="ltx_p">A formula with <math>no alttext here</math> at all.</p>
    </article>`)
    const out = extractArxivHtml(document)
    expect(out).toContain('no alttext here')
  })

  it('accepts a bare .ltx_document element with no wrapping <article>', () => {
    const document = doc('<div class="ltx_document"><p class="ltx_p">plain prose</p></div>')
    expect(extractArxivHtml(document)).toContain('plain prose')
  })

  it('returns null on a page that is not LaTeXML, falling through to Readability', () => {
    const document = doc('<div class="not-latexml"><p>a 404 page, or something else entirely</p></div>')
    expect(extractArxivHtml(document)).toBeNull()
  })

  it('returns null when the article body is present but produces no text at all', () => {
    const document = doc('<article class="ltx_document"></article>')
    expect(extractArxivHtml(document)).toBeNull()
  })
})
