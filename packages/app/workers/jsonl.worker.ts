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
  UrlDownloader,
  UrlFetchError,
  cleanupStaleSpools,
} from '../engine/spool/index.js'
import { IndexAbortedError, JsonlScanner } from '../engine/scanner.js'
import type { ScanProgress } from '../engine/scanner.js'
import { offsetToNumber } from '../engine/indexer.js'

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

/** Resets worker-owned state before (re)initializing a source. */
async function resetSourceState(): Promise<void> {
  if (source) {
    await source.dispose().catch(() => {})
    source = null
  }
  indexer = null
  filterEngine = null
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

  async index(): Promise<{ totalRows: number; totalBytes: number; invalidUtf8Rows: number }> {
    // A scanner is single-use: after completion or abort, start a fresh one
    // so index requests can be retried (e.g. after a user cancel).
    if (this.scanner.isComplete() || this.scanAborted) {
      this.scanner = new JsonlScanner(this.source)
      this.scanAborted = false
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
    if (this.operationId) {
      const event: IndexCompleteEvent = {
        ns: 'jsonl-explorer',
        v: 1,
        type: 'indexComplete',
        operationId: this.operationId,
        totalRows: result.totalRows,
        totalBytes: Number(result.totalBytes),
        durationMs: Math.round(performance.now() - startedAt),
      }
      self.postMessage(event)
    }
    return {
      totalRows: result.totalRows,
      totalBytes: Number(result.totalBytes),
      invalidUtf8Rows: result.invalidUtf8Rows,
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
  matchedRows: Uint32Array
  matchedCount: number
  currentIndex: number
  cancelled: boolean
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
  const downloader = new UrlDownloader({
    headers: request.headers,
    signal: controller.signal,
    onProgress: (progress) => {
      self.postMessage({
        ns: PROTOCOL_NAMESPACE,
        v: PROTOCOL_VERSION,
        type: 'urlProgress',
        operationId: request.operationId,
        receivedBytes: progress.receivedBytes,
        totalBytes: progress.totalBytes,
      })
    },
    onFallbackRequest: async (info) => {
      self.postMessage({
        ns: PROTOCOL_NAMESPACE,
        v: PROTOCOL_VERSION,
        type: 'urlFallbackConfirm',
        operationId: request.operationId,
        url: request.url,
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
    source = new SpoolSource(result.name, result.spool)
    indexer = new Indexer(source)
    filterEngine = new FilterEngine(indexer, source)

    const size = await result.spool.getSize()
    const response = createSuccessResponse(request.requestId, {
      name: result.name,
      size: Number(size),
      type: 'url',
    })
    self.postMessage(response)
  } finally {
    activeInit = null
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
    const { totalRows, totalBytes, invalidUtf8Rows } = await indexer.index()

    currentGeneration++

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

  const matchedRows = filterEngine.getMatchedRows()
  const totalFiltered = filterEngine.getMatchedCount()

  const start = request.start
  const count = request.count
  const end = Math.min(start + count, totalFiltered)

  const rows: RowData[] = []

  for (let i = start; i < end; i++) {
    const matchedRowIndex = matchedRows[i] ?? 0
    const lineStart = indexer.getLineStart(matchedRowIndex)
    const lineEnd = indexer.getLineEnd(matchedRowIndex)
    const length = lineEnd - lineStart + 1

    const lineBytes = await source!.readRange(lineStart, length)

    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(lineBytes)
    } catch {
      text = new TextDecoder('utf-8', { fatal: false }).decode(lineBytes)
    }

    rows.push({
      lineId: matchedRowIndex + 1,
      displayIndex: i,
      text,
      isEdited: false,
      byteLength: lineBytes.length,
    })
  }

  const response = createSuccessResponse(request.requestId, {
    rows,
    generation: currentGeneration,
    totalFiltered,
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

  const lineBytes = await source!.readRange(lineStart, length)

  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(lineBytes)
  } catch {
    text = new TextDecoder('utf-8', { fatal: false }).decode(lineBytes)
  }

  const response = createSuccessResponse(request.requestId, {
    lineId: request.lineId,
    text,
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
  const matchedRows = filterEngine.getMatchedRows()
  const matchedCount = filterEngine.getMatchedCount()

  exportStates.set(token, {
    token,
    generation: request.generation,
    matchedRows: matchedRows.slice(0, matchedCount),
    matchedCount,
    currentIndex: 0,
    cancelled: false,
  })

  let estimatedBytes = 0
  const indexerInstance = indexer!
  for (let i = 0; i < Math.min(matchedCount, 100); i++) {
    const lineStart = indexerInstance.getLineStart(matchedRows[i] ?? 0)
    const lineEnd = indexerInstance.getLineEnd(matchedRows[i] ?? 0)
    estimatedBytes += ((lineEnd ?? 0) - (lineStart ?? 0) + 2)
  }
  estimatedBytes = Math.round(estimatedBytes * (matchedCount / Math.min(matchedCount, 100)))

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
  const matchedRowIndex = state.matchedRows[state.currentIndex] ?? 0
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
