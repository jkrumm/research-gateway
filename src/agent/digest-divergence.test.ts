import { describe, it, expect } from 'bun:test'
import { detectDigestDivergence, divergenceSummary } from './digest-divergence.js'
import type { WorkerDigest } from './schema.js'

function digest(subQuestion: string, summary: string, findings: Array<[string, string]> = []): WorkerDigest {
  return {
    subQuestion,
    summary,
    findings: findings.map(([claim, url]) => ({ claim, url, confidence: 'high' as const })),
    sourcesRead: [],
    openGaps: [],
    blockedSources: [],
  }
}

describe('detectDigestDivergence', () => {
  it('flags the same entity carrying different prices in two digests', () => {
    const result = detectDigestDivergence([
      digest('Pricing', 'x', [['The Acme Cloud Pro plan costs $12.99 per month for teams.', 'https://acme.example/pricing']]),
      digest('Plans', 'y', [['Acme Cloud Pro plan pricing is $15 per month for teams.', 'https://reviews.example/acme']]),
    ])
    expect(result.count).toBe(1)
    expect(result.signals[0]?.kind).toBe('currency')
    expect(result.signals[0]?.values).toEqual(['usd 12.99', 'usd 15'])
    expect(divergenceSummary(result)[0]).toContain('currency usd 12.99 vs usd 15')
  })

  it('flags a version mismatch across digests (v1.3 vs version 1.4)', () => {
    const result = detectDigestDivergence([
      digest('Latest', 'The current stable Frobnicator release is v1.3 according to the changelog.'),
      digest('Install', 'Install the stable Frobnicator release, currently version 1.4, with the package manager.'),
    ])
    expect(result.signals.map((s) => s.kind)).toContain('version')
  })

  it('flags differing dates for the same event', () => {
    const result = detectDigestDivergence([
      digest('History', 'x', [['The Orion Gateway project launched publicly on 2021-03-04 with early customers.', 'https://a.example/x']]),
      digest('Timeline', 'x', [['Orion Gateway project launched publicly on 2022-01-15 with early customers.', 'https://b.example/y']]),
    ])
    expect(result.signals.map((s) => s.kind)).toContain('date')
  })

  it('skips digests on disjoint topics even when both are full of numbers', () => {
    const result = detectDigestDivergence([
      digest('Rust', 'Rust 1.80 shipped in 2024 and the compiler builds 12000 crates nightly.', [
        ['Cargo registry hosts 150000 crates today.', 'https://crates.example/stats'],
      ]),
      digest('Coffee', 'Arabica beans cost $4.50 per pound in 2023 and roasters process 3000 kilograms weekly.', [
        ['Colombian harvest reached 14 million bags.', 'https://coffee.example/harvest'],
      ]),
    ])
    expect(result.count).toBe(0)
  })

  it('skips when both digests state the same numbers', () => {
    const result = detectDigestDivergence([
      digest('Pricing', 'x', [['The Acme Cloud Pro plan costs $12.99 per month for teams.', 'https://acme.example/pricing']]),
      digest('Plans', 'y', [['Acme Cloud Pro plan pricing is $12.99 per month for teams.', 'https://reviews.example/acme']]),
    ])
    expect(result.count).toBe(0)
  })

  it('does not compare different measures of the same subject (unit word is part of the kind)', () => {
    const result = detectDigestDivergence([
      digest('Perf', 'Acme Cloud Pro plan latency averages 200 ms for hosted teams.'),
      digest('Scale', 'Acme Cloud Pro plan serves 5000 customers across hosted teams.'),
    ])
    expect(result.count).toBe(0)
  })

  it('never flags contradictions inside one digest (not a cross-worker divergence)', () => {
    const result = detectDigestDivergence([
      digest('One', 'Acme Cloud Pro plan costs $12.99 per month. Acme Cloud Pro plan costs $15 per month.'),
      digest('Two', 'Unrelated notes about weather patterns.'),
    ])
    expect(result.count).toBe(0)
  })

  it('ignores URLs and tiny integers as numeric facts', () => {
    const result = detectDigestDivergence([
      digest('A', 'See https://example.com/v2/item/9912 for the Acme Cloud Pro plan top 3 features and details.'),
      digest('B', 'See https://example.com/v7/item/1234 for the Acme Cloud Pro plan top 5 features and details.'),
    ])
    expect(result.count).toBe(0)
  })

  it('counts a repeated divergence once', () => {
    const a = 'The Acme Cloud Pro plan costs $12.99 per month for teams.'
    const b = 'Acme Cloud Pro plan pricing is $15 per month for teams.'
    const result = detectDigestDivergence([digest('A', `${a} ${a}`), digest('B', `${b} ${b}`)])
    expect(result.count).toBe(1)
  })

  it('returns nothing for no digests', () => {
    expect(detectDigestDivergence([])).toEqual({ count: 0, signals: [] })
  })

  it('treats different denominations of the same amount as a divergence, and $ vs USD as equal', () => {
    const mixed = detectDigestDivergence([
      digest('A', 'x', [['The Acme Cloud Pro plan costs $100 per month for teams.', 'https://a.example/p']]),
      digest('B', 'y', [['Acme Cloud Pro plan pricing is 100 EUR per month for teams.', 'https://b.example/p']]),
    ])
    expect(mixed.signals.map((s) => s.kind)).toContain('currency')
    const same = detectDigestDivergence([
      digest('A', 'x', [['The Acme Cloud Pro plan costs $100 per month for teams.', 'https://a.example/p']]),
      digest('B', 'y', [['Acme Cloud Pro plan pricing is 100 USD per month for teams.', 'https://b.example/p']]),
    ])
    expect(same.count).toBe(0)
  })

  it('ignores bare years and unit-less numbers (release years, ids, model numbers)', () => {
    const result = detectDigestDivergence([
      digest('A', 'x', [['The Acme Frobnicator release shipped in 2025 as model 4427 on the stable channel.', 'https://a.example/x']]),
      digest('B', 'y', [['Acme Frobnicator release shipped in 2026 as model 105 on the stable channel.', 'https://b.example/y']]),
    ])
    expect(result.count).toBe(0)
  })
})
