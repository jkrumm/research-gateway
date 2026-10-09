import { describe, it, expect } from 'bun:test'
import {
  readBoundedBytes,
  readBoundedBytesByCap,
  readBoundedText,
  readBoundedLines,
  readCappedText,
  type OversizedInfo,
} from './bounded-read.js'

function byteStream(chunks: number[][]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk))
      controller.close()
    },
  })
}

function textStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return byteStream(chunks.map((c) => Array.from(encoder.encode(c))))
}

describe('readBoundedBytes', () => {
  it('concatenates chunks under the cap', async () => {
    const { bytes, truncated } = await readBoundedBytes(byteStream([[1, 2], [3, 4, 5]]), 100)
    expect(truncated).toBe(false)
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4, 5])
  })

  it('keeps the bytes already read when a body is cut, rather than discarding them', async () => {
    const { bytes, truncated } = await readBoundedBytes(byteStream([[1, 2, 3], [4, 5, 6]]), 4)
    expect(truncated).toBe(true)
    expect(Array.from(bytes)).toEqual([1, 2, 3])
  })

  it('is exact at the boundary — total === cap is not truncated', async () => {
    const { truncated } = await readBoundedBytes(byteStream([[1, 2, 3, 4]]), 4)
    expect(truncated).toBe(false)
  })

  it('returns empty, untruncated bytes for a null body', async () => {
    const { bytes, truncated } = await readBoundedBytes(null, 100)
    expect(truncated).toBe(false)
    expect(bytes.length).toBe(0)
  })

  it('releases the stream lock on every path', async () => {
    const under = byteStream([[1, 2]])
    await readBoundedBytes(under, 100)
    expect(under.locked).toBe(false)

    const cut = byteStream([[1, 2, 3], [4, 5, 6]])
    await readBoundedBytes(cut, 2)
    expect(cut.locked).toBe(false)
  })
})

describe('readBoundedBytesByCap', () => {
  it('re-decides the cap from the buffered prefix when it is too large for the base cap', async () => {
    // The origin case: the prefix announces a PDF, so the cap chosen from it is far above the
    // 4-byte base cap the chooser would otherwise apply — the whole body is read.
    const { bytes, truncated, cap } = await readBoundedBytesByCap(
      byteStream([[1, 2, 3], [4, 5, 6]]),
      (prefix) => (prefix[0] === 1 ? 100 : 4),
    )
    expect(truncated).toBe(false)
    expect(cap).toBe(100)
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('cuts at the chosen cap, keeping the partial bytes', async () => {
    const { bytes, truncated, cap } = await readBoundedBytesByCap(byteStream([[7, 8, 9], [10, 11]]), () => 3)
    expect(truncated).toBe(true)
    expect(cap).toBe(3)
    expect(Array.from(bytes)).toEqual([7, 8, 9])
  })

  it('does not decide the cap on a single sub-prefix-sized first chunk — a mislabeled body delivered one byte per chunk still gets the right cap', async () => {
    // Delivers 16 one-byte chunks that spell a PDF magic, then a run past MAX_BODY_BYTES worth
    // of filler as a second, single big chunk. The first chunk alone is far short of the 8-byte
    // decision prefix, so a chooser keyed on "first chunk only" would see a single 0x25 byte and
    // guess wrong; keyed on the buffered prefix it sees the whole magic and picks the high cap.
    const magic = Array.from(new TextEncoder().encode('%PDF-1.7'))
    const chunks = magic.map((byte) => [byte])
    const filler = new Uint8Array(20).fill(0x20)
    const { truncated, cap } = await readBoundedBytesByCap(byteStream([...chunks, Array.from(filler)]), (prefix) =>
      prefix.length >= 8 && prefix[0] === 0x25 ? 1000 : 4,
    )
    expect(cap).toBe(1000)
    expect(truncated).toBe(false)
  })
})

describe('readBoundedText', () => {
  it('decodes the whole body when it stays under the cap', async () => {
    const res = new Response(textStream(['hello', ' world']), {})
    const { text, truncated } = await readBoundedText(res, 100)
    expect(truncated).toBe(false)
    expect(text).toBe('hello world')
  })

  it('keeps partial text when a body is cut mid-stream', async () => {
    const res = new Response(textStream(['hello', ' world', ' extra']), {})
    const { text, truncated } = await readBoundedText(res, 11)
    expect(truncated).toBe(true)
    expect(text).toBe('hello world')
  })

  it('never trusts a content-length header — an over-stated one does not turn a readable body into a miss', async () => {
    // An origin can lie in either direction; the streaming cap is what bounds the read, not the
    // header, so a body that is actually small still reads in full even under a wildly
    // over-stated content-length.
    const res = new Response(textStream(['hi']), { headers: { 'content-length': '1000' } })
    const { text, truncated } = await readBoundedText(res, 100)
    expect(truncated).toBe(false)
    expect(text).toBe('hi')
  })

  it('returns empty, untruncated text for a bodyless response', async () => {
    const { text, truncated } = await readBoundedText(new Response(null, { status: 204 }), 100)
    expect(truncated).toBe(false)
    expect(text).toBe('')
  })

  it('reports the numbers to onOversized the moment the cap trips', async () => {
    const calls: OversizedInfo[] = []
    const res = new Response(textStream(['hello', ' world', ' extra']), {})
    await readBoundedText(res, 11, (info) => calls.push(info))
    expect(calls).toEqual([{ capBytes: 11, readBytes: 11 }])
  })

  it('releases the stream lock on every path', async () => {
    const res = new Response(textStream(['hello', ' world']), {})
    await readBoundedText(res, 100)
    expect(res.body?.locked).toBe(false)
  })
})

describe('readCappedText', () => {
  it('decodes a stream up to the cap and drops the rest', async () => {
    const text = await readCappedText(textStream(['hello', ' world', ' extra']), 11)
    expect(text).toBe('hello world')
  })

  it('returns an empty string for a null stream', async () => {
    const text = await readCappedText(null, 100)
    expect(text).toBe('')
  })
})

// A synthetic CSV stream that is never held whole: 'country,year,co2' then one row per call to pull().
function csvStream(rows: number, rowFor: (i: number) => string, chunkRows = 500): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let i = -1
  return new ReadableStream({
    pull(controller) {
      const lines: string[] = []
      for (let n = 0; n < chunkRows && i < rows; n++, i++) lines.push(i < 0 ? 'country,year,co2' : rowFor(i))
      if (lines.length === 0) return controller.close()
      controller.enqueue(encoder.encode(`${lines.join('\n')}\n`))
    },
  })
}

describe('readBoundedLines', () => {
  it('keeps the header and matching lines of a 20 MB stream without buffering it', async () => {
    const pad = 'x'.repeat(80)
    const rows = 200_000 // ~20 MB
    const r = await readBoundedLines(csvStream(rows, (i) => `${i % 100 === 7 ? 'Germany' : 'Other'},${1800 + (i % 220)},${pad}`), {
      isMatch: (l) => l.startsWith('Germany'),
      keepChars: 80_000,
    })
    expect(r.header).toBe('country,year,co2')
    expect(r.searched).toBe(rows)
    expect(r.matched).toBe(2000)
    expect(r.matches.every((l) => l.startsWith('Germany'))).toBe(true)
    expect(r.matches.join('\n').length).toBeLessThanOrEqual(40_000)
    expect([...r.matches, ...r.tail].reduce((n, l) => n + l.length + 1, 0)).toBeLessThanOrEqual(80_000)
    expect(r.matches.length + r.tail.length).toBeLessThan(r.matched) // the middle was counted, not stored
    expect(r.stoppedAtBytes).toBeUndefined()
  })

  it('keeps the LAST matches in a ring bounded by the cap, not by the match count', async () => {
    const rows = 50_000
    const r = await readBoundedLines(csvStream(rows, (i) => `Germany,${i},${'y'.repeat(100)}`), { isMatch: () => true, keepChars: 10_000 })
    expect(r.matched).toBe(rows)
    expect(r.matches[0]).toStartWith('Germany,0,')
    expect(r.tail.at(-1)).toStartWith(`Germany,${rows - 1},`)
    expect([...r.matches, ...r.tail].reduce((n, l) => n + l.length + 1, 0)).toBeLessThanOrEqual(10_000)
    expect(r.matches.reduce((n, l) => n + l.length + 1, 0)).toBeLessThanOrEqual(5_000)
    // The ring is contiguous and in order up to the final line.
    const ids = r.tail.map((l) => Number(l.split(',')[1]))
    expect(ids).toEqual(ids.map((_, i) => rows - ids.length + i))
  })

  it('puts matches that do not fit the head into the ring, so a file that fits the cap loses nothing', async () => {
    const r = await readBoundedLines(textStream(['h\n', ...Array.from({ length: 10 }, (_, i) => `Germany,${i}\n`)]), {
      isMatch: () => true,
      keepChars: 100,
    })
    expect([...r.matches, ...r.tail]).toEqual(Array.from({ length: 10 }, (_, i) => `Germany,${i}`))
  })

  it('keeps a single matching line wider than the head half but within the budget', async () => {
    const big = `Germany,${'y'.repeat(700)}`
    const r = await readBoundedLines(textStream(['h\n', `${big}\n`, 'France,1\n']), { isMatch: (l) => l.startsWith('Germany'), keepChars: 1_000 })
    expect(r.matches).toEqual([big])
    expect(r.matched).toBe(1)
  })

  it('never holds more than the budget in head and ring together', async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `Germany,${i},${'y'.repeat(60)}\n`)
    const r = await readBoundedLines(textStream(['h\n', ...lines]), { isMatch: () => true, keepChars: (header) => 1_000 + header.length - 1 })
    const cost = [...r.matches, ...r.tail].reduce((n, l) => n + l.length + 1, 0)
    expect(cost).toBeLessThanOrEqual(1_000)
    expect(r.tail.at(-1)).toStartWith('Germany,49,')
  })

  it('stops at the ceiling and reports it', async () => {
    const r = await readBoundedLines(csvStream(100_000, (i) => `Germany,${i},${'y'.repeat(100)}`), {
      isMatch: () => true,
      keepChars: 1_000,
      ceilingBytes: 1_000_000,
    })
    expect(r.stoppedAtBytes).toBeGreaterThanOrEqual(1_000_000)
    expect(r.searched).toBeLessThan(100_000)
  })

  it('handles lines split across chunks, CRLF, and a last line without a newline', async () => {
    const r = await readBoundedLines(textStream(['a,b\r\nGer', 'many,1\r\nFrance,2\r\nGermany,', '3']), {
      isMatch: (l) => l.startsWith('Germany'),
      keepChars: 1_000,
    })
    expect(r.header).toBe('a,b')
    expect(r.matches).toEqual(['Germany,1', 'Germany,3'])
    expect(r.searched).toBe(3)
  })

  it('does not buffer a body with no newline at all', async () => {
    const r = await readBoundedLines(textStream(['h\n', 'z'.repeat(1_500_000), 'z'.repeat(1_500_000), '\nGermany\n']), {
      isMatch: (l) => l === 'Germany',
      keepChars: 100,
    })
    expect(r.matches).toEqual(['Germany'])
    expect(r.searched).toBe(2)
  })

  it('returns an empty result for a null body', async () => {
    const r = await readBoundedLines(null, { isMatch: () => true, keepChars: 10 })
    expect(r).toEqual({ header: '', matches: [], tail: [], matched: 0, searched: 0 })
  })
})
