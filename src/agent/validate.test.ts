import { describe, it, expect } from 'bun:test'
import {
  badDockerName,
  badPackageName,
  badPath,
  badRepoArg,
  escapeGoModulePath,
  rerankByName,
  resolveDockerName,
} from './validate.js'

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

describe('escapeGoModulePath', () => {
  it('passes through a path with no uppercase at all', () => {
    expect(escapeGoModulePath('github.com/gin-gonic/gin')).toBe('github.com/gin-gonic/gin')
  })

  it('escapes a single uppercase letter — the measured proxy.golang.org case', () => {
    expect(escapeGoModulePath('github.com/Masterminds/semver/v3')).toBe('github.com/!masterminds/semver/v3')
  })

  it('escapes every uppercase letter in an all-uppercase path', () => {
    expect(escapeGoModulePath('GITHUB.COM/FOO/BAR')).toBe('!g!i!t!h!u!b.!c!o!m/!f!o!o/!b!a!r')
  })

  it('leaves a lowercase /vN suffix alone', () => {
    expect(escapeGoModulePath('github.com/Masterminds/semver/v3')).toContain('/v3')
  })
})

describe('badDockerName', () => {
  it('accepts a bare official-image name and an explicit namespace/repo', () => {
    expect(badDockerName('postgres')).toBeNull()
    expect(badDockerName('grafana/grafana')).toBeNull()
    expect(badDockerName('my-org.internal/my_repo-1')).toBeNull()
  })

  it('rejects empty names, uppercase, registry-prefixed paths and traversal', () => {
    expect(badDockerName('')).not.toBeNull()
    expect(badDockerName('Postgres')).not.toBeNull()
    expect(badDockerName('quay.io/grafana/grafana')).not.toBeNull()
    expect(badDockerName('grafana/')).not.toBeNull()
    expect(badDockerName('../etc')).not.toBeNull()
  })
})

describe('resolveDockerName', () => {
  it('maps a bare name to the library namespace and the official-image page', () => {
    expect(resolveDockerName('postgres')).toEqual({
      namespace: 'library',
      repo: 'postgres',
      pageUrl: 'https://hub.docker.com/_/postgres',
    })
  })

  it('maps an explicit namespace/repo to the user-image page', () => {
    expect(resolveDockerName('grafana/grafana')).toEqual({
      namespace: 'grafana',
      repo: 'grafana',
      pageUrl: 'https://hub.docker.com/r/grafana/grafana',
    })
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
