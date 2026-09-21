/**
 * Worker-side literal-text / jq filter engine.
 *
 * Owns the active match index (an ascending Uint32Array of original-row IDs)
 * and the scan that rebuilds it. Key guarantees:
 *
 * - **Off-to-side build + atomic swap**: a scan writes into a private
 *   buffer; only on success is the buffer swapped into the published
 *   state. Error or cancel discards the buffer and the previous view
 *   (kind, query, match index, hasFilter) is untouched.
 * - **Token-scoped scans**: each `filter()` call bumps a scan token; a
 *   newer scan or `cancel()` aborts the in-flight scan at the next row
 *   boundary (cooperative — the scan loop re-checks per row).
 * - **Edit overrides**: rows with a worker-side edit override match
 *   against the edited text, never the source bytes (TSK0030 mirrors
 *   edits into the override map this engine consults).
 * - **Partial results**: when indexing is still in flight the scan
 *   covers the committed snapshot and reports `partial: true`; the
 *   worker reruns the latest query once indexing completes.
 * - **jq scans are batched** (TSK0027): the injected runtime (engine/jq.ts,
 *   the only jq-web consumer) evaluates groups of row texts in one call
 *   and returns one boolean verdict per row; batches are bounded by row
 *   count and bytes so cancel/progress stay responsive.
 *
 * Memory stays bounded by the source index plus match IDs: row text is
 * decoded per row and immediately dropped; the match index itself is a
 * Uint32Array (4 bytes per matched row).
 */

import { PROTOCOL_NAMESPACE, PROTOCOL_VERSION } from '@jsonl-explorer/shared'
import type { FilterProgressEvent } from '@jsonl-explorer/shared'
import { JQ_BATCH_MAX_BYTES, JQ_BATCH_MAX_ROWS } from './jq.js'
import type { JqRuntimeLike } from './jq.js'

/** Rows per progress emission (time-throttled further by the caller). */
export const PROGRESS_INTERVAL_ROWS = 1000

/**
 * Sequential read chunk for scans (TSK0053). One `readRange` per row is
 * ~0.3 ms on an OPFS spool — 400k rows meant ~140 s for a text filter.
 * Chunking aligned to the 1 MiB OPFS part size turns N spool round-trips
 * into ~N/4096; the scan walks rows in order, so chunks stay hot. Reads
 * span TWO chunks so a row crossing a part boundary is covered by the
 * same read (no re-fetch).
 */
export const SCAN_CHUNK_BYTES = 1024 * 1024

const EMPTY_BYTES = new Uint8Array(0)

/** Thrown when a filter scan is cancelled or superseded. */
export class FilterCancelledError extends Error {
  constructor(message = 'Filter cancelled') {
    super(message)
    this.name = 'FilterCancelledError'
  }
}

/** Minimal indexer surface the filter needs (worker `Indexer` adapter). */
export interface FilterIndexerLike {
  getCommittedRows(): number
  getLineStart(row: number): number
  getLineEnd(row: number): number
}

/** Minimal source surface: sequential byte reads for the scan. */
export interface FilterSourceLike {
  readRange(start: number, length: number): Promise<Uint8Array>
}

/**
 * Edit-override lookup keyed by 1-based source line ID. Returns the
 * edited text when the row was edited, else null (match source text).
 */
export type EditOverrideLookup = (lineId: number) => string | null

/** Event sink: the worker posts protocol events to the main thread. */
export type FilterEventSink = (event: FilterProgressEvent) => void

export interface FilterEngineOptions {
  postEvent: FilterEventSink
  getEditOverride: EditOverrideLookup
  isIndexComplete: () => boolean
  /** jq backend (TSK0027); required for kind 'jq', ignored for 'text'. */
  jq?: JqRuntimeLike
}

export interface FilterScanResult {
  matchedRows: number
  totalRows: number
  /** True when only the committed snapshot was scanned (indexing live). */
  partial: boolean
  durationMs: number
  /** Rows skipped due to row-level errors (invalid JSON / jq runtime). */
  errorCount: number
  /** One-line summary of the first row error (never a per-row list). */
  errorSummary?: string
}

/** Scan scratch space: the match index plus error accounting. */
interface ScanBuffer {
  rows: Uint32Array
  count: number
  errors: number
  firstError: string | null
  /** jq only: 1 where the row errored (applied to state on the swap). */
  errorFlags: Uint8Array | null
}

interface FilterState {
  kind: 'text' | 'jq'
  query: string
  /** Opaque compiled jq program (null for text kind). */
  jqProgram: string | null
  /** Ascending original-row IDs of matches (only [0, matchedCount) live). */
  matchedRows: Uint32Array
  matchedCount: number
  operationId: string | null
  cancelled: boolean
  /** Rows the scan skipped (jq row errors); exact per-row flags. */
  errorCount: number
  errorFlags: Uint8Array | null
  /** One-line summary of the first row error (null when none). */
  errorSummary: string | null
}

function binarySearchRow(rows: Uint32Array, count: number, rowId: number): number {
  let lo = 0
  let hi = count
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    const midRow = rows[mid]
    if (midRow === undefined || midRow < rowId) lo = mid + 1
    else hi = mid
  }
  return lo
}

export class FilterEngine {
  private state: FilterState = {
    kind: 'text',
    query: '',
    jqProgram: null,
    matchedRows: new Uint32Array(0),
    matchedCount: 0,
    operationId: null,
    cancelled: false,
    errorCount: 0,
    errorFlags: null,
    errorSummary: null,
  }
  private hasFilter = false
  /** Bumped on every filter() start; in-flight scans observe the mismatch. */
  private scanToken = 0
  private lastProgressTime = 0
  private readonly indexer: FilterIndexerLike
  private readonly source: FilterSourceLike
  private readonly postEvent: FilterEventSink
  private readonly getEditOverride: EditOverrideLookup
  private readonly isIndexComplete: () => boolean
  private readonly jq?: JqRuntimeLike

  constructor(
    indexer: FilterIndexerLike,
    source: FilterSourceLike,
    options: FilterEngineOptions,
  ) {
    this.indexer = indexer
    this.source = source
    this.postEvent = options.postEvent
    this.getEditOverride = options.getEditOverride
    this.isIndexComplete = options.isIndexComplete
    this.jq = options.jq
  }

  isFiltered(): boolean {
    return this.hasFilter
  }

  matchCount(): number {
    return this.hasFilter ? this.state.matchedCount : this.indexer.getCommittedRows()
  }

  /** Original row ID at a display index (0 when out of range). */
  rowAt(displayIndex: number): number {
    if (!this.hasFilter) return displayIndex
    return this.state.matchedRows[displayIndex] ?? 0
  }

  /** Display index of a source row under the active filter (null if out). */
  positionOfLine(lineId: number): number | null {
    if (!Number.isInteger(lineId) || lineId < 1) return null
    const rowIndex = lineId - 1
    if (!this.hasFilter) {
      return rowIndex < this.indexer.getCommittedRows() ? rowIndex : null
    }
    if (rowIndex >= this.indexer.getCommittedRows()) return null
    const { matchedRows, matchedCount } = this.state
    const pos = binarySearchRow(matchedRows, matchedCount, rowIndex)
    return pos < matchedCount && matchedRows[pos] === rowIndex ? pos : null
  }

  setOperationId(operationId: string): void {
    this.state.operationId = operationId
  }

  /**
   * Re-evaluate ONE row after an edit/reset (TSK0030). The caller has
   * already stored (or removed) the override, so `rowText` returns the new
   * effective text. With a filter active, the published match index and the
   * per-row error state are updated in place (a single-row change — the
   * full rescan is avoided); without one, membership is the identity view.
   * Returns the row's new display index (null when it drops out of the
   * view) plus the updated error accounting.
   *
   * A concurrent scan commit (indexComplete rerun) is detected via index
   * identity: that scan already judged the row against the new text, so the
   * in-place mutation is skipped — no torn index is ever written.
   */
  async applyEdit(
    lineId: number,
  ): Promise<{ filteredIndex: number | null; errorCount: number; errorSummary: string | null }> {
    const rowIndex = lineId - 1
    if (!Number.isInteger(rowIndex) || rowIndex < 0) {
      throw new Error(`Invalid line ID: ${lineId}`)
    }
    if (!this.hasFilter) {
      const inView = rowIndex < this.indexer.getCommittedRows()
      return { filteredIndex: inView ? rowIndex : null, errorCount: 0, errorSummary: null }
    }
    // Capture the published index: if a scan commits while we await below
    // (a reset reads the source), the swap already reflects this edit.
    const capturedIndex = this.state.matchedRows
    const capturedToken = this.scanToken
    const effectiveText = await this.rowText(rowIndex)
    if (
      this.state.matchedRows !== capturedIndex ||
      this.scanToken !== capturedToken ||
      !this.hasFilter
    ) {
      return {
        filteredIndex: this.positionOfLine(lineId),
        errorCount: this.state.errorCount,
        errorSummary: this.state.errorSummary,
      }
    }
    let matches: boolean
    let rowErrored = false
    if (this.state.kind === 'text') {
      matches = effectiveText.includes(this.state.query)
    } else {
      const verdict = await this.jq?.runVerdicts(this.state.jqProgram as string, [effectiveText], () => false)
      if (verdict === undefined) {
        matches = false // jq backend unavailable: never a match (worker guarantees presence)
      } else if (verdict.errorRows[0]) {
        matches = false
        rowErrored = true
        this.state.errorSummary ??= verdict.firstError ?? 'Row error'
      } else {
        matches = verdict.verdicts[0] === true
      }
      // A scan could have committed during the verdict await as well.
      if (this.state.matchedRows !== capturedIndex || this.scanToken !== capturedToken) {
        return {
          filteredIndex: this.positionOfLine(lineId),
          errorCount: this.state.errorCount,
          errorSummary: this.state.errorSummary,
        }
      }
    }
    this.applyRowError(rowIndex, rowErrored)
    const matchedCount = this.state.matchedCount
    const pos = binarySearchRow(this.state.matchedRows, matchedCount, rowIndex)
    const currentlyMatches =
      pos < matchedCount && this.state.matchedRows[pos] === rowIndex
    if (currentlyMatches && !matches) {
      const rows = this.state.matchedRows
      for (let i = pos; i < matchedCount - 1; i++) rows[i] = rows[i + 1] as number
      this.state.matchedCount = matchedCount - 1
      return { filteredIndex: null, errorCount: this.state.errorCount, errorSummary: this.state.errorSummary }
    }
    if (!currentlyMatches && matches) {
      let rows = this.state.matchedRows
      if (matchedCount >= rows.length) {
        const grown = new Uint32Array(rows.length * 2 + 1024)
        grown.set(rows)
        this.state.matchedRows = grown
        rows = grown
      }
      for (let i = matchedCount; i > pos; i--) rows[i] = rows[i - 1] as number
      rows[pos] = rowIndex
      this.state.matchedCount = matchedCount + 1
      return { filteredIndex: pos, errorCount: this.state.errorCount, errorSummary: this.state.errorSummary }
    }
    return {
      filteredIndex: currentlyMatches ? pos : null,
      errorCount: this.state.errorCount,
      errorSummary: this.state.errorSummary,
    }
  }

  /** Update the per-row error flag and the running count for one row. */
  private applyRowError(rowIndex: number, rowErrored: boolean): void {
    const flags = this.state.errorFlags
    if (flags === null || rowIndex >= flags.length) return // text kind / outside scan horizon
    const wasError = flags[rowIndex] === 1
    if (wasError === rowErrored) return
    flags[rowIndex] = rowErrored ? 1 : 0
    this.state.errorCount = Math.max(0, this.state.errorCount + (rowErrored ? 1 : -1))
    if (this.state.errorCount === 0) this.state.errorSummary = null
  }

  /**
   * Drops the filter view: the identity mapping is restored and any
   * in-flight scan is aborted (its token no longer matches, so its
   * atomic swap is skipped and it surfaces as a cancel).
   */
  clear(): void {
    this.scanToken += 1
    this.state.cancelled = false
    this.state.kind = 'text'
    this.state.query = ''
    this.state.jqProgram = null
    this.state.matchedRows = new Uint32Array(0)
    this.state.matchedCount = 0
    this.state.errorCount = 0
    this.state.errorFlags = null
    this.state.errorSummary = null
    this.hasFilter = false
  }

  /** Cooperative cancel: the in-flight scan aborts at its next row check. */
  cancel(): void {
    this.state.cancelled = true
  }

  /** A filter view exists (possibly partial) and can be rerun on completion. */
  hasActiveQuery(): boolean {
    return this.hasFilter
  }

  getActiveQuery(): { kind: 'text' | 'jq'; query: string } | null {
    return this.hasFilter ? { kind: this.state.kind, query: this.state.query } : null
  }

  getMatchedRows(): Uint32Array {
    return this.state.matchedRows
  }

  getMatchedCount(): number {
    return this.state.matchedCount
  }

  /**
   * Scans committed rows for the query and atomically swaps the built
   * match index into the published state on success. On cancel/error the
   * previous view is preserved unchanged.
   */
  async filter(kind: 'text' | 'jq', query: string): Promise<FilterScanResult> {
    const token = ++this.scanToken
    this.state.cancelled = false
    // A fresh scan starts with a cold chunk cache: scans are the cache's
    // only consumer, and a cold start per scan keeps scan timing uniform
    // (cancellation/supersede tests rely on an in-flight read).
    this.chunkBytes = null
    this.chunkStart = -1
    let jqProgram: string | null = null
    const totalRows = this.indexer.getCommittedRows()
    const partial = !this.isIndexComplete()
    const startedAt = performance.now()
    const buffer: ScanBuffer = {
      rows: new Uint32Array(1024),
      count: 0,
      errors: 0,
      firstError: null,
      errorFlags: kind === 'jq' ? new Uint8Array(totalRows) : null,
    }
    if (kind === 'jq') {
      jqProgram = await this.compileJq(query)
      await this.scanJqRows(token, jqProgram, totalRows, buffer)
    } else {
      await this.scanTextRows(token, query, totalRows, buffer)
    }
    // Atomic swap: kind/query/index/count/hasFilter all land together.
    this.state.kind = kind
    this.state.query = query
    this.state.jqProgram = jqProgram
    this.state.matchedRows = buffer.rows
    this.state.matchedCount = buffer.count
    this.state.errorCount = buffer.errors
    this.state.errorFlags = buffer.errorFlags
    this.state.errorSummary = buffer.firstError
    this.hasFilter = true
    return {
      matchedRows: buffer.count,
      totalRows,
      partial,
      durationMs: Math.round(performance.now() - startedAt),
      errorCount: buffer.errors,
      errorSummary: buffer.firstError ?? undefined,
    }
  }

  /** Row bytes served from the 1 MiB-aligned chunk cache (see readRowBytes). */
  private chunkStart = -1
  private chunkBytes: Uint8Array | null = null
  private readonly textDecoder = new TextDecoder('utf-8', { fatal: false })

  /** Literal text scan: one decoded row per iteration. */
  private async scanTextRows(
    token: number,
    query: string,
    totalRows: number,
    buffer: ScanBuffer,
  ): Promise<void> {
    for (let i = 0; i < totalRows; i++) {
      if (token !== this.scanToken || this.state.cancelled) {
        throw new FilterCancelledError('Filter cancelled')
      }
      const text = await this.rowText(i)
      if (text.includes(query)) this.addMatch(buffer, i)
      if (
        (i + 1) % PROGRESS_INTERVAL_ROWS === 0 &&
        this.state.operationId &&
        this.shouldEmitProgress()
      ) {
        this.emitProgress(i + 1, buffer.count, totalRows)
      }
    }
  }

  /**
   * jq scan: batches of row texts go through the runtime (one jq call per
   * batch). Edit overrides are substituted into the batch as their text,
   * so an edited row is judged by its edited content without a source read.
   */
  private async scanJqRows(
    token: number,
    program: string,
    totalRows: number,
    buffer: ScanBuffer,
  ): Promise<void> {
    const isAborted = () => token !== this.scanToken || this.state.cancelled
    let i = 0
    while (i < totalRows) {
      if (isAborted()) throw new FilterCancelledError('Filter cancelled')
      // Batch bounds: row count and decoded bytes (a single oversized row
      // still gets its own batch).
      let end = i
      let count = 0
      let bytes = 0
      while (end < totalRows && count < JQ_BATCH_MAX_ROWS && bytes < JQ_BATCH_MAX_BYTES) {
        const len =
          this.indexer.getLineEnd(end) - this.indexer.getLineStart(end) + 1
        if (len > 0) {
          count++
          bytes += len
        }
        end++
      }
      const rows: string[] = []
      for (let k = i; k < end; k++) rows.push(await this.rowText(k))
      const result = await this.jq?.runVerdicts(program, rows, isAborted)
      if (result === undefined) {
        throw new Error('jq runtime not available (kind "jq" requires options.jq)')
      }
      for (let k = 0; k < rows.length; k++) {
        if (result.verdicts[k] === true) this.addMatch(buffer, i + k)
        if (result.errorRows[k] && buffer.errorFlags !== null) buffer.errorFlags[i + k] = 1
      }
      buffer.errors += result.errorCount
      if (result.firstError !== undefined && buffer.firstError === null) {
        buffer.firstError = result.firstError
      }
      i = end
      if (this.state.operationId && this.shouldEmitProgress()) {
        this.emitProgress(end, buffer.count, totalRows)
      }
    }
  }

  private addMatch(
    buffer: { rows: Uint32Array; count: number },
    rowIndex: number,
  ): void {
    if (buffer.count >= buffer.rows.length) {
      const grown = new Uint32Array(buffer.rows.length * 2)
      grown.set(buffer.rows)
      buffer.rows = grown
    }
    buffer.rows[buffer.count] = rowIndex
    buffer.count++
  }

  /**
   * Row bytes via aligned sequential chunk reads (TSK0053): a per-row
   * `readRange` is a full spool round-trip (~0.3 ms on OPFS) — 400k rows
   * meant minutes. A scan walks rows in order, so one cached read
   * (aligned to the OPFS part size, spanning two parts) covers ~8k rows;
   * a row longer than the span fetches exactly its own length. Source
   * bytes are immutable (edits live in the override map), so the cache
   * never needs invalidation.
   */
  private async readRowBytes(rowIndex: number): Promise<Uint8Array> {
    const lineStart = this.indexer.getLineStart(rowIndex)
    const lineEnd = this.indexer.getLineEnd(rowIndex)
    const length = lineEnd - lineStart + 1
    if (length <= 0) return EMPTY_BYTES
    const covered =
      this.chunkBytes !== null &&
      lineStart >= this.chunkStart &&
      lineEnd < this.chunkStart + this.chunkBytes.length
    if (!covered) {
      const start = Math.floor(lineStart / SCAN_CHUNK_BYTES) * SCAN_CHUNK_BYTES
      const span =
        lineEnd >= start + 2 * SCAN_CHUNK_BYTES
          ? lineEnd - start + 1 // a single row longer than the span
          : 2 * SCAN_CHUNK_BYTES
      this.chunkBytes = await this.source.readRange(start, span)
      this.chunkStart = start
    }
    return this.chunkBytes!.subarray(
      lineStart - this.chunkStart,
      lineEnd - this.chunkStart + 1,
    )
  }

  /**
   * Display text of a row for the text scan: edit override when present,
   * else the source bytes. Blank rows decode to '' (they match the empty
   * query and only it).
   */
  private async rowText(rowIndex: number): Promise<string> {
    const override = this.getEditOverride(rowIndex + 1)
    if (override !== null) return override
    return this.textDecoder.decode(await this.readRowBytes(rowIndex))
  }


  private shouldEmitProgress(): boolean {
    const now = performance.now()
    if (now - this.lastProgressTime >= 50) {
      this.lastProgressTime = now
      return true
    }
    return false
  }

  private emitProgress(scannedRows: number, matchedRows: number, totalRows: number): void {
    if (!this.state.operationId) return
    this.postEvent({
      ns: PROTOCOL_NAMESPACE,
      v: PROTOCOL_VERSION,
      operationId: this.state.operationId,
      type: 'filterProgress',
      matchedRows,
      scannedRows,
      totalRows,
      progress: totalRows > 0 ? Math.min(100, (scannedRows / totalRows) * 100) : 100,
    })
  }

  /** Compiles a jq filter (parse-checked) via the injected runtime. */
  private async compileJq(query: string): Promise<string> {
    if (this.jq === undefined) {
      throw new Error('jq runtime not available (kind "jq" requires options.jq)')
    }
    return this.jq.compile(query)
  }
}
