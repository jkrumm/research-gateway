import { describe, it, expect } from 'bun:test'
import { extractText, readabilityText } from './html-parse.js'

const PAGE = `<html><body><article><h1>Title</h1><p>${'real words to read as article content. '.repeat(20)}</p></article></body></html>`

describe('parse pool aborts', () => {
  it('fails fast on an already-spent budget without dispatching', async () => {
    await expect(readabilityText(PAGE, AbortSignal.abort())).rejects.toThrow('budget exhausted')
  })

  it('retires a worker whose parse outlives the budget and keeps serving', async () => {
    const ctrl = new AbortController()
    const inFlight = extractText('https://203.0.113.20/page', PAGE, ctrl.signal)
    ctrl.abort()
    await expect(inFlight).rejects.toThrow('budget exhausted')

    // The slot came back: more parses than the pool has workers all complete.
    const results = await Promise.all(Array.from({ length: 6 }, () => readabilityText(PAGE)))
    for (const r of results) expect(r.text).toContain('real words to read')
  })
})
