import { describe, it, expect } from 'vitest'
import { JsonlScanner, IndexAbortedError } from '~/engine/scanner.js'
import { MemorySource } from '~/engine/sources/index.js'
import type { JsonlSource } from '~/engine/sources/index.js'
import {
  OffsetIndex,
  offsetToNumber,
  offsetToBigInt,
  UnsafeConversionError,
} from '~/engine/indexer.js'

const enc = new TextEncoder()

// ============================================================================
// Reference implementation (naive, chunk-free) — independent of the scanner's
// chunking so the fuzz test compares semantics, not implementations.
// ============================================================================

interface ReferenceRow {
  start: bigint
  displayEnd: bigint
}

interface ReferenceResult {
  rows: ReferenceRow[]
  hasCRLF: boolean
  invalidUtf8Rows: number
}

function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

function referenceSplit(bytes: Uint8Array): ReferenceResult {
  const rows: ReferenceRow[] = []
  let hasCRLF = false
  let invalidUtf8Rows = 0
  let start = 0n
  const total = BigInt(bytes.length)

  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0x0a) continue
    const row = commitRow(rows, bytes, start, BigInt(i), hasCRLF)
    hasCRLF = row.hasCRLF
    if (!isValidUtf8(bytes.subarray(Number(start), Number(row.displayEnd)))) {
      invalidUtf8Rows++
    }
    start = BigInt(i + 1)
  }
  if (start < total) {
    const row = commitRow(rows, bytes, start, total, hasCRLF)
    hasCRLF = row.hasCRLF
    if (!isValidUtf8(bytes.subarray(Number(start), Number(row.displayEnd)))) {
      invalidUtf8Rows++
    }
  }
  return { rows, hasCRLF, invalidUtf8Rows }
}

function commitRow(
  rows: ReferenceRow[],
  bytes: Uint8Array,
  start: bigint,
  end: bigint,
  hasCRLF: boolean,
): { displayEnd: bigint; hasCRLF: boolean } {
  let displayEnd = end
  if (displayEnd > start && bytes[Number(displayEnd - 1n)] === 0x0d) {
    displayEnd -= 1n
  }
  rows.push({ start, displayEnd })
  return { displayEnd, hasCRLF: displayEnd < end || hasCRLF }
}

// ============================================================================
// Deterministic PRNG so fuzz runs are stable across machines and CI.
// ============================================================================

function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TOKENS: Uint8Array[] = [
  new Uint8Array([0x61]), // 'a'
  new Uint8Array([0x62]), // 'b'
  new Uint8Array([0x0a]), // '\n' (weighted: appears twice below)
  new Uint8Array([0x0a]),
  new Uint8Array([0x0d, 0x0a]), // '\r\n'
  new Uint8Array([0x0d]), // lone '\r'
  new Uint8Array([0xc3, 0xa9]), // 'é' (2 bytes)
  new Uint8Array([0xe2, 0x82, 0xac]), // '€' (3 bytes)
  new Uint8Array([0xf0, 0x9f, 0x9a, 0x80]), // '🚀' (4 bytes)
  new Uint8Array([]), // nothing (blank padding)
  new Uint8Array([0xff]), // invalid UTF-8
]

function randomBytes(rng: () => number, maxTokens: number): Uint8Array {
  const count = Math.floor(rng() * maxTokens)
  const parts: Uint8Array[] = []
  let total = 0
  for (let i = 0; i < count; i++) {
    const token = TOKENS[Math.floor(rng() * TOKENS.length)]!
    parts.push(token)
    total += token.length
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

async function scanBytes(bytes: Uint8Array, chunkSize: number) {
  const buffer = new ArrayBuffer(bytes.length)
  new Uint8Array(buffer).set(bytes)
  const scanner = new JsonlScanner(new MemorySource('fuzz.jsonl', buffer), { chunkSize })
  const rows: Array<{ rowId: number; start: bigint; displayEnd: bigint }> = []
  const result = await scanner.scan({
    onRow: (row) => rows.push({ rowId: row.rowId, start: row.start, displayEnd: row.displayEnd }),
  })
  return { scanner, result, rows }
}

// ============================================================================
// Fuzz: randomized chunk boundaries vs the reference implementation.
// ============================================================================

describe('JsonlScanner fuzz (seeded, chunk-boundary randomization)', () => {
  it('matches the reference implementation across random content and chunk sizes', async () => {
    const rng = mulberry32(0x5eed)
    for (let iter = 0; iter < 300; iter++) {
      const large = rng() < 0.2
      const bytes = randomBytes(rng, large ? 1500 : 60)
      const chunkSize = 1 + Math.floor(rng() * 64)
      const expected = referenceSplit(bytes)
      const { scanner, result, rows } = await scanBytes(bytes, chunkSize)

      expect(result.totalRows, `iter ${iter}: totalRows`).toBe(expected.rows.length)
      expect(result.hasCRLF, `iter ${iter}: hasCRLF`).toBe(expected.hasCRLF)
      expect(result.invalidUtf8Rows, `iter ${iter}: invalidUtf8Rows`).toBe(expected.invalidUtf8Rows)
      expect(result.totalBytes, `iter ${iter}: totalBytes`).toBe(BigInt(bytes.length))
      expect(rows.length, `iter ${iter}: onRow count`).toBe(expected.rows.length)

      for (let i = 0; i < expected.rows.length; i++) {
        const exp = expected.rows[i]!
        const got = rows[i]!
        expect(scanner.getStart(i), `iter ${iter} row ${i} start`).toBe(exp.start)
        expect(scanner.getDisplayEnd(i), `iter ${iter} row ${i} end`).toBe(exp.displayEnd)
        expect(got.rowId, `iter ${iter} row ${i} rowId`).toBe(i)
        expect(got.start, `iter ${iter} row ${i} onRow start`).toBe(exp.start)
        expect(got.displayEnd, `iter ${iter} row ${i} onRow end`).toBe(exp.displayEnd)
      }
    }
  })

  it('decodes scanner-derived ranges to the reference row text (byte, not character, offsets)', async () => {
    const rng = mulberry32(0xbeef)
    for (let iter = 0; iter < 100; iter++) {
      const bytes = randomBytes(rng, 40)
      const chunkSize = 1 + Math.floor(rng() * 8) // tiny chunks: split multibyte everywhere
      const expected = referenceSplit(bytes)
      const { scanner, result } = await scanBytes(bytes, chunkSize)
      expect(result.totalRows, `iter ${iter}`).toBe(expected.rows.length)
      for (let i = 0; i < expected.rows.length; i++) {
        const exp = expected.rows[i]!
        // Decode with the SCANNER's range and compare to the reference text;
        // any byte/character offset confusion corrupts the slice.
        const rowText = decodeRange(bytes, scanner.getStart(i), scanner.getDisplayEnd(i))
        const expText = decodeRange(bytes, exp.start, exp.displayEnd)
        expect(rowText, `iter ${iter} row ${i} text`).toBe(expText)
      }
    }
  })

function decodeRange(bytes: Uint8Array, start: bigint, end: bigint): string {
  const view = new Uint8Array(bytes.buffer, Number(start), Number(end - start))
  return new TextDecoder('utf-8', { fatal: false }).decode(view)
}
})

// ============================================================================
// Boundary and off-by-one cases (deterministic).
// ============================================================================

describe('JsonlScanner boundary and off-by-one cases', () => {
  it('commits a row that ends exactly at a chunk boundary', async () => {
    const { scanner, result } = await scanBytes(enc.encode('ab\n'), 3)
    expect(result.totalRows).toBe(1)
    expect(scanner.getStart(0)).toBe(0n)
    expect(scanner.getDisplayEnd(0)).toBe(2n)
  })

  it('handles a chunk boundary falling exactly on every row start', async () => {
    const { scanner, result } = await scanBytes(enc.encode('ab\ncd\n'), 3)
    expect(result.totalRows).toBe(2)
    expect(scanner.getStart(1)).toBe(3n)
    expect(scanner.getDisplayEnd(1)).toBe(5n)
  })

  it('splits CRLF with CR as the final byte of a chunk', async () => {
    const { scanner, result } = await scanBytes(enc.encode('x\r\ny\r\n'), 2)
    expect(result.hasCRLF).toBe(true)
    expect(result.totalRows).toBe(2)
    expect(scanner.getDisplayEnd(0)).toBe(1n)
    expect(scanner.getStart(1)).toBe(3n)
  })

  it('splits a 4-byte emoji at every possible chunk alignment', async () => {
    for (const chunkSize of [1, 2, 3, 4, 5]) {
      const { scanner, result } = await scanBytes(enc.encode('🚀\n'), chunkSize)
      expect(result.invalidUtf8Rows, `chunk ${chunkSize}`).toBe(0)
      expect(result.totalRows, `chunk ${chunkSize}`).toBe(1)
      expect(scanner.getDisplayEnd(0), `chunk ${chunkSize}`).toBe(4n)
    }
  })

  it('keeps a lone CR in the displayed row (no LF to terminate it)', async () => {
    const { scanner, result } = await scanBytes(enc.encode('a\rb\n'), 2)
    expect(result.hasCRLF).toBe(false)
    expect(result.totalRows).toBe(1)
    // 'a\rb' is 3 bytes; the CR is kept because no LF terminates the row.
    expect(scanner.getDisplayEnd(0) - scanner.getStart(0)).toBe(3n)
  })

  it('does not create a phantom row after a trailing LF', async () => {
    for (const chunkSize of [1, 2, 4, 8]) {
      const { result } = await scanBytes(enc.encode('a\n'), chunkSize)
      expect(result.totalRows, `chunk ${chunkSize}`).toBe(1)
    }
  })

  it('keeps the final row when the file ends exactly on the last chunk', async () => {
    const { scanner, result } = await scanBytes(enc.encode('abc'), 3)
    expect(result.totalRows).toBe(1)
    expect(scanner.getStart(0)).toBe(0n)
    expect(scanner.getDisplayEnd(0)).toBe(3n)
  })

  it('uses byte offsets, not character offsets, for multibyte rows', async () => {
    const { scanner } = await scanBytes(enc.encode('héllo\n🚀\n'), 5)
    // 'héllo' is 5 characters but 6 bytes (é is 2); '🚀' is 4 bytes.
    // Character-based offsets would give ends of 5 and 10 instead.
    expect(scanner.getStart(0)).toBe(0n)
    expect(scanner.getDisplayEnd(0)).toBe(6n)
    expect(scanner.getStart(1)).toBe(7n)
    expect(scanner.getDisplayEnd(1)).toBe(11n)
  })

  it('holds exactly N+1 start offsets for N rows (sentinel invariant)', async () => {
    const source = new MemorySource('n.jsonl', 'a\nbb\nccc\n')
    const scanner = new JsonlScanner(source)
    const result = await scanner.scan()
    expect(result.totalRows).toBe(3)
    // First row starts at 0; final sentinel equals the total size.
    expect(scanner.getStart(0)).toBe(0n)
    // The row after the last committed one starts exactly at totalBytes.
    const total = scanner.getTotalBytes()
    expect(scanner.getDisplayEnd(2)).toBe(total - 1n)
  })
})

// ============================================================================
// Allocation and block-read assertions.
// ============================================================================

/** Counts reads and bounds so tests can assert streaming (no over-read). */
class TrackingSource implements JsonlSource {
  readonly name = 'tracking.jsonl'
  reads = 0
  totalBytesRead = 0n
  maxReadLength = 0
  private inner: JsonlSource

  constructor(payload: string) {
    this.inner = new MemorySource(this.name, payload)
  }

  async getSize(): Promise<bigint> {
    return this.inner.getSize()
  }

  async readRange(offset: bigint | number, length: number): Promise<Uint8Array> {
    this.reads++
    this.totalBytesRead += BigInt(length)
    this.maxReadLength = Math.max(this.maxReadLength, length)
    return this.inner.readRange(offset, length)
  }

  async dispose(): Promise<void> {
    return this.inner.dispose()
  }
}

describe('JsonlScanner allocation and block-read behavior', () => {
  it('reads the source in exactly ceil(total/chunk) bounded chunks, no over-read', async () => {
    const payload = 'x'.repeat(1000) + '\n' + 'y'.repeat(50) + '\n' // 1052 bytes
    const source = new TrackingSource(payload)
    const chunkSize = 64
    const scanner = new JsonlScanner(source, { chunkSize })
    const result = await scanner.scan()
    const total = 1052n
    expect(result.totalBytes).toBe(total)
    expect(source.reads).toBe(Math.ceil(1052 / chunkSize))
    expect(source.totalBytesRead).toBe(total)
    expect(source.maxReadLength).toBeLessThanOrEqual(chunkSize)
    expect(result.totalRows).toBe(2)
    expect(scanner.getDisplayEnd(0)).toBe(1000n)
    expect(scanner.getStart(1)).toBe(1001n)
  })

  it('carries a row spanning many chunks and still reads in bounded chunks', async () => {
    const payload = 'x'.repeat(3000) + '\n' // one row = ~47 chunks of 64
    const source = new TrackingSource(payload)
    const scanner = new JsonlScanner(source, { chunkSize: 64 })
    const result = await scanner.scan()
    expect(result.totalRows).toBe(1)
    expect(scanner.getStart(0)).toBe(0n)
    expect(scanner.getDisplayEnd(0)).toBe(3000n)
    expect(source.reads).toBe(Math.ceil(3001 / 64))
    expect(source.maxReadLength).toBeLessThanOrEqual(64)
  })

  it('grows the offset index geometrically and reports honest metrics', () => {
    const index = new OffsetIndex(16)
    for (let i = 0; i < 100; i++) {
      index.appendOffset(BigInt(i) * 10n)
    }
    const metrics = index.getMetrics()
    // 100 offsets need capacity 128 (16 → 32 → 64 → 128), not 100.
    expect(metrics.length).toBe(100)
    expect(metrics.capacity).toBe(128)
    expect(metrics.memoryBytes).toBe(128 * 8)
  })

  it('round-trips 200k offsets including values past 4 GiB', () => {
    const index = new OffsetIndex(1024)
    const count = 200_000
    const base = 2n ** 32n // 4 GiB
    for (let i = 0; i < count; i++) {
      index.appendOffset(base + BigInt(i) * 3n)
    }
    expect(index.getLength()).toBe(count)
    for (let i = 0; i < count; i += 10_000) {
      expect(index.getOffsetAsBigInt(i)).toBe(base + BigInt(i) * 3n)
    }
    expect(index.getOffsetAsBigInt(count - 1)).toBe(base + BigInt(count - 1) * 3n)
    expect(offsetToNumber(index.getOffsetAsBigInt(0))).toBe(Number(base))
  })
})

// ============================================================================
// Cancellation (scanner level).
// ============================================================================

/** Aborts the signal when the Nth chunk is read. */
class AbortOnReadSource implements JsonlSource {
  readonly name = 'abort.jsonl'
  reads = 0
  private inner: JsonlSource

  constructor(payload: string, private readonly abortAtRead: number, private readonly controller: AbortController) {
    this.inner = new MemorySource(this.name, payload)
  }

  async getSize(): Promise<bigint> {
    return this.inner.getSize()
  }

  async readRange(offset: bigint | number, length: number): Promise<Uint8Array> {
    this.reads++
    if (this.reads === this.abortAtRead) this.controller.abort()
    return this.inner.readRange(offset, length)
  }

  async dispose(): Promise<void> {
    return this.inner.dispose()
  }
}

describe('JsonlScanner cancellation', () => {
  it('aborts mid-scan: partial rows stay queryable, scan rejects, retry rebuilds', async () => {
    const controller = new AbortController()
    const payload = 'one\ntwo\nthree\nfour\n' // 4 rows, 4+ chunks of 4
    const source = new AbortOnReadSource(payload, 2, controller)
    const scanner = new JsonlScanner(source, { chunkSize: 4 })

    await expect(scanner.scan({ signal: controller.signal })).rejects.toThrow(IndexAbortedError)
    expect(scanner.isComplete()).toBe(false)
    // The chunk whose read triggered the abort is still processed, so
    // 'one\n' and 'two\n' committed before the loop re-checked the signal.
    expect(scanner.getRowCount()).toBe(2)
    expect(scanner.getStart(0)).toBe(0n)
    expect(scanner.getDisplayEnd(0)).toBe(3n)
    expect(scanner.getStart(1)).toBe(4n)

    // Retry semantics: a fresh scanner over the same source completes fully.
    const retry = new JsonlScanner(new MemorySource('retry.jsonl', payload), { chunkSize: 4 })
    const result = await retry.scan()
    expect(result.totalRows).toBe(4)
    expect(result.hasCRLF).toBe(false)
  })

  it('rejects with a typed error when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const scanner = new JsonlScanner(new MemorySource('ab.jsonl', 'a\nb\n'))
    await expect(scanner.scan({ signal: controller.signal })).rejects.toThrow(IndexAbortedError)
    expect(scanner.isComplete()).toBe(false)
    expect(scanner.getRowCount()).toBe(0)
  })
})

// ============================================================================
// Safe-integer boundary conversions.
// ============================================================================

describe('offsetToNumber / offsetToBigInt boundaries', () => {
  it('accepts the largest safe integer and rejects the next one', () => {
    const maxSafe = 2n ** 53n - 1n
    expect(offsetToNumber(maxSafe)).toBe(Number.MAX_SAFE_INTEGER)
    expect(() => offsetToNumber(2n ** 53n)).toThrow(UnsafeConversionError)
  })

  it('accepts offsets past 32 bits that stay safe', () => {
    expect(offsetToNumber(2n ** 32n + 5n)).toBe(2 ** 32 + 5)
    expect(offsetToNumber(0n)).toBe(0)
  })

  it('rejects negative offsets with a RangeError', () => {
    expect(() => offsetToNumber(-1n)).toThrow(RangeError)
  })

  it('offsetToBigInt accepts safe numbers and rejects unsafe/negative', () => {
    expect(offsetToBigInt(0)).toBe(0n)
    expect(offsetToBigInt(2 ** 32 + 5)).toBe(2n ** 32n + 5n)
    expect(() => offsetToBigInt(2 ** 53)).toThrow(RangeError)
    expect(() => offsetToBigInt(-1)).toThrow(RangeError)
  })
})
