import { expect, test } from 'bun:test'
import { classifyHumanResult } from './human-outcome.js'

const ok = (mode: 'solved' | 'cleared' | 'browser') => ({ ok: true as const, html: '', finalUrl: 'https://a.test/', mode })

test('browser success is not an escalation', () => {
  expect(classifyHumanResult(ok('browser'))).toEqual({ outcome: 'browser', escalated: false })
})

test('a dialog solve is solved + escalated', () => {
  expect(classifyHumanResult(ok('solved'))).toEqual({ outcome: 'solved', escalated: true })
})

test('suppression reasons are suppressed, never escalated', () => {
  for (const reason of ['solver unavailable', 'macbook unreachable', 'dialog rate limit', 'busy', 'chrome_unavailable', 'proxy_unavailable']) {
    expect(classifyHumanResult({ ok: false, reason })).toEqual({ outcome: 'suppressed', escalated: false, reason })
  }
})

test('a declined/timed-out dialog is abandoned + escalated; an abort is abandoned only', () => {
  expect(classifyHumanResult({ ok: false, reason: 'declined' })).toEqual({ outcome: 'abandoned', escalated: true, reason: 'declined' })
  expect(classifyHumanResult({ ok: false, reason: 'aborted' })).toEqual({ outcome: 'abandoned', escalated: false, reason: 'aborted' })
})

test('a timeout is abandoned but not an escalation (a browser-first attempt times out too)', () => {
  expect(classifyHumanResult({ ok: false, reason: 'timeout' })).toEqual({ outcome: 'abandoned', escalated: false, reason: 'timeout' })
})

test('a host-suppressed attempt is suppressed even though it carries a dialog reason', () => {
  expect(classifyHumanResult({ ok: false, reason: 'declined', suppressed: true })).toEqual({ outcome: 'suppressed', escalated: false, reason: 'declined' })
})
