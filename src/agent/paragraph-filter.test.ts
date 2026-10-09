import { describe, expect, test } from 'bun:test'
import { TEXT_CAP } from './extract.js'
import { LINE_FILTER_MAX_CHARS } from './line-filter.js'
import { filterParagraphs, fitDocumentText } from './paragraph-filter.js'

// A paper-shaped document: a title, many body paragraphs separated by blank lines, the safety
// section far past the 80k cut.
function paper(sep = '\n\n'): string {
  const paras = ['Llama 3 Herd of Models']
  for (let i = 0; i < 400; i++) paras.push(`Section ${i}: ${'filler text about training. '.repeat(10)}`)
  paras.splice(380, 0, 'Llama Guard 3 reduces violation rate by 86% on our internal safety benchmark.')
  return paras.join(sep)
}

describe('filterParagraphs', () => {
  const doc = paper()

  test('fixture is longer than the page cut and the target sits past it', () => {
    expect(doc.length).toBeGreaterThan(TEXT_CAP * 1.4)
    expect(doc.indexOf('Llama Guard')).toBeGreaterThan(TEXT_CAP)
  })

  test('returns the title, the matching paragraph and one paragraph of context each side', () => {
    const r = filterParagraphs(doc, ['llama guard'], TEXT_CAP)!
    expect(r.text.startsWith('Llama 3 Herd of Models')).toBe(true)
    expect(r.text).toContain('86% on our internal safety benchmark')
    expect(r.text).toContain('Section 378:')
    expect(r.text).toContain('Section 379:')
    expect(r.text).not.toContain('Section 100:')
    expect(r.matched).toBe(1)
    expect(r.text.length).toBeLessThanOrEqual(TEXT_CAP)
    expect(r.text).toContain('rest of the document was NOT returned')
  })

  test('works on newline-delimited text too', () => {
    const r = filterParagraphs(paper('\n'), ['llama guard'], TEXT_CAP)!
    expect(r.text).toContain('86% on our internal')
  })

  test('null when nothing matches', () => {
    expect(filterParagraphs(doc, ['nonexistent-term'], TEXT_CAP)).toBeNull()
  })

  test('stays within the cap and reports what did not fit', () => {
    const r = filterParagraphs(doc, ['section'], 5_000)!
    expect(r.text.length).toBeLessThanOrEqual(5_000)
    expect(r.omitted).toBeGreaterThan(0)
    expect(r.text).toContain('did not fit')
  })

  test('a clipped hit keeps a window around the matching term, not the paragraph start', () => {
    const para = `${'intro words '.repeat(1_000)}the Llama Guard result is 86% here ${'outro words '.repeat(1_000)}`
    const doc = [`Title`, ...Array.from({ length: 30 }, (_, i) => `Filler ${i} ${'f'.repeat(3_000)}`), para].join('\n\n')
    const r = filterParagraphs(doc, ['llama guard'], TEXT_CAP)!
    expect(r.text).toContain('Llama Guard result is 86%')
  })

  test('clips a single enormous paragraph', () => {
    const r = filterParagraphs(`Title\n\n${'word '.repeat(100_000)}needle`, ['needle'], TEXT_CAP)
    expect(r === null || r.text.length <= TEXT_CAP).toBe(true)
  })
})

describe('fitDocumentText', () => {
  test('leaves a document that fits the cap, and a call without terms, untouched', () => {
    expect(fitDocumentText('short doc', ['doc'], TEXT_CAP)).toEqual({ text: 'short doc', filter: null })
    const long = paper()
    expect(fitDocumentText(long, undefined, TEXT_CAP).text).toBe(long)
  })

  test('filters a long document', () => {
    const r = fitDocumentText(paper(), ['llama guard'], TEXT_CAP)
    expect(r.filter?.matched).toBe(1)
    expect(r.text).toContain('86%')
  })

  test('a broad term delivers at most the line-filter cap, not the whole page cut', () => {
    const r = fitDocumentText(paper(), ['section'], TEXT_CAP)
    expect(r.filter?.matched).toBe(400)
    expect(r.text.length).toBeLessThanOrEqual(LINE_FILTER_MAX_CHARS)
    expect(r.text).toContain('further matching paragraphs did not fit')
  })

  test('says so in one line and keeps the head when nothing matches', () => {
    const doc = paper()
    const r = fitDocumentText(doc, ['zzz'], TEXT_CAP)
    expect(r.text.startsWith('[no paragraph of this document matched "zzz"; its head is returned instead.]\n\nLlama 3 Herd')).toBe(true)
    expect(r.filter?.matched).toBe(0)
  })
})
