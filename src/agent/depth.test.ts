import { describe, it, expect } from 'bun:test'
import { profiles } from './depth.js'

// Agent workers have no step/turn limit and no wall-clock ceiling (settled 2026-09-12) — depth
// is a breadth setting only. This is a regression guard against a time field creeping back in.
const TIME_FIELD_PATTERN = /timeout|deadline|maxsteps/i

describe('depth profiles', () => {
  it('carry no time or step-count fields', () => {
    for (const [depth, profile] of Object.entries(profiles)) {
      for (const key of Object.keys(profile)) {
        expect(key, `${depth}.${key} looks like a time/step ceiling`).not.toMatch(TIME_FIELD_PATTERN)
      }
    }
  })

  it('still define the breadth knobs every profile needs', () => {
    for (const profile of Object.values(profiles)) {
      expect(profile.workers).toBeGreaterThan(0)
      expect(profile.rounds).toBeGreaterThan(0)
      expect(profile.maxSearchResults).toBeGreaterThan(0)
      expect(profile.maxSearches).toBeGreaterThan(0)
      expect(typeof profile.directive).toBe('string')
      expect(profile.directive.length).toBeGreaterThan(0)
    }
  })

  it('scales breadth across quick < standard < deep', () => {
    expect(profiles.quick.workers).toBeLessThan(profiles.standard.workers)
    expect(profiles.standard.workers).toBeLessThan(profiles.deep.workers)
    expect(profiles.quick.maxSearchResults).toBeLessThan(profiles.standard.maxSearchResults)
    expect(profiles.standard.maxSearchResults).toBeLessThan(profiles.deep.maxSearchResults)
  })
})
