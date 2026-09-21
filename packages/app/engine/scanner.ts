/**
 * Byte-based incremental JSONL scanner.
 *
 * Reads a `JsonlSource` in fixed byte chunks, scans for LF (0x0a), and commits
 * complete rows to an N+1-start offset index (ADR-008) as they terminate.
 * Rows are queryable as soon as they are committed, before the scan completes.
 *
 * Row semantics (deterministic):
 * - Every LF terminates the pending row and commits it; internal blank lines
 *   are rows, a trailing LF does not create an extra row, and a zero-byte
 *   source has zero rows.
 * - A terminal CR is stripped from the displayed range without moving the
 *   byte start (CRLF whose two bytes fall in different chunks is handled by
 *   carrying the pending row bytes across chunk boundaries).
 * - Row bytes are carried until the row terminates, then decoded with a
 *   fresh `TextDecoder('utf-8', { fatal: true })`; invalid UTF-8 rows are
 *   counted so the load can emit one warning (display layers re-decode with
 *   replacement).
 *
 * Offsets are bigint end-to-end; conversion to number happens only at the
 * source-read boundary (see `offsetToNumber` in `./indexer.js`).
 */

import { ENGINE_DEFAULTS } from './config/adr.js'
import { OffsetIndex } from './indexer.js'
import type { JsonlSource } from './sources/index.js'

/** Typed error: the scan was aborted before completing. */
export class IndexAbortedError extends Error {
  readonly code = 'INDEX_ABORTED' as const

  constructor() {
    super('Indexing aborted')
    this.name = 'IndexAbortedError'
  }
}

/** A fully committed row (byte offsets; displayEnd is exclusive). */
export interface CommittedRow {
  rowId: number
  start: bigint
  displayEnd: bigint
}

/** Incremental progress snapshot. */
export interface ScanProgress {
  rowsCommitted: number
  bytesScanned: bigint
  totalBytes: bigint
}

/** Outcome of a completed scan. */
export interface ScanResult {
  totalRows: number
  totalBytes: bigint
  hasCRLF: boolean
  invalidUtf8Rows: number
}

export interface ScannerOptions {
  /** Bytes per source read. Defaults to ADR-008 `indexChunkSize` (64 KiB). */
  chunkSize?: number
  /** Initial row capacity for the offset index (geometric growth beyond it). */
  initialRowCapacity?: number
}

export interface ScanCallbacks {
  /** Fired for each row as it is committed (before the scan completes). */
  onRow?: (row: CommittedRow) => void
  /** Fired periodically with committed rows and scanned bytes. */
  onProgress?: (progress: ScanProgress) => void
  /** Aborts the scan before the next chunk; throws `IndexAbortedError`. */
  signal?: AbortSignal
}

/** Incremental byte scanner that builds a queryable JSONL row index. */
export class JsonlScanner {
  private readonly source: JsonlSource
  private readonly chunkSizeBytes: number
  private readonly index: OffsetIndex
  private crlfMask: Uint8Array
  private crlfCapacity: number
  private carryBuf: Uint8Array
  private carryLen = 0
  private carryStart = 0n
  private rowCount = 0
  private totalBytes = 0n
  private hasCRLF = false
  private invalidUtf8Rows = 0
  private lastRowLfTerminated = true
  private complete = false
  private drivenBy: 'none' | 'scan' | 'feed' = 'none'
  private lastProgressAt = 0
  private lastProgressRows = 0

  constructor(source: JsonlSource, options: ScannerOptions = {}) {
    this.source = source
    this.chunkSizeBytes = options.chunkSize ?? ENGINE_DEFAULTS.indexChunkSize
    this.index = new OffsetIndex(options.initialRowCapacity ?? 1024)
    this.index.appendOffset(0n) // sentinel: start of the (pending) first row
    this.crlfMask = new Uint8Array(1024)
    this.crlfCapacity = 1024
    this.carryBuf = new Uint8Array(1024)
  }

  /** Number of fully committed rows (grows while a scan is in flight). */
  getRowCount(): number {
    return this.rowCount
  }

  /** True once any scan activity (scan or feed) has begun. */
  isStarted(): boolean {
    return this.drivenBy !== 'none'
  }

  /** Bytes per source read used by `scan()` (also a good feed step size). */
  get chunkSize(): number {
    return this.chunkSizeBytes
  }

  /** True once the scan has finished and the index is final. */
  isComplete(): boolean {
    return this.complete
  }

  /** Total source size in bytes (valid after the scan starts). */
  getTotalBytes(): bigint {
    return this.totalBytes
  }

  /** True when any row ended in CRLF. */
  getHasCRLF(): boolean {
    return this.hasCRLF
  }

  /** Number of rows containing invalid UTF-8 (one warning per load). */
  getInvalidUtf8Rows(): number {
    return this.invalidUtf8Rows
  }

  /** Byte start offset of a committed row. */
  getStart(rowId: number): bigint {
    this.assertValidRow(rowId)
    return this.index.getOffsetAsBigInt(rowId)
  }

  /** Exclusive end of a row's displayed range (LF and terminal CR stripped). */
  getDisplayEnd(rowId: number): bigint {
    this.assertValidRow(rowId)
    const next = this.index.getOffsetAsBigInt(rowId + 1)
    let end = next
    const lfTerminated = rowId !== this.rowCount - 1 || this.lastRowLfTerminated
    if (lfTerminated) end -= 1n
    if (this.crlfMask[rowId]) end -= 1n
    return end
  }

  /**
   * Scans the source until end-of-file or abort.
   * Resolves with the final stats; throws `IndexAbortedError` on abort.
   * A scanner runs in exactly one mode: `scan()` or `feed()`/`finish()`.
   */
  async scan(callbacks: ScanCallbacks = {}): Promise<ScanResult> {
    if (this.complete) throw new Error('Scanner already used')
    if (this.drivenBy !== 'none') throw new Error('Cannot mix scan() and feed()')
    this.drivenBy = 'scan'
    this.totalBytes = await this.source.getSize()
    const { onRow, onProgress, signal } = callbacks
    let offset = 0n

    while (offset < this.totalBytes) {
      if (signal?.aborted) throw new IndexAbortedError()
      const remaining = this.totalBytes - offset
      const want = remaining < BigInt(this.chunkSizeBytes) ? Number(remaining) : this.chunkSizeBytes
      const chunk = await this.source.readRange(offset, want)
      this.processFeed(chunk, offset, onRow)
      offset += BigInt(chunk.length)
      this.maybeReportProgress(onProgress, offset)
    }

    return this.finish(this.totalBytes, { onRow })
  }

  /**
   * Feeds one chunk of source bytes into an incremental scan. Chunks must
   * arrive in order with each chunk's absolute `base` offset. Committed
   * rows stay queryable (via getStart/getDisplayEnd/getRowCount) between
   * feeds — this is how a download can surface rows while it streams.
   */
  feed(chunk: Uint8Array, base: bigint, callbacks: { onRow?: (row: CommittedRow) => void } = {}): void {
    if (this.complete) throw new Error('Scanner already completed')
    if (this.drivenBy === 'scan') throw new Error('Cannot mix scan() and feed()')
    this.processFeed(chunk, base, callbacks.onRow)
  }

  /** Shared chunk processing for scan() and feed(). */
  private processFeed(chunk: Uint8Array, base: bigint, onRow?: (row: CommittedRow) => void): void {
    this.drivenBy = this.drivenBy === 'none' ? 'feed' : this.drivenBy
    if (chunk.length === 0) return
    this.processChunk(chunk, base, onRow)
  }

  /**
   * Completes an incremental feed: commits the final (un-terminated) row,
   * if any, and finalizes the index. `totalBytes` is the source's final
   * size; it defines the final row's end offset and the result stats.
   */
  finish(totalBytes: bigint, callbacks: { onRow?: (row: CommittedRow) => void } = {}): ScanResult {
    if (this.complete) throw new Error('Scanner already completed')
    if (this.drivenBy === 'none') throw new Error('Scanner not started (scan() or feed() first)')
    this.totalBytes = totalBytes
    if (this.carryLen > 0) {
      this.commitFinalRow(callbacks.onRow)
    }
    this.complete = true
    return {
      totalRows: this.rowCount,
      totalBytes: this.totalBytes,
      hasCRLF: this.hasCRLF,
      invalidUtf8Rows: this.invalidUtf8Rows,
    }
  }

  /** Scans one chunk for LFs, committing rows and growing the carry buffer. */
  private processChunk(chunk: Uint8Array, base: bigint, onRow?: (row: CommittedRow) => void): void {
    let searchFrom = 0
    let lfPos = chunk.indexOf(0x0a, searchFrom)
    while (lfPos !== -1) {
      this.appendCarry(chunk, searchFrom, lfPos)
      this.commitLfRow(base + BigInt(lfPos), onRow)
      searchFrom = lfPos + 1
      lfPos = chunk.indexOf(0x0a, searchFrom)
    }
    this.appendCarry(chunk, searchFrom, chunk.length)
  }

  /** Commits the pending row terminated by the LF at `lfPos`. */
  private commitLfRow(lfPos: bigint, onRow?: (row: CommittedRow) => void): void {
    const rowId = this.rowCount
    const start = this.carryStart
    this.markCrlf(rowId)
    this.validateRowUtf8()
    this.index.appendOffset(lfPos + 1n)
    this.rowCount++
    this.resetCarry(lfPos + 1n)
    onRow?.({ rowId, start, displayEnd: this.getDisplayEnd(rowId) })
  }

  /** Commits the final pending row at end-of-file (no terminating LF). */
  private commitFinalRow(onRow?: (row: CommittedRow) => void): void {
    const rowId = this.rowCount
    const start = this.carryStart
    this.markCrlf(rowId)
    this.validateRowUtf8()
    this.index.appendOffset(this.totalBytes)
    this.rowCount++
    this.lastRowLfTerminated = false
    this.resetCarry(this.totalBytes)
    onRow?.({ rowId, start, displayEnd: this.getDisplayEnd(rowId) })
  }

  /** Appends `chunk[from..to)` to the carried pending-row bytes. */
  private appendCarry(chunk: Uint8Array, from: number, to: number): void {
    const len = to - from
    if (len <= 0) return
    const needed = this.carryLen + len
    if (needed > this.carryBuf.length) {
      const grown = new Uint8Array(Math.max(this.carryBuf.length * 2, needed))
      grown.set(this.carryBuf.subarray(0, this.carryLen))
      this.carryBuf = grown
    }
    this.carryBuf.set(chunk.subarray(from, to), this.carryLen)
    this.carryLen = needed
  }

  /** Records a stripped terminal CR for the row about to be committed. */
  private markCrlf(rowId: number): void {
    if (this.carryLen === 0 || this.carryBuf[this.carryLen - 1] !== 0x0d) return
    if (rowId >= this.crlfCapacity) {
      const grown = new Uint8Array(this.crlfCapacity * 2)
      grown.set(this.crlfMask)
      this.crlfMask = grown
      this.crlfCapacity = grown.length
    }
    this.crlfMask[rowId] = 1
    this.hasCRLF = true
  }

  /** Validates the carried row bytes as UTF-8, counting invalid rows. */
  private validateRowUtf8(): void {
    if (this.carryLen === 0) return
    const decoder = new TextDecoder('utf-8', { fatal: true })
    try {
      decoder.decode(this.carryBuf.subarray(0, this.carryLen))
    } catch {
      this.invalidUtf8Rows++
    }
  }

  /** Clears the carry buffer; the next pending row starts at `start`. */
  private resetCarry(start: bigint): void {
    this.carryLen = 0
    this.carryStart = start
  }

  /** Emits progress at most every ADR interval (rows or time). */
  private maybeReportProgress(
    onProgress: ((progress: ScanProgress) => void) | undefined,
    bytesScanned: bigint,
  ): void {
    if (!onProgress) return
    const now = Date.now()
    const dueRows = this.rowCount - this.lastProgressRows >= ENGINE_DEFAULTS.progressEmitIntervalRows
    const dueTime = now - this.lastProgressAt >= ENGINE_DEFAULTS.progressEmitIntervalMs
    if (bytesScanned >= this.totalBytes || dueRows || dueTime) {
      onProgress({ rowsCommitted: this.rowCount, bytesScanned, totalBytes: this.totalBytes })
      this.lastProgressAt = now
      this.lastProgressRows = this.rowCount
    }
  }

  private assertValidRow(rowId: number): void {
    if (!Number.isSafeInteger(rowId) || rowId < 0 || rowId >= this.rowCount) {
      throw new RangeError(`Invalid row id: ${rowId}`)
    }
  }
}
