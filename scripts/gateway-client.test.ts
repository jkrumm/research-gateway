import { describe, it, expect } from 'bun:test'
import { flagGetter, runJob, runPool } from './gateway-client.js'

describe('flagGetter', () => {
  it('returns undefined for an absent flag', () => {
    expect(flagGetter(['--a', '1'])('--b')).toBeUndefined()
  })
  it('takes the first occurrence of a repeated flag', () => {
    expect(flagGetter(['--a', '1', '--a', '2'])('--a')).toBe('1')
  })
  it('returns undefined when the flag is the last token', () => {
    expect(flagGetter(['--a', '1', '--b'])('--b')).toBeUndefined()
  })
})

describe('runPool', () => {
  it('runs every index exactly once', async () => {
    const seen: number[] = []
    await runPool(7, 3, async (i) => {
      seen.push(i)
    })
    expect(seen.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6])
  })
  it('never exceeds the concurrency cap', async () => {
    let active = 0
    let peak = 0
    await runPool(10, 3, async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 2))
      active--
    })
    expect(peak).toBe(3)
  })
  it('does nothing for total=0', async () => {
    let calls = 0
    await runPool(0, 4, async () => {
      calls++
    })
    expect(calls).toBe(0)
  })
})

describe('runJob', () => {
  const base = { baseUrl: 'http://gw', secret: 's', query: 'q', depth: 'quick', pollMs: 0 } as const
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

  // Serves the submit response first, then each poll response in order.
  function script(...responses: Array<Response | Error>) {
    const queue = [...responses]
    const urls: string[] = []
    const fetchFn = async (input: string) => {
      urls.push(input)
      const next = queue.shift()
      if (next === undefined) throw new Error('unexpected extra fetch')
      if (next instanceof Error) throw next
      return next
    }
    return { fetchFn, urls }
  }

  it('returns ok:false when the submit is rejected by the server', async () => {
    const { fetchFn } = script(new Response('busy', { status: 429 }))
    expect(await runJob({ ...base, fetchFn })).toEqual({ ok: false, error: 'submit 429: busy' })
  })
  it('returns ok:false when a poll is rejected by the server', async () => {
    const { fetchFn } = script(json({ jobId: 'j1' }), new Response('', { status: 404 }))
    expect(await runJob({ ...base, fetchFn })).toEqual({ ok: false, error: 'poll 404' })
  })
  it('returns ok:false instead of throwing on a rejected submit fetch', async () => {
    const { fetchFn } = script(new Error('ECONNREFUSED'))
    expect(await runJob({ ...base, fetchFn })).toEqual({ ok: false, error: 'ECONNREFUSED' })
  })
  it('returns ok:false instead of throwing on a rejected poll fetch', async () => {
    const { fetchFn } = script(json({ jobId: 'j1' }), new Error('socket hang up'))
    expect(await runJob({ ...base, fetchFn })).toEqual({ ok: false, error: 'socket hang up' })
  })
  it('surfaces the job error on an error status', async () => {
    const { fetchFn } = script(json({ jobId: 'j1' }), json({ status: 'error', error: 'boom' }))
    expect(await runJob({ ...base, fetchFn })).toEqual({ ok: false, error: 'boom' })
  })
  it('ends the loop on a cancelled job with an error', async () => {
    const { fetchFn } = script(json({ jobId: 'j1' }), json({ status: 'running' }), json({ status: 'cancelled' }))
    expect(await runJob({ ...base, fetchFn })).toEqual({ ok: false, error: 'job cancelled' })
  })
  it('keeps polling until done and returns the result', async () => {
    const { fetchFn, urls } = script(
      json({ jobId: 'j1' }),
      json({ status: 'queued' }),
      json({ status: 'running' }),
      json({ status: 'done', result: { report: 'hi' } }),
    )
    expect(await runJob({ ...base, fetchFn })).toEqual({ ok: true, result: { report: 'hi' } })
    expect(urls).toEqual(['http://gw/research', 'http://gw/research/j1', 'http://gw/research/j1', 'http://gw/research/j1'])
  })
})
