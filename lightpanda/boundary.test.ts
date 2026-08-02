import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

// The sidecar and the gateway are two independently built images. `lightpanda/Dockerfile`
// copies ONLY this directory, and there is no bundler, so an import reaching into `src/` (or
// into node_modules) typechecks and tests clean — the root tsconfig covers both directories —
// and then fails at container start with "module not found". This is a build-boundary the type
// system cannot see, so it is asserted here instead.
//
// If the sidecar ever genuinely needs a dependency, the fix is to give it its own
// package.json + install step in its Dockerfile, not to relax this test.
describe('the sidecar is self-contained', () => {
  const sources = readdirSync(HERE).filter((f) => f.endsWith('.ts'))

  it('has sources to check', () => {
    expect(sources.length).toBeGreaterThan(0)
  })

  for (const file of sources) {
    it(`${file} imports nothing outside this directory`, () => {
      const body = readFileSync(join(HERE, file), 'utf8')
      const specifiers = [...body.matchAll(/(?:^|\s)(?:import|export)[^'"\n]*from\s*['"]([^'"]+)['"]/gm)].map(
        (m) => m[1]!,
      )

      for (const spec of specifiers) {
        // Node built-ins are fine — they need no install and exist in the image.
        if (spec.startsWith('node:') || spec === 'bun:test') continue
        expect(spec.startsWith('./')).toBe(true)
        expect(spec).not.toContain('..')
      }
    })
  }
})
