import { describe, it, expect } from 'bun:test'
import { mapPdftotextResult, pdfTruncationNotice, MIN_PDF_TEXT_CHARS } from './pdf-extract.js'

describe('mapPdftotextResult', () => {
  const longText = 'Attention Is All You Need. '.repeat(20) // > MIN_PDF_TEXT_CHARS

  it('maps a clean exit with real text to ok:true, not truncated', () => {
    const result = mapPdftotextResult({ signalCode: null, code: 0, stdout: longText, stderr: '', idleMs: 60_000 })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.text.length).toBeGreaterThanOrEqual(MIN_PDF_TEXT_CHARS)
    expect(result.truncated).toBe(false)
  })

  it('carries stdoutTruncated through as `truncated` on an otherwise-ok result', () => {
    const result = mapPdftotextResult({ signalCode: null, code: 0, stdout: longText, stderr: '', idleMs: 60_000, stdoutTruncated: true })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.truncated).toBe(true)
  })

  // The idle-watchdog kill — `signalCode` is the discriminator, not exit code, mirroring the
  // Bun trap ytdlp.ts documents (`proc.killed` is true on a clean exit too).
  it('treats a signalCode as an idle kill regardless of exit code', () => {
    const result = mapPdftotextResult({ signalCode: 'SIGKILL', code: 0, stdout: longText, stderr: '', idleMs: 60_000 })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toContain('no output for 60000ms')
  })

  it('maps a non-zero exit to a failure carrying the first stderr line', () => {
    const result = mapPdftotextResult({
      signalCode: null,
      code: 1,
      stdout: '',
      stderr: '\nSyntax Error: Couldn\'t find trailer dictionary\nmore detail',
      idleMs: 60_000,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toBe("Syntax Error: Couldn't find trailer dictionary")
  })

  it('falls back to a generic reason when stderr is empty', () => {
    const result = mapPdftotextResult({ signalCode: null, code: 2, stdout: '', stderr: '', idleMs: 60_000 })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toBe('pdftotext exited 2')
  })

  // A scanned PDF with no text layer: poppler exits 0 but produces (near-)nothing. Must FAIL
  // the step rather than succeed with a handful of stray glyphs — the chain falls through to
  // Tavily Extract, which OCRs server-side.
  it('treats a clean exit below the text floor as a miss, not a success', () => {
    const result = mapPdftotextResult({ signalCode: null, code: 0, stdout: '   \n\n  ', stderr: '', idleMs: 60_000 })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toContain('scanned/image PDF')
  })
})

describe('pdfTruncationNotice', () => {
  it('names the byte cap that was exceeded', () => {
    expect(pdfTruncationNotice(2_000_000)).toContain('2000000-byte output cap')
  })

  it('defaults to MAX_PDFTOTEXT_OUTPUT_BYTES when called with no argument', () => {
    expect(pdfTruncationNotice()).toContain('byte output cap')
  })
})
