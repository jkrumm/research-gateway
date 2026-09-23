import { describe, it, expect } from 'bun:test'
import { readBoundedBytes, readBoundedText, readCappedText, type OversizedInfo } from './bounded-read.js'

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

  it('short-circuits on a declared content-length over the cap, pulling no bytes', async () => {
    const res = new Response(textStream(['never read']), { headers: { 'content-length': '1000' } })
    const { text, truncated } = await readBoundedText(res, 10)
    expect(truncated).toBe(true)
    expect(text).toBe('')
  })

  it('ignores a content-length at or under the cap and reads normally', async () => {
    const res = new Response(textStream(['hi']), { headers: { 'content-length': '2' } })
    const { text, truncated } = await readBoundedText(res, 2)
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
    expect(calls).toEqual([{ capBytes: 11, readBytes: 17 }])
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
