// Pure core of the golden-set answer-quality eval (see scripts/eval.ts and
// docs/measurements.md § Answer-quality eval (golden set)).
//
// Everything here runs without a network so `bun test` can pin the matcher and the
// resolver response parsing against hand-written fixtures. The fetch that turns a
// resolver into a value lives in scripts/eval.ts, at the boundary.

import type { Depth } from '../src/agent/schema.js'

// `any`: one pattern matching is enough (a single fact). `all`: every pattern must match
// (a multi-part query — one answered sub-question must not pass the whole item). `live`: the
// value a registry resolver returns at eval time.
export type GoldenExpect = { any: string[] } | { all: string[] } | { live: string }

export interface GoldenItem {
  id: string
  query: string
  depth: Depth
  expect: GoldenExpect
}

export interface MatchResult {
  pass: boolean
  /** The regex text that matched, or the live value that matched; null on a miss. */
  matched: string | null
}

// Case-insensitive on purpose: a report can write "retry-after" or "Retry-After", and a
// regex's own character classes handle the rest. A live value is matched as a literal
// substring, not a regex — a version like `4.6.5` must not be read as a pattern.
export function matchExpect(text: string, expect: GoldenExpect, liveValue: string | null): MatchResult {
  if ('live' in expect) {
    if (liveValue === null) return { pass: false, matched: null }
    const pass = text.toLowerCase().includes(liveValue.toLowerCase())
    return { pass, matched: pass ? liveValue : null }
  }
  if ('all' in expect) {
    const matches: string[] = []
    for (const pattern of expect.all) {
      const match = text.match(new RegExp(pattern, 'i'))
      if (!match) return { pass: false, matched: null }
      matches.push(match[0])
    }
    return { pass: true, matched: matches.join(' + ') }
  }
  for (const pattern of expect.any) {
    const match = text.match(new RegExp(pattern, 'i'))
    if (match) return { pass: true, matched: match[0] }
  }
  return { pass: false, matched: null }
}

// ── Live resolvers ────────────────────────────────────────────────────────────
//
// A resolver fetches the truth at eval time so a moving version never goes stale in the
// golden file. `resolverFor` builds the request (URL + headers); `parse` turns the
// response body into the literal the report must contain. Both halves are pure and tested
// with fixtures; only the fetch in scripts/eval.ts touches the network.

export interface LiveResolver {
  url: string
  headers: Record<string, string>
  parse: (body: unknown) => string
}

const USER_AGENT = 'research-gateway-eval'
const DEPTHS = new Set<string>(['quick', 'standard', 'deep'])

interface ResolverSpec {
  buildUrl: (target: string) => string
  parse: (body: unknown) => string
}

function readPath(body: unknown, path: string[]): unknown {
  let current: unknown = body
  for (const key of path) {
    if (current === null || typeof current !== 'object' || !(key in current)) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

function asString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Resolver response missing ${what}`)
  return value
}

// crates.io and GitHub both reject requests without a User-Agent; a resolver that forgets
// one fails with an opaque 403. GitHub additionally honours GITHUB_TOKEN when set.
const SPECS: Record<string, ResolverSpec> = {
  npm: {
    buildUrl: (target) => `https://registry.npmjs.org/${target}/latest`,
    parse: (body) => asString(readPath(body, ['version']), '`version`'),
  },
  pypi: {
    buildUrl: (target) => `https://pypi.org/pypi/${target}/json`,
    parse: (body) => asString(readPath(body, ['info', 'version']), '`info.version`'),
  },
  crates: {
    buildUrl: (target) => `https://crates.io/api/v1/crates/${target}`,
    parse: (body) => asString(readPath(body, ['crate', 'max_stable_version']), '`crate.max_stable_version`'),
  },
  'github-release': {
    buildUrl: (target) => `https://api.github.com/repos/${target}/releases/latest`,
    // Bun tags its releases `bun-v1.2.3`; other repos use `v1.2.3`. Strip either prefix so
    // the resolved value matches the bare version a report writes.
    parse: (body) => asString(readPath(body, ['tag_name']), '`tag_name`').replace(/^(?:bun-)?v/i, ''),
  },
}

export function resolverFor(name: string, githubToken?: string): LiveResolver {
  const sep = name.indexOf(':')
  if (sep <= 0 || sep === name.length - 1) {
    throw new Error(`Invalid live resolver "${name}" — expected "<scheme>:<target>"`)
  }
  const scheme = name.slice(0, sep)
  const target = name.slice(sep + 1)
  const spec = SPECS[scheme]
  if (!spec) {
    throw new Error(`Unknown live resolver scheme "${scheme}" in "${name}" — expected one of ${Object.keys(SPECS).join(', ')}`)
  }
  const headers: Record<string, string> = { 'User-Agent': USER_AGENT }
  if (scheme === 'github-release' && githubToken) headers['Authorization'] = `Bearer ${githubToken}`
  return { url: spec.buildUrl(target), headers, parse: spec.parse }
}

// ── Golden-file parsing ───────────────────────────────────────────────────────

const EXPECT_SHAPES = 'expect must be { any: string[] }, { all: string[] } or { live: string }'

function validatePatterns(value: unknown, line: number): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || !value.every((p) => typeof p === 'string')) return null
  for (const pattern of value) {
    try {
      new RegExp(pattern)
    } catch {
      throw new Error(`golden line ${line}: invalid regex ${JSON.stringify(pattern)}`)
    }
  }
  return value as string[]
}

function validateExpect(value: unknown, line: number): GoldenExpect {
  if (value === null || typeof value !== 'object') throw new Error(`golden line ${line}: ${EXPECT_SHAPES}`)
  const raw = value as Record<string, unknown>
  if (typeof raw['live'] === 'string' && raw['live'].length > 0) return { live: raw['live'] }
  const any = validatePatterns(raw['any'], line)
  if (any) return { any }
  const all = validatePatterns(raw['all'], line)
  if (all) return { all }
  throw new Error(`golden line ${line}: ${EXPECT_SHAPES}`)
}

function validateItem(raw: unknown, line: number): GoldenItem {
  if (raw === null || typeof raw !== 'object') throw new Error(`golden line ${line}: not a JSON object`)
  const item = raw as Record<string, unknown>
  const id = item['id']
  const query = item['query']
  const depth = item['depth']
  if (typeof id !== 'string' || id.length === 0) throw new Error(`golden line ${line}: id must be a non-empty string`)
  if (typeof query !== 'string' || query.length === 0) throw new Error(`golden line ${line}: query must be a non-empty string`)
  if (typeof depth !== 'string' || !DEPTHS.has(depth)) {
    throw new Error(`golden line ${line}: depth must be one of quick, standard, deep`)
  }
  return { id, query, depth: depth as Depth, expect: validateExpect(item['expect'], line) }
}

export function parseGolden(jsonl: string): GoldenItem[] {
  const items: GoldenItem[] = []
  jsonl.split('\n').forEach((line, i) => {
    const trimmed = line.trim()
    if (trimmed.length === 0) return
    let raw: unknown
    try {
      raw = JSON.parse(trimmed)
    } catch {
      throw new Error(`golden line ${i + 1}: invalid JSON`)
    }
    items.push(validateItem(raw, i + 1))
  })
  return items
}

// ── Per-depth aggregation ─────────────────────────────────────────────────────
//
// Wall time and the `partial` rate are properties of a depth, not of the whole set: a quick
// lookup finishes in seconds and a deep run in minutes, so one pooled p50 hides both.

export interface DepthRowInput {
  depth: Depth
  /** Report status ('ok' / 'partial'), or null when the job produced none. */
  status: string | null
  wallMs: number | null
}

export interface DepthSummary {
  depth: Depth
  /** Rows that produced a report. */
  completed: number
  partial: number
  /** partial / completed — a depth is only summarised once a row completed. */
  partialRate: number
  p50WallMs: number | null
  maxWallMs: number | null
}

const DEPTH_ORDER: Depth[] = ['quick', 'standard', 'deep']

/** Lower median — a measured run, never an interpolated one. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? null
}

/** One entry per depth that has at least one completed row, in quick/standard/deep order. */
export function summarizeByDepth(rows: DepthRowInput[]): DepthSummary[] {
  const summaries: DepthSummary[] = []
  for (const depth of DEPTH_ORDER) {
    const completed = rows.filter((row) => row.depth === depth && row.status !== null)
    if (completed.length === 0) continue
    const walls = completed.map((row) => row.wallMs).filter((wall): wall is number => wall !== null)
    const partial = completed.filter((row) => row.status === 'partial').length
    summaries.push({
      depth,
      completed: completed.length,
      partial,
      partialRate: partial / completed.length,
      p50WallMs: median(walls),
      maxWallMs: walls.length === 0 ? null : Math.max(...walls),
    })
  }
  return summaries
}
