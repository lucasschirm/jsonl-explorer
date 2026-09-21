import { describe, it, expect } from 'vitest'
import {
  FileSource,
  MemorySource,
  PayloadTooLargeError,
  SourceDisposedError,
} from '~/engine/sources/index.js'
import type { JsonlSource } from '~/engine/sources/index.js'

const encoder = new TextEncoder()
const SAMPLE_TEXT = 'line-one\nline-two\nline-three\n'
const SAMPLE_BYTES = encoder.encode(SAMPLE_TEXT)

function makeBlob(bytes: Uint8Array): Blob {
  return new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'application/x-ndjson' })
}

function makeFile(bytes: Uint8Array, name: string): File {
  return new File([bytes.slice().buffer as ArrayBuffer], name, { type: 'application/x-ndjson' })
}

describe('FileSource', () => {
  it('reports size as bigint', async () => {
    const source = new FileSource(makeBlob(SAMPLE_BYTES))
    expect(await source.getSize()).toBe(BigInt(SAMPLE_BYTES.byteLength))
  })

  it('uses the file name by default', () => {
    const source = new FileSource(makeFile(SAMPLE_BYTES, 'data.jsonl'))
    expect(source.name).toBe('data.jsonl')
  })

  it('uses an explicit name for unnamed blobs', () => {
    const source = new FileSource(makeBlob(SAMPLE_BYTES), 'pasted.jsonl')
    expect(source.name).toBe('pasted.jsonl')
  })

  it('reads the complete file from offset 0', async () => {
    const source = new FileSource(makeBlob(SAMPLE_BYTES))
    const all = await source.readRange(0, Number.MAX_SAFE_INTEGER)
    expect(new TextDecoder().decode(all)).toBe(SAMPLE_TEXT)
  })

  it('reads an exact middle range', async () => {
    const source = new FileSource(makeBlob(SAMPLE_BYTES))
    // "line-two" occupies bytes 9..16
    const chunk = await source.readRange(9, 8)
    expect(new TextDecoder().decode(chunk)).toBe('line-two')
  })

  it('clamps a range extending past end-of-file', async () => {
    const source = new FileSource(makeBlob(SAMPLE_BYTES))
    const tail = await source.readRange(SAMPLE_BYTES.byteLength - 1, 100)
    expect(tail).toEqual(new Uint8Array([0x0a]))
  })

  it('returns an empty array for an offset at end-of-file', async () => {
    const source = new FileSource(makeBlob(SAMPLE_BYTES))
    const none = await source.readRange(SAMPLE_BYTES.byteLength, 10)
    expect(none.byteLength).toBe(0)
  })

  it('returns an empty array for an offset beyond end-of-file', async () => {
    const source = new FileSource(makeBlob(SAMPLE_BYTES))
    const none = await source.readRange(SAMPLE_BYTES.byteLength + 100, 10)
    expect(none.byteLength).toBe(0)
  })

  it('accepts bigint offsets', async () => {
    const source = new FileSource(makeBlob(SAMPLE_BYTES))
    const viaBigInt = await source.readRange(9n, 8)
    const viaNumber = await source.readRange(9, 8)
    expect(viaBigInt).toEqual(viaNumber)
  })

  it('throws for a negative offset', async () => {
    const source = new FileSource(makeBlob(SAMPLE_BYTES))
    await expect(source.readRange(-1, 10)).rejects.toThrow(RangeError)
    await expect(source.readRange(-1n, 10)).rejects.toThrow(RangeError)
  })

  it('throws for an invalid length', async () => {
    const source = new FileSource(makeBlob(SAMPLE_BYTES))
    await expect(source.readRange(0, -1)).rejects.toThrow(RangeError)
    await expect(source.readRange(0, 1.5)).rejects.toThrow(RangeError)
  })

  it('disposes idempotently', async () => {
    const source = new FileSource(makeBlob(SAMPLE_BYTES))
    await source.dispose()
    await expect(source.dispose()).resolves.toBeUndefined()
  })

  it('rejects reads after dispose with a typed error', async () => {
    const source = new FileSource(makeBlob(SAMPLE_BYTES))
    await source.dispose()
    await expect(source.readRange(0, 10)).rejects.toThrow(SourceDisposedError)
    await expect(source.readRange(0, 10)).rejects.toMatchObject({ code: 'SOURCE_DISPOSED' })
  })

  it('rejects size queries after dispose with a typed error', async () => {
    const source = new FileSource(makeBlob(SAMPLE_BYTES))
    await source.dispose()
    await expect(source.getSize()).rejects.toThrow(SourceDisposedError)
  })
})

describe('MemorySource', () => {
  it('UTF-8 encodes string payloads in the worker', async () => {
    const text = 'é€😀\n' // 2 + 3 + 4 + 1 = 10 bytes
    const source = new MemorySource('unicode.jsonl', text)
    expect(await source.getSize()).toBe(10n)
    const bytes = await source.readRange(0, 100)
    expect(new TextDecoder().decode(bytes)).toBe(text)
    expect(Array.from(bytes)).toEqual([0xc3, 0xa9, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x98, 0x80, 0x0a])
  })

  it('takes ownership of transferred ArrayBuffers without copying', async () => {
    const buffer = new ArrayBuffer(16)
    const view = new Uint8Array(buffer)
    view.set(SAMPLE_BYTES.subarray(0, 16))
    const source = new MemorySource('transferred.jsonl', buffer)
    expect(await source.getSize()).toBe(16n)
    const bytes = await source.readRange(0, 16)
    expect(bytes.buffer).toBe(buffer)
    expect(new TextDecoder().decode(bytes)).toBe('line-one\nline-tw')
  })

  it('handles empty payloads', async () => {
    const source = new MemorySource('empty.jsonl', '')
    expect(await source.getSize()).toBe(0n)
    const bytes = await source.readRange(0, 10)
    expect(bytes.byteLength).toBe(0)
  })

  it('reads an exact middle range', async () => {
    const source = new MemorySource('m.jsonl', SAMPLE_TEXT)
    const chunk = await source.readRange(9, 8)
    expect(new TextDecoder().decode(chunk)).toBe('line-two')
  })

  it('clamps a range extending past end-of-file', async () => {
    const source = new MemorySource('m.jsonl', SAMPLE_TEXT)
    const tail = await source.readRange(SAMPLE_BYTES.byteLength - 1, 100)
    expect(tail).toEqual(new Uint8Array([0x0a]))
  })

  it('returns an empty array for an offset beyond end-of-file', async () => {
    const source = new MemorySource('m.jsonl', SAMPLE_TEXT)
    const none = await source.readRange(SAMPLE_BYTES.byteLength + 5, 10)
    expect(none.byteLength).toBe(0)
  })

  it('accepts bigint offsets', async () => {
    const source = new MemorySource('m.jsonl', SAMPLE_TEXT)
    expect(await source.readRange(9n, 8)).toEqual(await source.readRange(9, 8))
  })

  it('throws for a negative offset and invalid length', async () => {
    const source = new MemorySource('m.jsonl', SAMPLE_TEXT)
    await expect(source.readRange(-1n, 10)).rejects.toThrow(RangeError)
    await expect(source.readRange(0, -3)).rejects.toThrow(RangeError)
  })

  it('enforces the payload cap on encoded bytes with a typed error', async () => {
    expect(() => new MemorySource('big.jsonl', 'aaaa', { maxPayloadBytes: 3 })).toThrow(
      PayloadTooLargeError,
    )
    // 3 characters but 6 UTF-8 bytes: the cap applies to encoded size.
    expect(() => new MemorySource('big.jsonl', 'ééé', { maxPayloadBytes: 4 })).toThrow(
      PayloadTooLargeError,
    )
    expect(() => new MemorySource('big.jsonl', new ArrayBuffer(8), { maxPayloadBytes: 7 })).toThrow(
      PayloadTooLargeError,
    )
  })

  it('payload cap errors expose the code and sizes', () => {
    try {
      new MemorySource('big.jsonl', new ArrayBuffer(8), { maxPayloadBytes: 7 })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(PayloadTooLargeError)
      expect((error as PayloadTooLargeError).code).toBe('HANDOVER_PAYLOAD_TOO_LARGE')
      expect((error as PayloadTooLargeError).message).toContain('8')
      expect((error as PayloadTooLargeError).message).toContain('7')
    }
  })

  it('disposes idempotently', async () => {
    const source = new MemorySource('m.jsonl', SAMPLE_TEXT)
    await source.dispose()
    await expect(source.dispose()).resolves.toBeUndefined()
  })

  it('rejects reads after dispose with a typed error', async () => {
    const source = new MemorySource('m.jsonl', SAMPLE_TEXT)
    await source.dispose()
    await expect(source.readRange(0, 10)).rejects.toThrow(SourceDisposedError)
    await expect(source.getSize()).rejects.toThrow(SourceDisposedError)
  })
})

describe('Source read semantics (shared)', () => {
  const fixtures: Array<[string, () => { source: JsonlSource }]> = [
    ['FileSource', () => ({ source: new FileSource(makeBlob(SAMPLE_BYTES)) })],
    ['MemorySource', () => ({ source: new MemorySource('m.jsonl', SAMPLE_TEXT) })],
  ]

  it.each(fixtures)('%s: zero-length read returns an empty array', async (_label, make) => {
    const { source } = make()
    expect((await source.readRange(0, 0)).byteLength).toBe(0)
  })

  it.each(fixtures)('%s: exact full-file read matches the sample bytes', async (_label, make) => {
    const { source } = make()
    const all = await source.readRange(0, SAMPLE_BYTES.byteLength)
    expect(all).toEqual(SAMPLE_BYTES)
  })
})
