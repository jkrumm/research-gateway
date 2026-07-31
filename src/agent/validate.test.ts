import { describe, it, expect } from 'bun:test'
import { badPackageName, badPath, badRepoArg, rerankByName } from './validate.js'

describe('badRepoArg', () => {
  it('accepts ordinary owner/repo and a release tag', () => {
    expect(badRepoArg('immich-app', 'immich', 'v3.1.0')).toBeNull()
    expect(badRepoArg('immich-app', 'immich')).toBeNull()
    expect(badRepoArg('a', 'b', 'release/2.0')).toBeNull()
  })

  it('rejects anything that could escape the URL segment', () => {
    expect(badRepoArg('../etc', 'immich')).not.toBeNull()
    expect(badRepoArg('owner', 'repo?x=1')).not.toBeNull()
    expect(badRepoArg('owner', 'repo', '../../secrets')).not.toBeNull()
    expect(badRepoArg('owner', 'repo', 'a/../b')).not.toBeNull()
    expect(badRepoArg('', 'repo')).not.toBeNull()
  })
})

describe('badPath', () => {
  it('accepts a repo-relative path', () => {
    expect(badPath('docker/docker-compose.yml')).toBeNull()
    expect(badPath('README.md')).toBeNull()
  })

  it('rejects traversal, absolute paths and empties', () => {
    expect(badPath('')).not.toBeNull()
    expect(badPath('/etc/passwd')).not.toBeNull()
    expect(badPath('docker/../../../etc/passwd')).not.toBeNull()
  })

  it('allows a dot inside a filename — ".." only matters as a whole segment', () => {
    expect(badPath('src/file..name.ts')).toBeNull()
  })
})

describe('badPackageName', () => {
  it('accepts plain and scoped names', () => {
    expect(badPackageName('elysia')).toBeNull()
    expect(badPackageName('@ai-sdk/openai-compatible')).toBeNull()
    expect(badPackageName('httpx')).toBeNull()
  })

  it('rejects traversal, whitespace, empties and over-deep scopes', () => {
    expect(badPackageName('')).not.toBeNull()
    expect(badPackageName('../../etc')).not.toBeNull()
    expect(badPackageName('two words')).not.toBeNull()
    expect(badPackageName('@scope/name/extra')).not.toBeNull()
    expect(badPackageName('@scope/')).not.toBeNull()
    expect(badPackageName('.hidden')).not.toBeNull()
  })
})

describe('rerankByName', () => {
  const names = (items: string[], query: string): string[] => rerankByName(query, items, (n) => n)

  // The live case: npm's own relevance put @vee-validate/zod above zod for this query.
  it('puts an exactly-named package above a scoped package that merely contains the name', () => {
    expect(names(['@vee-validate/zod', 'zod', 'monaco-liquid'], 'zod schema validation')).toEqual([
      'zod',
      '@vee-validate/zod',
      'monaco-liquid',
    ])
  })

  it('preserves the registry ordering within a tier — it re-ranks, it does not re-sort', () => {
    expect(names(['elysia-rate-limit', 'elysia-ip', 'elysia'], 'elysia bun web framework')).toEqual([
      'elysia',
      'elysia-rate-limit',
      'elysia-ip',
    ])
  })

  it('leaves the order alone when nothing in the query names anything', () => {
    expect(names(['a-tool', 'b-tool'], 'something entirely unrelated')).toEqual(['a-tool', 'b-tool'])
  })

  it('is total on empty input', () => {
    expect(names([], 'zod')).toEqual([])
    expect(names(['zod'], '')).toEqual(['zod'])
  })
})
