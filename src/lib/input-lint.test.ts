import { describe, it, expect } from 'bun:test'
import { inputWarnings } from './input-lint.js'

describe('inputWarnings', () => {
  it('flags the 2026-09-25 case: an unexpanded $(cat …) context', () => {
    const warnings = inputWarnings({ query: 'Wild Rift 7.3 item changes', context: '$(cat /tmp/wr73/context.md)' })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('`context`')
    expect(warnings[0]).toContain('$(…)')
  })

  it('flags backticks, bare and braced variables, and CLI @file syntax', () => {
    expect(inputWarnings({ query: 'q is fine', context: '`cat notes.md`' })).toHaveLength(1)
    expect(inputWarnings({ query: '$QUERY' })).toHaveLength(1)
    expect(inputWarnings({ query: 'q is fine', context: '${CONTEXT}' })).toHaveLength(1)
    expect(inputWarnings({ query: 'q is fine', context: '@/tmp/context.md' })).toHaveLength(1)
    expect(inputWarnings({ query: 'q is fine', context: '@./context.md' })).toHaveLength(1)
    expect(inputWarnings({ query: 'q is fine', context: '  @~/notes.md\n' })).toHaveLength(1)
  })

  it('reports each bad field separately', () => {
    expect(inputWarnings({ query: '$(echo q)', context: '@/tmp/c.md' })).toHaveLength(2)
  })

  it('leaves real text alone, including text that merely contains shell syntax', () => {
    expect(inputWarnings({ query: 'What does $(npm bin) return in npm 11?' })).toEqual([])
    expect(inputWarnings({ query: 'How do I use @tanstack/react-query v6?' })).toEqual([])
    expect(inputWarnings({ query: 'Is $HOME expanded in a launchd plist?', context: 'We run on macOS 26.' })).toEqual([])
    expect(inputWarnings({ query: 'q', context: undefined })).toEqual([])
  })
})
