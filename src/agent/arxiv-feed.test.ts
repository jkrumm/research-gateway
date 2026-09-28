import { describe, it, expect, spyOn } from 'bun:test'
import { fetchArxivFeed } from './arxiv-feed.js'

const jsonHeaders = { 'content-type': 'text/xml' }

describe('fetchArxivFeed', () => {
  it('cancels the response body on a non-ok response before returning, draining the socket', async () => {
    let cancelled = false
    const stubResponse = {
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      body: {
        cancel: async () => {
          cancelled = true
        },
      },
    } as unknown as Response
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(stubResponse)

    const result = await fetchArxivFeed('https://export.arxiv.org/api/query?search_query=all:test')

    expect(result).toEqual({ ok: false, error: 'HTTP 503 Service Unavailable' })
    expect(cancelled).toBe(true)
    fetchSpy.mockRestore()
  })

  it('does not throw when a non-ok response has no body to cancel', async () => {
    const stubResponse = { ok: false, status: 404, statusText: 'Not Found', body: null } as unknown as Response
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(stubResponse)

    const result = await fetchArxivFeed('https://export.arxiv.org/api/query?search_query=all:test')

    expect(result).toEqual({ ok: false, error: 'HTTP 404 Not Found' })
    fetchSpy.mockRestore()
  })

  it('reads the body on an ok response', async () => {
    const stubResponse = new Response('<feed>ok</feed>', { status: 200, headers: jsonHeaders })
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(stubResponse)

    const result = await fetchArxivFeed('https://export.arxiv.org/api/query?search_query=all:test')

    expect(result).toEqual({ ok: true, text: '<feed>ok</feed>' })
    fetchSpy.mockRestore()
  })
})
