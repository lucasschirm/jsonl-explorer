import { describe, it, expect } from 'vitest'
import { JsonlScanner, IndexAbortedError } from '~/engine/scanner.js'
import type { CommittedRow } from '~/engine/scanner.js'
import { MemorySource } from '~/engine/sources/index.js'
import type { JsonlSource } from '~/engine/sources/index.js'
import { UnsafeConversionError, offsetToNumber } from '~/engine/indexer.js'

const enc = new TextEncoder()

function scanText(
  text: string,
  chunkSize?: number,
): Promise<{ scanner: JsonlScanner; result: Awaited<ReturnType<JsonlScanner['scan']>>; rows: CommittedRow[] }> {
  const source = new MemorySource('test.jsonl', text)
  const scanner = new JsonlScanner(source, chunkSize ? { chunkSize } : undefined)
  const rows: CommittedRow[] = []
  return scanner
    .scan({ onRow: (row) => rows.push(row) })
    .then((result) => ({ scanner, result, rows }))
}

function decodeRow(scanner: JsonlScanner, source: JsonlSource, rowId: number): Promise<string> {
  const start = scanner.getStart(rowId)
  const end = scanner.getDisplayEnd(rowId)
  return source
    .readRange(start, Number(end - start))
    .then((bytes) => new TextDecoder('utf-8', { fatal: false }).decode(bytes))
}

describe('JsonlScanner: row semantics', () => {
  it('splits LF-terminated rows with exact byte ranges', async () => {
    const { scanner, result, rows } = await scanText('a\nbb\nccc\n')
    expect(result.totalRows).toBe(3)
    expect(result.totalBytes).toBe(9n)
    expect(scanner.getStart(0)).toBe(0n)
    expect(scanner.getDisplayEnd(0)).toBe(1n)
    expect(scanner.getStart(1)).toBe(2n)
    expect(scanner.getDisplayEnd(1)).toBe(4n)
    expect(scanner.getStart(2)).toBe(5n)
    expect(scanner.getDisplayEnd(2)).toBe(8n)
    expect(rows.map((r) => [r.rowId, r.start, r.displayEnd])).toEqual([
      [0, 0n, 1n],
      [1, 2n, 4n],
      [2, 5n, 8n],
    ])
  })

  it('treats a trailing LF as no extra row', async () => {
    const { result } = await scanText('a\nb\n')
    expect(result.totalRows).toBe(2)
  })

  it('keeps a final row without trailing LF', async () => {
    const { scanner, result } = await scanText('a\nb')
    expect(result.totalRows).toBe(2)
    expect(scanner.getStart(1)).toBe(2n)
    expect(scanner.getDisplayEnd(1)).toBe(3n)
  })

  it('treats internal blank lines as rows and a zero-byte source as zero rows', async () => {
    const blanks = await scanText('\n\nx\n')
    expect(blanks.result.totalRows).toBe(3)
    expect(blanks.scanner.getDisplayEnd(0)).toBe(0n)
    expect(blanks.scanner.getDisplayEnd(1)).toBe(1n)

    const empty = await scanText('')
    expect(empty.result.totalRows).toBe(0)
    expect(empty.scanner.getTotalBytes()).toBe(0n)
  })

  it('strips a terminal CR from the display range without moving the start', async () => {
    const source = new MemorySource('crlf.jsonl', 'a\r\nbb\r\n')
    const scanner = new JsonlScanner(source, { chunkSize: 4 })
    const result = await scanner.scan()
    expect(result.hasCRLF).toBe(true)
    expect(scanner.getStart(0)).toBe(0n)
    expect(scanner.getDisplayEnd(0)).toBe(1n)
    expect(scanner.getStart(1)).toBe(3n)
    expect(scanner.getDisplayEnd(1)).toBe(5n)
  })

  it('handles CRLF split across chunk boundaries', async () => {
    const { scanner, result } = await scanText('ab\r\n', 3)
    expect(result.hasCRLF).toBe(true)
    expect(result.totalRows).toBe(1)
    expect(scanner.getStart(0)).toBe(0n)
    expect(scanner.getDisplayEnd(0)).toBe(2n)
  })

  it('treats a blank CRLF line as an empty row', async () => {
    const { scanner, result } = await scanText('\r\nx\r\n', 2)
    expect(result.totalRows).toBe(2)
    expect(scanner.getDisplayEnd(0)).toBe(0n)
    expect(scanner.getStart(1)).toBe(2n)
    expect(scanner.getDisplayEnd(1)).toBe(3n)
  })

  it('indexes a line larger than a scan chunk', async () => {
    const long = 'x'.repeat(1000)
    const { scanner, result } = await scanText(`${long}\nafter\n`, 64)
    expect(result.totalRows).toBe(2)
    expect(scanner.getStart(0)).toBe(0n)
    expect(scanner.getDisplayEnd(0)).toBe(1000n)
    expect(scanner.getStart(1)).toBe(1001n)
    expect(scanner.getDisplayEnd(1)).toBe(1006n)
  })

  it('emits committed rows incrementally with stable display ranges', async () => {
    const source = new MemorySource('inc.jsonl', 'one\ntwo\nthree\n')
    const scanner = new JsonlScanner(source, { chunkSize: 5 })
    const rows: CommittedRow[] = []
    await scanner.scan({ onRow: (row) => rows.push(row) })
    expect(rows).toHaveLength(3)
    for (let i = 0; i < 3; i++) {
      expect(rows[i].rowId).toBe(i)
      expect(scanner.getStart(i)).toBe(rows[i].start)
      expect(scanner.getDisplayEnd(i)).toBe(rows[i].displayEnd)
    }
  })
})

describe('JsonlScanner: UTF-8', () => {
  it('decodes multibyte characters split across chunk boundaries intact', async () => {
    const source = new MemorySource('utf8.jsonl', 'héllo\n')
    const scanner = new JsonlScanner(source, { chunkSize: 3 })
    const result = await scanner.scan()
    expect(result.invalidUtf8Rows).toBe(0)
    expect(result.totalRows).toBe(1)
    const text = await decodeRow(scanner, source, 0)
    expect(text).toBe('héllo')
  })

  it('counts invalid UTF-8 rows for a single per-load warning', async () => {
    // Raw bytes with an invalid 0xFF sequence: "a\xffb\nc\n"
    const raw = new Uint8Array([0x61, 0xff, 0x62, 0x0a, 0x63, 0x0a])
    const buffer = new ArrayBuffer(raw.length)
    new Uint8Array(buffer).set(raw)
    const mem = new MemorySource('bad.jsonl', buffer)
    const scanner = new JsonlScanner(mem)
    const result = await scanner.scan()
    expect(result.totalRows).toBe(2)
    expect(result.invalidUtf8Rows).toBe(1)
    expect(scanner.getInvalidUtf8Rows()).toBe(1)
    // Display range of the invalid row is still byte-exact.
    expect(scanner.getStart(0)).toBe(0n)
    expect(scanner.getDisplayEnd(0)).toBe(3n)
  })
})

describe('JsonlScanner: large files', () => {
  it('indexes offsets above 4 GiB without reading the file in one block', async () => {
    const MiB = 1024n * 1024n
    const total = 4n * 1024n * 1024n * 1024n + 2n * MiB // just over 4 GiB
    const chunk = 16 * 1024 * 1024 // 16 MiB scan chunks keep the test fast

    // Layout: "first" line, a blank LF every MiB, then a "last" line at EOF.
    const lines: Array<[bigint, string]> = [[0n, 'first']]
    const blankOffsets: bigint[] = []
    for (let k = 1n; ; k++) {
      const off = k * MiB
      if (off >= total - 10n) break
      blankOffsets.push(off)
      lines.push([off, ''])
    }
    lines.push([total - 5n, 'last'])

    const source = new SparseSource(total, lines)
    const scanner = new JsonlScanner(source, { chunkSize: chunk })
    const result = await scanner.scan()

    const expectedRows = 1 + blankOffsets.length + 1
    // The final row starts after the last blank line's LF, not at "last"'s offset.
    const expectedLastStart = blankOffsets[blankOffsets.length - 1]! + 1n
    expect(expectedLastStart).toBeGreaterThan(2n ** 32n) // > 4 GiB
    expect(result.totalRows).toBe(expectedRows)
    expect(scanner.getStart(expectedRows - 1)).toBe(expectedLastStart)
    expect(scanner.getDisplayEnd(expectedRows - 1)).toBe(total - 1n)
    // Safe-integer conversion at the read boundary works past 2^32.
    expect(Number(offsetToNumber(scanner.getStart(expectedRows - 1)))).toBe(Number(expectedLastStart))
    // Streamed in bounded chunks; every byte read exactly once.
    expect(source.maxReadLength).toBeLessThanOrEqual(chunk)
    expect(source.totalBytesRead).toBe(total)
  })

  it('rejects converting unsafe integer offsets to numbers', () => {
    expect(() => offsetToNumber(2n ** 53n)).toThrow(UnsafeConversionError)
  })
})

describe('JsonlScanner: progress, abort, misuse', () => {
  it('reports progress including a final complete snapshot', async () => {
    const source = new MemorySource('p.jsonl', 'a\nb\nc\n')
    const scanner = new JsonlScanner(source, { chunkSize: 2 })
    const progress: Array<{ rowsCommitted: number; bytesScanned: bigint; totalBytes: bigint }> = []
    await scanner.scan({ onProgress: (p) => progress.push({ ...p }) })
    expect(progress.length).toBeGreaterThan(0)
    const last = progress[progress.length - 1]!
    expect(last).toEqual({ rowsCommitted: 3, bytesScanned: 6n, totalBytes: 6n })
  })

  it('commits rows before the scan completes', async () => {
    const source = new FailingSource()
    const scanner = new JsonlScanner(source, { chunkSize: 4 })
    const rows: CommittedRow[] = []
    await expect(scanner.scan({ onRow: (row) => rows.push(row) })).rejects.toThrow('boom')
    expect(rows).toHaveLength(1)
    expect(scanner.getRowCount()).toBe(1)
    expect(scanner.isComplete()).toBe(false)
    expect(scanner.getStart(0)).toBe(0n)
    expect(scanner.getDisplayEnd(0)).toBe(1n)
  })

  it('aborts promptly with a typed error and no completed index', async () => {
    const controller = new AbortController()
    controller.abort()
    const source = new MemorySource('ab.jsonl', 'a\nb\n')
    const scanner = new JsonlScanner(source)
    await expect(scanner.scan({ signal: controller.signal })).rejects.toThrow(IndexAbortedError)
    expect(scanner.isComplete()).toBe(false)
  })

  it('aborts mid-scan between chunks', async () => {
    const controller = new AbortController()
    const source = new AbortingSource(controller)
    const scanner = new JsonlScanner(source, { chunkSize: 4 })
    await expect(scanner.scan({ signal: controller.signal })).rejects.toThrow(IndexAbortedError)
    expect(scanner.isComplete()).toBe(false)
    expect(scanner.getRowCount()).toBe(1) // first chunk "a\n" committed
  })

  it('rejects row access for invalid row ids', async () => {
    const { scanner } = await scanText('a\n')
    expect(() => scanner.getStart(-1)).toThrow(RangeError)
    expect(() => scanner.getStart(1)).toThrow(RangeError)
    expect(() => scanner.getDisplayEnd(0.5)).toThrow(RangeError)
  })
})

/**
 * Source over a sparse conceptual file: zero-filled space with LF-terminated
 * lines. Reads must be ascending (as the scanner performs them); lines must
 * not span more than one read.
 */
class SparseSource implements JsonlSource {
  readonly name = 'sparse.jsonl'
  maxReadLength = 0
  totalBytesRead = 0n
  private readonly total: bigint
  private readonly lines: Array<[bigint, Uint8Array]>
  private cursor = 0

  constructor(total: bigint, lines: Array<[bigint, string]>) {
    this.total = total
    this.lines = lines.map(([off, text]) => [off, enc.encode(`${text}\n`)])
  }

  async getSize(): Promise<bigint> {
    return this.total
  }

  async readRange(offset: bigint | number, length: number): Promise<Uint8Array> {
    const start = typeof offset === 'bigint' ? offset : BigInt(offset)
    this.maxReadLength = Math.max(this.maxReadLength, length)
    this.totalBytesRead += BigInt(length)
    const out = new Uint8Array(length)
    const chunkEnd = start + BigInt(length)
    while (this.cursor < this.lines.length) {
      const [lineOffset, bytes] = this.lines[this.cursor]!
      if (lineOffset >= chunkEnd) break
      this.cursor++
      const lineEnd = lineOffset + BigInt(bytes.length)
      if (lineEnd <= start) continue
      const regionStart = lineOffset > start ? lineOffset : start
      const regionEnd = lineEnd < chunkEnd ? lineEnd : chunkEnd
      out.set(bytes.subarray(Number(regionStart - lineOffset), Number(regionEnd - lineOffset)), Number(regionStart - start))
    }
    return out
  }

  async dispose(): Promise<void> {
    // nothing to release
  }
}

/** Source that returns a first chunk, then fails. */
class FailingSource implements JsonlSource {
  readonly name = 'failing.jsonl'
  private reads = 0

  async getSize(): Promise<bigint> {
    return 10n
  }

  async readRange(_offset: bigint | number, _length: number): Promise<Uint8Array> {
    this.reads++
    if (this.reads === 1) return new Uint8Array([0x61, 0x0a, 0x62, 0x63])
    throw new Error('boom')
  }

  async dispose(): Promise<void> {
    // nothing to release
  }
}

/** Source that aborts the signal when the second chunk is read. */
class AbortingSource implements JsonlSource {
  readonly name = 'aborting.jsonl'
  private reads = 0

  constructor(private readonly controller: AbortController) {}

  async getSize(): Promise<bigint> {
    return 8n
  }

  async readRange(_offset: bigint | number, _length: number): Promise<Uint8Array> {
    this.reads++
    if (this.reads === 2) this.controller.abort()
    if (this.reads === 1) return new Uint8Array([0x61, 0x0a])
    return new Uint8Array(0)
  }

  async dispose(): Promise<void> {
    // nothing to release
  }
}
