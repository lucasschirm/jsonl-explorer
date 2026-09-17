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
 *
 * Memory stays bounded by the source index plus match IDs: row text is
 * decoded per row and immediately dropped; the match index itself is a
 * Uint32Array (4 bytes per matched row).
 */

import { PROTOCOL_NAMESPACE, PROTOCOL_VERSION } from '@jsonl-explorer/shared'
import type { FilterProgressEvent } from '@jsonl-explorer/shared'

/** Rows per progress emission (time-throttled further by the caller). */
export const PROGRESS_INTERVAL_ROWS = 1000

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
}

export interface FilterScanResult {
  matchedRows: number
  totalRows: number
  /** True when only the committed snapshot was scanned (indexing live). */
  partial: boolean
  durationMs: number
  errorCount: number
}

interface FilterState {
  kind: 'text' | 'jq'
  query: string
  /** Compiled jq program (null for text kind). */
  jqProgram: ((input: unknown) => unknown[]) | null
  /** Ascending original-row IDs of matches (only [0, matchedCount) live). */
  matchedRows: Uint32Array
  matchedCount: number
  operationId: string | null
  cancelled: boolean
}

function decodeForFilter(bytes: Uint8Array): string {
  // Replacement-character decoding (U+FFFD), never throws: the filter must
  // match what the UI shows for invalid-UTF-8 rows.
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
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

/** jq truthiness: any output except false/null is a match; none = no match. */
function jqTruthy(program: (input: unknown) => unknown[], json: unknown): boolean {
  for (const result of program(json)) {
    if (result !== false && result !== null && result !== undefined) return true
  }
  return false
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
    const jqProgram = kind === 'jq' ? await this.compileJq(query) : null
    const totalRows = this.indexer.getCommittedRows()
    const partial = !this.isIndexComplete()
    const startedAt = performance.now()
    const buffer: { rows: Uint32Array; count: number; errors: number } = {
      rows: new Uint32Array(1024),
      count: 0,
      errors: 0,
    }
    await this.scanRows(token, kind, query, jqProgram, totalRows, buffer)
    // Atomic swap: kind/query/index/count/hasFilter all land together.
    this.state.kind = kind
    this.state.query = query
    this.state.jqProgram = jqProgram
    this.state.matchedRows = buffer.rows
    this.state.matchedCount = buffer.count
    this.hasFilter = true
    return {
      matchedRows: buffer.count,
      totalRows,
      partial,
      durationMs: Math.round(performance.now() - startedAt),
      errorCount: buffer.errors,
    }
  }

  private async scanRows(
    token: number,
    kind: 'text' | 'jq',
    query: string,
    jqProgram: ((input: unknown) => unknown[]) | null,
    totalRows: number,
    buffer: { rows: Uint32Array; count: number; errors: number },
  ): Promise<void> {
    for (let i = 0; i < totalRows; i++) {
      if (token !== this.scanToken || this.state.cancelled) {
        throw new FilterCancelledError('Filter cancelled')
      }
      const outcome = await this.matchesRow(kind, query, jqProgram, i)
      if (outcome === true) {
        this.addMatch(buffer, i)
      } else if (outcome === 'error') {
        buffer.errors++
      }
      if (
        (i + 1) % PROGRESS_INTERVAL_ROWS === 0 &&
        this.state.operationId &&
        this.shouldEmitProgress()
      ) {
        this.emitProgress(i + 1, buffer.count, totalRows)
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

  /** true = match, false = no match, 'error' = row skipped (bad JSON for jq). */
  private async matchesRow(
    kind: 'text' | 'jq',
    query: string,
    jqProgram: ((input: unknown) => unknown[]) | null,
    rowIndex: number,
  ): Promise<boolean | 'error'> {
    const override = this.getEditOverride(rowIndex + 1)
    if (override !== null) {
      return this.testText(kind, query, jqProgram, override)
    }
    const lineStart = this.indexer.getLineStart(rowIndex)
    const lineEnd = this.indexer.getLineEnd(rowIndex)
    const length = lineEnd - lineStart + 1
    // Blank rows are real rows with an empty display range: they match the
    // empty text query (and only it) for kind 'text'.
    if (length <= 0) return this.testText(kind, query, jqProgram, '')
    const bytes = await this.source.readRange(lineStart, length)
    return this.testText(kind, query, jqProgram, decodeForFilter(bytes))
  }

  private testText(
    kind: 'text' | 'jq',
    query: string,
    jqProgram: ((input: unknown) => unknown[]) | null,
    text: string,
  ): boolean | 'error' {
    if (kind === 'text') return text.includes(query)
    if (jqProgram === null) return 'error'
    try {
      return jqTruthy(jqProgram, JSON.parse(text))
    } catch {
      return 'error'
    }
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

  private async compileJq(query: string): Promise<(input: unknown) => unknown[]> {
    // Dynamic import keeps jq-WASM out of the initial worker bundle; the
    // real integration (compile-once, WASM loading under CSP) lands in
    // TSK0027. Until then jq filters fail typed (FILTER_FAILED) when the
    // program is invalid (compile rejects).
    const mod = await import('jq-web')
    const program = await mod.compile(query)
    return program as (input: unknown) => unknown[]
  }
}
