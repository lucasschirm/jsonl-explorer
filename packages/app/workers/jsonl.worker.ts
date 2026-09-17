/**
 * JSONL Worker - Worker thread implementation
 *
 * Handles JSONL file indexing, filtering, row access, editing, and export.
 * Runs in a Web Worker to avoid blocking the main thread.
 */

/// <reference path="./worker.d.ts" />

import type {
  WorkerRequest,
  WorkerResponse,
  WorkerEvent,
  ProgressEvent,
  IndexProgressEvent,
  IndexCompleteEvent,
  FilterProgressEvent,
  FilterCompleteEvent,
  InitFileRequest,
  InitUrlRequest,
  InitMemoryRequest,
  IndexRequest,
  FilterRequest,
  GetRowsRequest,
  GetLineRequest,
  LinePositionRequest,
  SetEditRequest,
  ExportStartRequest,
  ExportNextRequest,
  ExportAckRequest,
  ExportCancelRequest,
  UrlFallbackConfirmResponse,
  CancelRequest,
  DisposeRequest,
  ErrorCode,
  RpcResponse,
  RowData,
  LineId,
  DisplayIndex,
  Generation,
} from '@jsonl-explorer/shared'

import { PROTOCOL_NAMESPACE, PROTOCOL_VERSION } from '@jsonl-explorer/shared'

import {
  FileSource,
  MemorySource,
  PayloadTooLargeError,
  SourceDisposedError,
} from '../engine/sources/index.js'
import type { JsonlSource } from '../engine/sources/index.js'
import {
  FallbackDeclinedError,
  SpoolQuotaExceededError,
  SpoolSource,
  UrlCorsDeniedError,
  UrlDownloader,
  UrlFetchError,
  UrlInvalidHeadersError,
  UrlRedirectDeniedError,
  UrlValidationError,
  cleanupStaleSpools,
  redactUrl,
  urlFileName,
} from '../engine/spool/index.js'
import { IndexAbortedError, JsonlScanner } from '../engine/scanner.js'
import type { ScanProgress, ScanResult } from '../engine/scanner.js'
import { offsetToNumber } from '../engine/indexer.js'
import { ENGINE_DEFAULTS } from '../engine/config/adr.js'
import { escapeForSingleLine } from '../utils/rowPreview.js'

/** Max ORIGINAL-row bytes transferred per list row (preview cap, R12). */
const PREVIEW_ROW_BYTES = ENGINE_DEFAULTS.rowPreviewByteLimit

/** Decode row bytes; invalid UTF-8 becomes U+FFFD (never throws). */
function decodeRowBytes(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  }
}

// Re-export shared types
export type {
  WorkerRequest,
  WorkerResponse,
  WorkerEvent,
  ProgressEvent,
  RowData,
  LineId,
  DisplayIndex,
  Generation,
  ErrorCode,
} from '@jsonl-explorer/shared'

// ============================================================================
// Constants
// ============================================================================

const PROGRESS_INTERVAL_ROWS = 1000

// ============================================================================
// Source State
// ============================================================================

/**
 * URL sources are spooled in the engine (`engine/spool`): `UrlDownloader`
 * fetches and streams into an `OpfsSpool` (or a consented `PagedMemoryStore`
 * fallback); the sealed spool is exposed to the engine as a `SpoolSource`.
 * The download runs inside the `initUrl` RPC, so progress/consent events
 * stream while the request is pending and `cancel` aborts the fetch.
 */
let activeInit: { operationId: string; controller: AbortController } | null = null
let pendingFallbackConfirm: { operationId: string; resolve: (accept: boolean) => void } | null = null
/** Indexer/declared-size of the in-flight URL download (set on spool creation). */
let activeIndexer: Indexer | null = null
let activeDeclaredBytes: bigint | undefined

/** Resets worker-owned state before (re)initializing a source. */
async function resetSourceState(): Promise<void> {
  if (source) {
    await source.dispose().catch(() => {})
    source = null
  }
  indexer = null
  filterEngine = null
  activeIndexer = null
  activeDeclaredBytes = undefined
  exportStates.clear()
  currentGeneration = 0
}

/** Best-effort sweep of spool artifacts left behind by crashed sessions. */
async function cleanupStaleSpoolsBestEffort(): Promise<void> {
  const storage = navigator.storage
  if (!storage || typeof storage.getDirectory !== 'function') return
  try {
    const root = await storage.getDirectory()
    await cleanupStaleSpools(root)
  } catch {
    // OPFS unavailable or locked: nothing to clean.
  }
}

void cleanupStaleSpoolsBestEffort()

// ============================================================================
// Indexer
// ============================================================================

/**
 * Worker-side indexer: a thin adapter over the engine's `JsonlScanner`.
 *
 * The scanner owns the byte scan, the N+1 bigint offset index, and row
 * semantics (see `engine/scanner.ts`). This adapter maps scanner state to the
 * RPC surface: number-based row byte ranges (converted with a safe-integer
 * check only at this boundary), protocol progress/complete events, and
 * operation-scoped cancellation via AbortController.
 */
class Indexer {
  private readonly source: JsonlSource
  private scanner: JsonlScanner
  private operationId: string | null = null
  private abortController: AbortController | null = null
  private scanAborted = false
  private lastProgressTime = 0

  /** Absolute offset of the next byte to feed (incremental mode). */
  private fedOffset = 0n

  constructor(source: JsonlSource) {
    this.source = source
    this.scanner = new JsonlScanner(source)
  }

  setOperationId(operationId: string): void {
    this.operationId = operationId
  }

  cancel(): void {
    this.abortController?.abort()
  }

  /**
   * Runs the scan and emits indexProgress events. The indexComplete event
   * is emitted by the CALLER (handleIndex): it owns the generation counter,
   * which must only bump on success, and the event must carry the
   * post-commit generation (R-cache invalidation).
   */
  async index(): Promise<{ totalRows: number; totalBytes: number; invalidUtf8Rows: number; durationMs: number }> {
    // A scanner is single-use: after completion or abort, start a fresh one
    // so index requests can be retried (e.g. after a user cancel). A
    // feed-driven scanner (URL download) must also be replaced: `scan()`
    // and `feed()` cannot mix on one scanner.
    if (this.scanner.isComplete() || this.scanAborted || this.scanner.isStarted()) {
      this.scanner = new JsonlScanner(this.source)
      this.scanAborted = false
      this.fedOffset = 0n
    }
    this.abortController = new AbortController()
    const startedAt = performance.now()
    let result: Awaited<ReturnType<JsonlScanner['scan']>>
    try {
      result = await this.scanner.scan({
        signal: this.abortController.signal,
        onProgress: (p) => this.emitIndexProgress(p),
      })
    } catch (error) {
      if (error instanceof IndexAbortedError) this.scanAborted = true
      throw error
    }
    return {
      totalRows: result.totalRows,
      totalBytes: Number(result.totalBytes),
      invalidUtf8Rows: result.invalidUtf8Rows,
      durationMs: Math.round(performance.now() - startedAt),
    }
  }

  /** Byte start of a row's displayed range (safe-integer checked). */
  getLineStart(row: number): number {
    return offsetToNumber(this.scanner.getStart(row))
  }

  /** Inclusive byte end of a row's displayed range (CR/LF stripped). */
  getLineEnd(row: number): number {
    return offsetToNumber(this.scanner.getDisplayEnd(row)) - 1
  }

  /** Rows committed so far (grows while a scan is in flight). */
  getCommittedRows(): number {
    return this.scanner.getRowCount()
  }

  isComplete(): boolean {
    return this.scanner.isComplete()
  }

  getHasCRLF(): boolean {
    return this.scanner.getHasCRLF()
  }

  getInvalidUtf8Rows(): number {
    return this.scanner.getInvalidUtf8Rows()
  }

  /**
   * Incrementally indexes the bytes newly available in the source (from
   * the last fed offset to the current size). Rows committed by feeds are
   * immediately queryable — this is what makes rows visible while a URL
   * download streams. Emits throttled `indexProgress` events; `totalBytes`
   * is only included for determinate (unencoded Content-Length) sources.
   * @throws {IndexAbortedError} when `signal` is aborted between steps.
   */
  async indexDelta(options: {
    operationId?: string
    totalBytes?: bigint
    signal?: AbortSignal
  }): Promise<void> {
    const size = await this.source.getSize()
    while (this.fedOffset < size) {
      if (options.signal?.aborted) throw new IndexAbortedError()
      const remaining = size - this.fedOffset
      const want = remaining < BigInt(this.scanner.chunkSize) ? Number(remaining) : this.scanner.chunkSize
      const chunk = await this.source.readRange(this.fedOffset, want)
      this.scanner.feed(chunk, this.fedOffset)
      this.fedOffset += BigInt(chunk.length)
      this.emitDeltaProgress(options)
    }
  }

  /** Completes an incremental feed at the source's final size. */
  async finishDelta(): Promise<ScanResult> {
    return this.scanner.finish(await this.source.getSize())
  }

  private emitDeltaProgress(options: { operationId?: string; totalBytes?: bigint }): void {
    if (!options.operationId) return
    const now = performance.now()
    if (now - this.lastProgressTime < 50) return
    this.lastProgressTime = now
    const total = options.totalBytes
    const event: IndexProgressEvent = {
      ns: PROTOCOL_NAMESPACE,
      v: PROTOCOL_VERSION,
      type: 'indexProgress',
      operationId: options.operationId,
      progress: total !== undefined && total > 0n ? Number((this.fedOffset * 100n) / total) : 0,
      committedRows: this.scanner.getRowCount(),
      committedBytes: Number(this.fedOffset),
      rowsProcessed: this.scanner.getRowCount(),
      totalBytes: total !== undefined ? Number(total) : undefined,
    }
    self.postMessage(event)
  }

  private emitIndexProgress(p: ScanProgress): void {
    if (!this.operationId || !this.shouldEmitProgress()) return
    const event: IndexProgressEvent = {
      ns: 'jsonl-explorer',
      v: 1,
      type: 'indexProgress',
      operationId: this.operationId,
      progress: p.totalBytes === 0n ? 100 : Number((p.bytesScanned * 100n) / p.totalBytes),
      rowsProcessed: p.rowsCommitted,
      committedRows: p.rowsCommitted,
      committedBytes: Number(p.bytesScanned),
    }
    self.postMessage(event)
  }

  private shouldEmitProgress(): boolean {
    const now = performance.now()
    if (now - this.lastProgressTime >= 50) {
      this.lastProgressTime = now
      return true
    }
    return false
  }
}

// ============================================================================
// Filter Engine
// ============================================================================

interface FilterState {
  kind: 'text' | 'jq'
  query: string
  jqProgram: any | null
  matchedRows: Uint32Array
  matchedCount: number
  operationId: string | null
  cancelled: boolean
}

class FilterEngine {
  private indexer: Indexer
  private source: JsonlSource
  private state: FilterState
  private lastProgressTime = 0
  private lastProgressRows = 0
  /**
   * False until a filter completes: the view is the UNFILTERED identity
   * (display index i == row i). A filter that matches nothing is still a
   * filtered (empty) view — the flag, not the count, disambiguates.
   */
  private hasFilter = false

  constructor(indexer: Indexer, source: JsonlSource) {
    this.indexer = indexer
    this.source = source
    this.state = {
      kind: 'text',
      query: '',
      jqProgram: null,
      matchedRows: new Uint32Array(1024),
      matchedCount: 0,
      operationId: null,
      cancelled: false,
    }
  }

  /** True once a filter completed; false = unfiltered identity view. */
  isFiltered(): boolean {
    return this.hasFilter
  }

  /** Row count of the current view (all committed rows when unfiltered). */
  matchCount(): number {
    return this.hasFilter ? this.state.matchedCount : this.indexer.getCommittedRows()
  }

  /** Map a display index to its source row index (identity when unfiltered). */
  rowAt(displayIndex: number): number {
    if (!this.hasFilter) return displayIndex
    return this.state.matchedRows[displayIndex] ?? 0
  }

  /**
   * Display index of a stable source line in the CURRENT view, or null
   * when it is not part of the view (filtered out, or past the committed
   * rows while indexing). O(log n) on the matched snapshot.
   */
  positionOfLine(lineId: number): number | null {
    const row = lineId - 1
    if (row < 0) return null
    if (!this.hasFilter) {
      return row < this.indexer.getCommittedRows() ? row : null
    }
    const rank = binarySearchRow(this.state.matchedRows, this.state.matchedCount, row)
    return rank === -1 ? null : rank
  }

  setOperationId(operationId: string): void {
    this.state.operationId = operationId
  }

  cancel(): void {
    this.state.cancelled = true
  }

  async filter(kind: 'text' | 'jq', query: string): Promise<{ matchedRows: number; totalRows: number }> {
    this.state.kind = kind
    this.state.query = query
    this.state.cancelled = false
    this.state.matchedCount = 0

    if (kind === 'jq') {
      try {
        const jqModule = await import('jq-web')
        this.state.jqProgram = await jqModule.compile(query)
      } catch (error) {
        throw new Error(`Invalid jq program: ${error instanceof Error ? error.message : String(error)}`)
      }
    } else {
      this.state.jqProgram = null
    }

    const totalRows = this.indexer.getCommittedRows()
    this.ensureCapacity(totalRows)

    let matchedCount = 0
    let errorCount = 0

    for (let i = 0; i < totalRows && !this.state.cancelled; i++) {
      const lineStart = this.indexer.getLineStart(i)
      const lineEnd = this.indexer.getLineEnd(i)
      const length = lineEnd - lineStart + 1

      if (length <= 0) continue

      const lineBytes = await this.source.readRange(lineStart, length)
      let matches = false

      try {
        if (kind === 'text') {
          const text = new TextDecoder('utf-8', { fatal: true }).decode(lineBytes)
          matches = text.includes(query)
        } else {
          const text = new TextDecoder('utf-8', { fatal: false }).decode(lineBytes)
          const json = JSON.parse(text)
          const results = this.state.jqProgram(json)
          matches = results.some((r: any) => r !== false && r !== null && r !== undefined)
        }
      } catch (error) {
        errorCount++
        continue
      }

      if (matches) {
        this.addMatch(i)
        matchedCount++
      }

      if ((i + 1) % PROGRESS_INTERVAL_ROWS === 0 && this.state.operationId && this.shouldEmitProgress()) {
        const event = {
          ns: 'jsonl-explorer',
          v: 1,
          type: 'filterProgress',
          operationId: this.state.operationId!,
          progress: Math.min(100, ((i + 1) / totalRows) * 100),
          matchedRows: matchedCount,
          scannedRows: i + 1,
        }
        self.postMessage(event)
      }
    }

    if (this.state.cancelled) {
      throw new Error('Filter cancelled')
    }

    // The view only becomes "filtered" on success: a failed/cancelled
    // scan must not replace the previous view (identity or last filter).
    this.hasFilter = true

    return { matchedRows: matchedCount, totalRows }
  }

  private ensureCapacity(capacity: number): void {
    if (this.state.matchedRows.length >= capacity) return
    const newCapacity = Math.max(this.state.matchedRows.length * 2, capacity)
    const newRows = new Uint32Array(newCapacity)
    newRows.set(this.state.matchedRows)
    this.state.matchedRows = newRows
  }

  private addMatch(rowIndex: number): void {
    if (this.state.matchedCount >= this.state.matchedRows.length) {
      const newCapacity = this.state.matchedRows.length * 2
      const newRows = new Uint32Array(newCapacity)
      newRows.set(this.state.matchedRows)
      this.state.matchedRows = newRows
    }
    this.state.matchedRows[this.state.matchedCount] = rowIndex
    this.state.matchedCount++
  }

  private shouldEmitProgress(): boolean {
    const now = performance.now()
    if (now - this.lastProgressTime >= 50) {
      this.lastProgressTime = now
      return true
    }
    return false
  }

  getMatchedRows(): Uint32Array {
    return this.state.matchedRows.subarray(0, this.state.matchedCount)
  }

  getMatchedCount(): number {
    return this.state.matchedCount
  }

  isCancelled(): boolean {
    return this.state.cancelled
  }
}

// ============================================================================
// Export Engine
// ============================================================================

interface ExportState {
  token: string
  generation: number
  /** Filtered snapshot; empty when the view is unfiltered (identity). */
  matchedRows: Uint32Array
  hasFilter: boolean
  matchedCount: number
  currentIndex: number
  cancelled: boolean
}

/** Resolve an export's display index to a source row (identity-aware). */
function exportRowAt(state: ExportState, displayIndex: number): number {
  return state.hasFilter ? (state.matchedRows[displayIndex] ?? 0) : displayIndex
}

const exportStates = new Map<string, ExportState>()

// ============================================================================
// Main Worker Logic
// ============================================================================

let source: JsonlSource | null = null
let indexer: Indexer | null = null
let filterEngine: FilterEngine | null = null
let currentGeneration = 0

function createErrorResponse(requestId: string, code: ErrorCode, message: string, details?: Record<string, unknown>): WorkerResponse {
  return {
    ns: 'jsonl-explorer',
    v: 1,
    requestId,
    ok: false,
    error: { code, message, details },
  }
}

function createSuccessResponse<T>(requestId: string, value: T): WorkerResponse {
  return {
    ns: 'jsonl-explorer',
    v: 1,
    requestId,
    ok: true,
    value,
  } as WorkerResponse
}

function createRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
}

self.onmessage = async (event: MessageEvent) => {
  const request = event.data as WorkerRequest

  // Fast path: answer a pending in-memory fallback consent while `initUrl`
  // is still awaiting its download (concurrent handler invocations).
  if (request.type === 'urlFallbackConfirm') {
    handleUrlFallbackConfirm(request)
    return
  }

  try {
    switch (request.type) {
      case 'initFile': {
        await handleInitFile(request)
        break
      }
      case 'initUrl': {
        await handleInitUrl(request)
        break
      }
      case 'initMemory': {
        await handleInitMemory(request)
        break
      }
      case 'index': {
        await handleIndex(request)
        break
      }
      case 'filter': {
        await handleFilter(request)
        break
      }
      case 'getRows': {
        await handleGetRows(request)
        break
      }
      case 'getLine': {
        await handleGetLine(request)
        break
      }
      case 'linePosition': {
        await handleLinePosition(request)
        break
      }
      case 'setEdit': {
        await handleSetEdit(request)
        break
      }
      case 'exportStart': {
        await handleExportStart(request)
        break
      }
      case 'exportNext': {
        await handleExportNext(request)
        break
      }
      case 'exportAck': {
        await handleExportAck(request)
        break
      }
      case 'exportCancel': {
        await handleExportCancel(request)
        break
      }
      case 'cancel': {
        await handleCancel(request)
        break
      }
      case 'dispose': {
        await handleDispose(request)
        break
      }
      default: {
        const unknownRequest = request as { requestId: string; type: string }
        const response = createErrorResponse(unknownRequest.requestId, 'INVALID_REQUEST', `Unknown request type: ${unknownRequest.type}`)
        self.postMessage(response)
      }
    }
  } catch (error) {
    const response = createErrorResponse(
      request.requestId,
      errorToErrorCode(error),
      error instanceof Error ? error.message : String(error),
    )
    self.postMessage(response)
  }
}

/** Maps engine errors to protocol error codes so failures stay typed. */
function errorToErrorCode(error: unknown): ErrorCode {
  if (error instanceof PayloadTooLargeError) return 'HANDOVER_PAYLOAD_TOO_LARGE'
  if (error instanceof SourceDisposedError) return 'SOURCE_NOT_INITIALIZED'
  if (error instanceof IndexAbortedError) return 'INDEXING_CANCELLED'
  if (error instanceof UrlValidationError) return 'URL_INVALID'
  if (error instanceof UrlInvalidHeadersError) return 'URL_INVALID_HEADERS'
  if (error instanceof UrlCorsDeniedError) return 'URL_CORS_DENIED'
  if (error instanceof UrlRedirectDeniedError) return 'URL_REDIRECT_DENIED'
  if (error instanceof UrlFetchError) return 'URL_FETCH_FAILED'
  if (error instanceof FallbackDeclinedError) return 'URL_FALLBACK_DECLINED'
  if (error instanceof SpoolQuotaExceededError) return 'OPFS_QUOTA_EXCEEDED'
  if (error instanceof Error && error.name === 'AbortError') return 'CANCELLED'
  return 'UNKNOWN'
}

/** Resolves the pending `urlFallbackConfirm` waiter, if the ID matches. */
function handleUrlFallbackConfirm(request: UrlFallbackConfirmResponse): void {
  const pending = pendingFallbackConfirm
  if (!pending || pending.operationId !== request.operationId) return
  pendingFallbackConfirm = null
  pending.resolve(request.accept)
}

async function handleInitFile(request: InitFileRequest): Promise<void> {
  await resetSourceState()
  source = new FileSource(request.file)
  indexer = new Indexer(source)
  filterEngine = new FilterEngine(indexer, source)

  const response = createSuccessResponse(request.requestId, {
    name: request.file.name,
    size: request.file.size,
    type: 'file',
  })
  self.postMessage(response)
}

async function handleInitUrl(request: InitUrlRequest): Promise<void> {
  await resetSourceState()
  const controller = new AbortController()
  activeInit = { operationId: request.operationId, controller }
  const startedAt = performance.now()
  const downloader = new UrlDownloader({
    headers: request.headers,
    signal: controller.signal,
    pageOrigin: request.pageOrigin,
    // The spool exists before the first byte streams: wrap it immediately so
    // rows become queryable (getRows/getLine/filter) during the download.
    // Fires again if a mid-stream quota failure replaces the spool.
    onSpoolCreated: (info) => {
      // Replaces the previous wrapper if a mid-stream quota failure swapped
      // the spool (its underlying spool was already disposed by the downloader).
      if (source) {
        void source.dispose().catch(() => {})
      }
      const src = new SpoolSource(urlFileName(info.finalUrl), info.spool)
      source = src
      indexer = new Indexer(src)
      filterEngine = new FilterEngine(indexer, src)
      activeIndexer = indexer
      activeDeclaredBytes = info.declaredBytes
    },
    onProgress: async (progress) => {
      self.postMessage({
        ns: PROTOCOL_NAMESPACE,
        v: PROTOCOL_VERSION,
        type: 'urlProgress',
        operationId: request.operationId,
        receivedBytes: progress.receivedBytes,
        totalBytes: progress.totalBytes,
      })
      // Index the newly spooled bytes (awaited: an aborted incremental
      // index fails the init). Map IndexAbortedError to the standard
      // AbortError so a user cancel surfaces as CANCELLED, matching the
      // fetch-abort path.
      try {
        await activeIndexer?.indexDelta({
          operationId: request.operationId,
          totalBytes: activeDeclaredBytes,
          signal: controller.signal,
        })
      } catch (error) {
        if (error instanceof IndexAbortedError) {
          throw new DOMException('aborted', 'AbortError')
        }
        throw error
      }
    },
    onFallbackRequest: async (info) => {
      self.postMessage({
        ns: PROTOCOL_NAMESPACE,
        v: PROTOCOL_VERSION,
        type: 'urlFallbackConfirm',
        operationId: request.operationId,
        url: redactUrl(request.url),
        declaredBytes: info.declaredBytes,
        reason: info.reason,
      })
      return await new Promise<boolean>((resolve) => {
        pendingFallbackConfirm = { operationId: request.operationId, resolve }
      })
    },
  })
  try {
    const result = await downloader.download(request.url)
    const idx = indexer
    if (!idx) throw new Error('URL spool was not initialized')
    const stats = await idx.finishDelta()

    currentGeneration++
    const completeEvent: IndexCompleteEvent = {
      ns: PROTOCOL_NAMESPACE,
      v: PROTOCOL_VERSION,
      type: 'indexComplete',
      operationId: request.operationId,
      totalRows: stats.totalRows,
      totalBytes: Number(stats.totalBytes),
      durationMs: Math.round(performance.now() - startedAt),
      generation: currentGeneration,
    }
    self.postMessage(completeEvent)

    const response = createSuccessResponse(request.requestId, {
      name: result.name,
      size: Number(stats.totalBytes),
      type: 'url',
    })
    self.postMessage(response)
  } catch (error) {
    // A failed/aborted download leaves a disposed spool behind; drop the
    // worker's reference so the next init starts from a clean state. The
    // error still propagates to the generic handler for the response.
    await resetSourceState()
    throw error
  } finally {
    activeInit = null
    activeIndexer = null
    activeDeclaredBytes = undefined
    if (pendingFallbackConfirm?.operationId === request.operationId) {
      pendingFallbackConfirm = null
    }
  }
}

async function handleInitMemory(request: InitMemoryRequest): Promise<void> {
  await resetSourceState()
  source = new MemorySource(request.name, request.payload)
  indexer = new Indexer(source)
  filterEngine = new FilterEngine(indexer, source)

  const size = await source.getSize()
  const response = createSuccessResponse(request.requestId, {
    name: request.name,
    size: Number(size),
    type: 'handover',
  })
  self.postMessage(response)
}

async function handleIndex(request: IndexRequest): Promise<void> {
  if (!indexer) {
    const response = createErrorResponse(request.requestId, 'SOURCE_NOT_INITIALIZED', 'Source not initialized')
    self.postMessage(response)
    return
  }

  indexer.setOperationId(request.operationId)

  try {
    const { totalRows, totalBytes, invalidUtf8Rows, durationMs } = await indexer.index()

    currentGeneration++

    // The commit changes which rows exist: main-thread row caches are
    // keyed by generation and must invalidate (R12/memory).
    const event: IndexCompleteEvent = {
      ns: PROTOCOL_NAMESPACE,
      v: PROTOCOL_VERSION,
      type: 'indexComplete',
      operationId: request.operationId,
      totalRows,
      totalBytes,
      durationMs,
      generation: currentGeneration,
    }
    self.postMessage(event)

    const response = createSuccessResponse(request.requestId, {
      totalRows,
      totalBytes,
      invalidUtf8Rows,
    })
    self.postMessage(response)
  } catch (error) {
    const code = error instanceof IndexAbortedError ? 'INDEXING_CANCELLED' : 'INDEXING_FAILED'
    const response = createErrorResponse(request.requestId, code, error instanceof Error ? error.message : String(error))
    self.postMessage(response)
  }
}

async function handleFilter(request: FilterRequest): Promise<void> {
  if (!filterEngine) {
    const response = createErrorResponse(request.requestId, 'SOURCE_NOT_INITIALIZED', 'Source not initialized')
    self.postMessage(response)
    return
  }

  filterEngine.setOperationId(request.operationId)

  try {
    const { matchedRows, totalRows } = await filterEngine.filter(request.kind, request.query)

    currentGeneration++

    const response = createSuccessResponse(request.requestId, {
      matchedRows,
      totalRows,
      generation: currentGeneration,
    })
    self.postMessage(response)
  } catch (error) {
    const response = createErrorResponse(request.requestId, 'FILTER_FAILED', error instanceof Error ? error.message : String(error))
    self.postMessage(response)
  }
}

async function handleGetRows(request: GetRowsRequest): Promise<void> {
  if (!filterEngine || !indexer) {
    const response = createErrorResponse(request.requestId, 'SOURCE_NOT_INITIALIZED', 'Source not initialized')
    self.postMessage(response)
    return
  }

  // Identity-aware mapping: unfiltered view (display i == row i) or the
  // last completed filter's matched rows (R3 replace semantics).
  const totalFiltered = filterEngine.matchCount()

  const start = request.start
  const count = request.count
  const end = Math.min(start + count, totalFiltered)

  const rows: RowData[] = []

  for (let i = start; i < end; i++) {
    const matchedRowIndex = filterEngine.rowAt(i)
    const lineStart = indexer.getLineStart(matchedRowIndex)
    const lineEnd = indexer.getLineEnd(matchedRowIndex)
    // Full row length comes from the index; only the PREVIEW prefix is
    // read so a huge row (e.g. one 100 MB line) bounds both the read and
    // the message (full detail is fetched separately via getLine).
    const length = lineEnd - lineStart + 1
    const readLength = Math.min(length, PREVIEW_ROW_BYTES)

    const previewBytes = await source!.readRange(lineStart, readLength)

    rows.push({
      lineId: matchedRowIndex + 1,
      displayIndex: i,
      text: escapeForSingleLine(decodeRowBytes(previewBytes)),
      isEdited: false,
      byteLength: length,
    })
  }

  const response = createSuccessResponse(request.requestId, {
    rows,
    generation: currentGeneration,
    totalFiltered,
  })
  self.postMessage(response)
}

/** Index of `row` in matchedRows[0..count) (ascending), or -1. */
function binarySearchRow(rows: Uint32Array, count: number, row: number): number {
  let lo = 0
  let hi = count - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const value = rows[mid] ?? 0
    if (value < row) lo = mid + 1
    else if (value > row) hi = mid - 1
    else return mid
  }
  return -1
}

/**
 * linePosition (TSK0023): the worker's authoritative answer to "is this
 * stable line still in the view, and where?" — selection transitions
 * (keep / replace-with-first / clear) rely on it.
 */
async function handleLinePosition(request: LinePositionRequest): Promise<void> {
  if (!filterEngine || !indexer) {
    const response = createErrorResponse(request.requestId, 'SOURCE_NOT_INITIALIZED', 'Source not initialized')
    self.postMessage(response)
    return
  }

  const displayIndex = filterEngine.positionOfLine(request.lineId)
  const response = createSuccessResponse(request.requestId, {
    lineId: request.lineId,
    visible: displayIndex !== null,
    displayIndex,
    generation: currentGeneration,
  })
  self.postMessage(response)
}

async function handleGetLine(request: GetLineRequest): Promise<void> {
  if (!indexer) {
    const response = createErrorResponse(request.requestId, 'SOURCE_NOT_INITIALIZED', 'Source not initialized')
    self.postMessage(response)
    return
  }

  const lineIndex = request.lineId - 1
  const totalRows = indexer.getCommittedRows()

  if (lineIndex < 0 || lineIndex >= totalRows) {
    const response = createErrorResponse(request.requestId, 'INVALID_LINE_ID', `Line ID ${request.lineId} out of range`)
    self.postMessage(response)
    return
  }

  const lineStart = indexer.getLineStart(lineIndex) ?? 0
  const lineEnd = (indexer.getLineEnd(lineIndex) ?? lineStart)
  const length = lineEnd - lineStart + 1

  // Full, UNescaped text: the detail panel parses it as JSON, so control
  // characters must survive (the list preview escapes, the detail does not).
  const lineBytes = await source!.readRange(lineStart, length)

  const response = createSuccessResponse(request.requestId, {
    lineId: request.lineId,
    text: decodeRowBytes(lineBytes),
    isEdited: false,
  })
  self.postMessage(response)
}

async function handleSetEdit(request: SetEditRequest): Promise<void> {
  const response = createErrorResponse(request.requestId, 'EDIT_FAILED', 'Edit not implemented in worker yet')
  self.postMessage(response)
}

async function handleExportStart(request: ExportStartRequest): Promise<void> {
  if (!filterEngine) {
    const response = createErrorResponse(request.requestId, 'SOURCE_NOT_INITIALIZED', 'Source not initialized')
    self.postMessage(response)
    return
  }

  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
  const matchedCount = filterEngine.matchCount()
  const hasFilter = filterEngine.isFiltered()
  // Only a FILTERED view copies its (bounded) snapshot; an identity view
  // must never materialize a row array the size of the whole file.
  const snapshot = hasFilter
    ? filterEngine.getMatchedRows().slice(0, filterEngine.getMatchedCount())
    : new Uint32Array(0)

  exportStates.set(token, {
    token,
    generation: request.generation,
    matchedRows: snapshot,
    hasFilter,
    matchedCount,
    currentIndex: 0,
    cancelled: false,
  })

  let estimatedBytes = 0
  const indexerInstance = indexer!
  const sampleCount = Math.min(matchedCount, 100)
  for (let i = 0; i < sampleCount; i++) {
    const row = exportRowAt(exportStates.get(token)!, i)
    const lineStart = indexerInstance.getLineStart(row)
    const lineEnd = indexerInstance.getLineEnd(row)
    estimatedBytes += ((lineEnd ?? 0) - (lineStart ?? 0) + 2)
  }
  estimatedBytes = sampleCount > 0 ? Math.round(estimatedBytes * (matchedCount / sampleCount)) : 0

  const response = createSuccessResponse(request.requestId, {
    token,
    estimatedBytes,
    totalRows: matchedCount,
  })
  self.postMessage(response)
}

async function handleExportNext(request: ExportNextRequest): Promise<void> {
  const state = exportStates.get(request.token)
  if (!state) {
    const response = createErrorResponse(request.requestId, 'EXPORT_TOKEN_INVALID', 'Invalid or expired export token')
    self.postMessage(response)
    return
  }

  if (state.cancelled || state.currentIndex >= state.matchedCount) {
    const response = createSuccessResponse(request.requestId, {
      data: new Uint8Array(0),
      done: true,
      rowsExported: state.matchedCount,
    })
    self.postMessage(response)
    return
  }

  const indexerInstance = indexer!
  const sourceInstance = source!
  const matchedRowIndex = exportRowAt(state, state.currentIndex)
  const lineStart = indexerInstance.getLineStart(matchedRowIndex) ?? 0
  const lineEnd = indexerInstance.getLineEnd(matchedRowIndex) ?? lineStart
  const length = (lineEnd ?? 0) - (lineStart ?? 0) + 1

  const lineBytes = await sourceInstance.readRange(lineStart, length)
  const text = new TextDecoder('utf-8', { fatal: false }).decode(lineBytes)

  const exportText = text.endsWith('\n') ? text : text + '\n'
  const exportBytes = new TextEncoder().encode(exportText)

  state.currentIndex++

  const response = createSuccessResponse(request.requestId, {
    data: exportBytes,
    done: state.currentIndex >= state.matchedCount,
    rowsExported: state.currentIndex,
  })
  self.postMessage(response)
}

async function handleExportAck(request: ExportAckRequest): Promise<void> {
  const state = exportStates.get(request.token)
  if (state) {
    state.cancelled = true
    exportStates.delete(request.token)
  }
  const response = createSuccessResponse(request.requestId, { acknowledged: true })
  self.postMessage(response)
}

async function handleExportCancel(request: ExportCancelRequest): Promise<void> {
  const state = exportStates.get(request.token)
  if (state) {
    state.cancelled = true
    exportStates.delete(request.token)
  }
  const response = createSuccessResponse(request.requestId, { cancelled: true })
  self.postMessage(response)
}

async function handleCancel(request: CancelRequest): Promise<void> {
  // Cancellation is operation-scoped: in-flight index/filter runs observe the
  // abort on their next chunk/row boundary and reject with typed errors.
  if (activeInit && activeInit.operationId === request.operationId) {
    activeInit.controller.abort()
  }
  indexer?.cancel()
  filterEngine?.cancel()
  const response = createSuccessResponse(request.requestId, {})
  self.postMessage(response)
}

async function handleDispose(request: DisposeRequest): Promise<void> {
  await resetSourceState()
  await cleanupStaleSpoolsBestEffort()

  const response = createSuccessResponse(request.requestId, { disposed: true })
  self.postMessage(response)
}

self.addEventListener('unload', () => {
  if (source) {
    source.dispose().catch(console.error)
  }
})
