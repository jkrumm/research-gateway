import { expect, test } from 'bun:test'
import { clearJobOutcomes, noteJobOutcome, readJobOutcomes } from './job-outcomes.js'

test('tallies per job and clears', () => {
  noteJobOutcome('j1', 'worker.salvaged')
  noteJobOutcome('j1', 'worker.salvaged')
  noteJobOutcome('j1', 'human.browser')
  noteJobOutcome('j2', 'worker.salvaged')
  expect(readJobOutcomes('j1')).toEqual({ 'worker.salvaged': 2, 'human.browser': 1 })
  clearJobOutcomes('j1')
  expect(readJobOutcomes('j1')).toEqual({})
  expect(readJobOutcomes('j2')).toEqual({ 'worker.salvaged': 1 })
  clearJobOutcomes('j2')
})

test('the anonymous job id is never tallied', () => {
  noteJobOutcome('-', 'worker.salvaged')
  expect(readJobOutcomes('-')).toEqual({})
})

test('the registry is bounded: the oldest job is evicted past the cap', () => {
  for (let i = 0; i < 205; i++) noteJobOutcome(`cap-${i}`, 'consistency.failed')
  expect(readJobOutcomes('cap-0')).toEqual({})
  expect(readJobOutcomes('cap-204')).toEqual({ 'consistency.failed': 1 })
  for (let i = 0; i < 205; i++) clearJobOutcomes(`cap-${i}`)
})
