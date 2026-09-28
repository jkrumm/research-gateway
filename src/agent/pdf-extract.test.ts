import { describe, it, expect } from 'bun:test'
import { mapPdftotextResult, pdfTruncationNotice, finalizePdfText, readIdleCapped, MIN_PDF_TEXT_CHARS } from './pdf-extract.js'
import { createIdleWatchdog } from '../lib/idle-watchdog.js'
import { TEXT_CAP } from './extract.js'

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

  // pdf.ts kills the (now-useless) child once the byte cap is crossed, so the child can die by
  // signal on the very same exit that produced a genuine, complete-up-to-the-cap partial text.
  // Truncation must win over `signalCode` — this must stay `ok:true, truncated:true`, never the
  // idle-kill failure branch.
  it('reports ok:true truncated:true even when the cap-crossing kill left a signalCode', () => {
    const result = mapPdftotextResult({
      signalCode: 'SIGKILL',
      code: 0,
      stdout: longText,
      stderr: '',
      idleMs: 60_000,
      stdoutTruncated: true,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.truncated).toBe(true)
    expect(result.text.length).toBeGreaterThan(0)
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

describe('finalizePdfText', () => {
  it('returns the text unchanged when pdftotext was not truncated', () => {
    expect(finalizePdfText('hello world', false)).toBe('hello world')
  })

  // The bug this guards: a truncated pdftotext output is, by construction, far longer than
  // TEXT_CAP (pdftotext's own output cap is 80 MB; TEXT_CAP is 80k chars) — appending the
  // notice to the end and letting a LATER capText(TEXT_CAP) run over the combined string sliced
  // the notice off entirely. Simulates a full `mapPdftotextResult({ ..., stdoutTruncated: true
  // })` output reaching this function, as origin.ts's PDF branch does.
  it('caps a truncated extraction so the notice survives, rather than being sliced off by a downstream TEXT_CAP', () => {
    const longText = 'x'.repeat(TEXT_CAP * 2) // stands in for a truncated pdftotext output far past TEXT_CAP
    const result = mapPdftotextResult({ signalCode: null, code: 0, stdout: longText, stderr: '', idleMs: 60_000, stdoutTruncated: true })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')

    const finalText = finalizePdfText(result.text, result.truncated)
    // The notice is present AND is not cut off partway through — both would be true of the bug
    // this guards if the notice were appended before a downstream cap ran, or if it were cut
    // mid-string here.
    expect(finalText).toContain(pdfTruncationNotice())
    expect(finalText.endsWith(pdfTruncationNotice())).toBe(true)
    // Already at or under TEXT_CAP — a downstream capText(TEXT_CAP) is a no-op on this output,
    // which is the whole point: nothing past this function may truncate it again.
    expect(finalText.length).toBeLessThanOrEqual(TEXT_CAP)
  })

  it('keeps the notice intact even when the source text is shorter than TEXT_CAP', () => {
    const finalText = finalizePdfText('short paper text', true)
    expect(finalText).toBe(`short paper text${pdfTruncationNotice()}`)
  })
})

describe('readIdleCapped', () => {
  it('returns the whole decoded body when nothing crosses the cap or goes idle', async () => {
    const watchdog = createIdleWatchdog(10_000)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('hello '))
        controller.enqueue(new TextEncoder().encode('world'))
        controller.close()
      },
    })
    watchdog.arm()
    const result = await readIdleCapped(stream, 1_000, watchdog)
    expect(result).toEqual({ text: 'hello world', truncated: false })
    watchdog.clear()
  })

  // A chunk landing exactly on the cap boundary: only the part that still fits is kept, the
  // rest discarded — not the whole chunk.
  it('keeps only the part of a chunk that fits when it straddles the byte cap', async () => {
    const watchdog = createIdleWatchdog(10_000)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('0123456789'))
        controller.close()
      },
    })
    watchdog.arm()
    const result = await readIdleCapped(stream, 5, watchdog)
    expect(result).toEqual({ text: '01234', truncated: true })
    watchdog.clear()
  })

  // The bug this guards: an idle abort firing while `reader.read()` is still pending must not
  // let `reader.releaseLock()` throw a TypeError over the designed `{ text, truncated: true }`
  // return — it must return normally with whatever was read before the stall. Driven off the
  // watchdog's job-signal escape hatch rather than a real idle timer, so the abort fires on a
  // deterministic tick instead of a wall-clock wait.
  it('returns truncated text instead of throwing when the idle watchdog aborts mid-read', async () => {
    const job = new AbortController()
    const watchdog = createIdleWatchdog(10_000, job.signal)
    let pullCount = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount++
        if (pullCount === 1) {
          controller.enqueue(new TextEncoder().encode('partial'))
          return
        }
        // Simulates a stalled subprocess: this read never settles on its own — only the
        // idle abort below unblocks it.
        return new Promise<void>(() => {})
      },
    })
    watchdog.arm()
    const resultPromise = readIdleCapped(stream, 1_000, watchdog)
    // Let the first chunk land (and the second, stalled `read()` begin) before the abort fires.
    await new Promise((resolve) => setTimeout(resolve, 5))
    job.abort(new Error('idle'))
    const result = await resultPromise
    expect(result).toEqual({ text: 'partial', truncated: true })
    watchdog.clear()
  })

  it('returns an empty, non-truncated result for a null stream', async () => {
    const watchdog = createIdleWatchdog(10_000)
    const result = await readIdleCapped(null, 1_000, watchdog)
    expect(result).toEqual({ text: '', truncated: false })
    watchdog.clear()
  })
})
