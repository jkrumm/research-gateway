import { describe, it, expect } from 'bun:test'
import { toLogAttributes, severityFor } from './otel-format.js'

describe('toLogAttributes', () => {
  it('passes strings, numbers, and booleans through unchanged', () => {
    expect(toLogAttributes({ jobId: 'abc', chars: 123, ok: true })).toEqual({
      jobId: 'abc',
      chars: 123,
      ok: true,
    })
  })

  it('drops undefined fields entirely', () => {
    expect(toLogAttributes({ a: 1, b: undefined })).toEqual({ a: 1 })
  })

  it('JSON.stringifies objects and arrays rather than dropping them', () => {
    expect(toLogAttributes({ raw: { x: 1 }, list: [1, 2] })).toEqual({
      raw: '{"x":1}',
      list: '[1,2]',
    })
  })

  it('JSON.stringifies null rather than dropping it', () => {
    expect(toLogAttributes({ reason: null })).toEqual({ reason: 'null' })
  })

  it('returns an empty object for empty fields', () => {
    expect(toLogAttributes({})).toEqual({})
  })
})

describe('severityFor', () => {
  it('is error for an event name ending in .error', () => {
    expect(severityFor('job.error', {})).toBe('error')
    expect(severityFor('mcp.error', {})).toBe('error')
  })

  it('is error for an event name ending in .failed', () => {
    expect(severityFor('synthesis.failed', {})).toBe('error')
    expect(severityFor('worker.failed', { error: 'boom' })).toBe('error')
  })

  it('is error for the uncaught-exception / unhandled-rejection handlers', () => {
    expect(severityFor('process.uncaughtException', {})).toBe('error')
    expect(severityFor('process.unhandledRejection', {})).toBe('error')
  })

  it('is warn when fields carry a truthy error key, even without a matching event name', () => {
    expect(severityFor('tool.fetchPage', { error: 'HTTP 403' })).toBe('warn')
    expect(severityFor('tool.searchWeb', { error: 'search failed: timeout' })).toBe('warn')
  })

  it('is NOT warn when the error field is falsy', () => {
    expect(severityFor('tool.fetchPage', { error: '' })).toBe('info')
    expect(severityFor('tool.fetchPage', { error: undefined })).toBe('info')
    expect(severityFor('tool.fetchPage', {})).toBe('info')
  })

  it('is warn for an event ending in .rejected or .ungrounded', () => {
    expect(severityFor('synthesis.rejected', {})).toBe('warn')
    expect(severityFor('job.rejected', {})).toBe('warn')
    expect(severityFor('worker.ungrounded', {})).toBe('warn')
  })

  it('is info for ordinary lifecycle events', () => {
    expect(severityFor('research.start', {})).toBe('info')
    expect(severityFor('research.done', {})).toBe('info')
    expect(severityFor('job.created', {})).toBe('info')
    expect(severityFor('tool.fetchPage', { via: 'raw', chars: 500 })).toBe('info')
  })
})
