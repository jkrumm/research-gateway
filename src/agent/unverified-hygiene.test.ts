import { describe, expect, it } from 'bun:test'
import { tidyUnverified, type HygieneContext } from './unverified-hygiene.js'
import type { UnverifiedEntry } from './schema.js'

const entry = (topic: string, url: string | null, reason: string): UnverifiedEntry => ({ topic, url, reason })
const ctx = (over: Partial<HygieneContext> = {}): HygieneContext => ({
  isMissing: () => false,
  inProse: () => false,
  protectedUrls: new Set(),
  ...over,
})

describe('tidyUnverified', () => {
  it('drops a guessed URL the origin answered 404 for', () => {
    const e = entry('Tarmac SL8 page', 'https://specialized.com/guess', 'HTTP 404 — the resource does not exist at this URL')
    expect(tidyUnverified([e], ctx())).toEqual([])
    expect(tidyUnverified([entry('x', 'https://a.example/b', 'fetch failed')], ctx({ isMissing: () => true }))).toEqual([])
  })

  it('drops page-text budget housekeeping', () => {
    const e = entry('Remaining pages', null, "This worker's page-text budget is spent")
    expect(tidyUnverified([e], ctx())).toEqual([])
  })

  it('keeps a noise entry the prose depends on', () => {
    const e = entry('Spec page', 'https://a.example/spec', 'HTTP 404')
    expect(tidyUnverified([e], ctx({ inProse: () => true }))).toEqual([e])
  })

  it('keeps an entry restating a dropped citation', () => {
    const e = entry('Claim', 'https://a.example/spec', 'HTTP 404')
    expect(tidyUnverified([e], ctx({ protectedUrls: new Set(['https://a.example/spec']) }))).toEqual([e])
  })

  it('keeps real failures and groups them by topic, stably', () => {
    const a1 = entry('Pricing', 'https://a.example/1', 'blocked')
    const b = entry('Specs', 'https://b.example/', 'blocked')
    const a2 = entry('pricing', null, 'could not compare')
    expect(tidyUnverified([a1, b, a2], ctx())).toEqual([a1, a2, b])
  })
})
