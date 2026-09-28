import { describe, it, expect } from 'bun:test'
import {
  readBoundedBytes,
  readBoundedBytesByCap,
  readBoundedText,
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
