/**
 * JSONL Explorer - Worker RPC Protocol
 *
 * Versioned, discriminated message protocol for communication between
 * the main thread and the JSONL worker.
 *
 * Version 1 - 2024
 */

// ============================================================================
// Constants
// ============================================================================

export const PROTOCOL_NAMESPACE = 'jsonl-explorer'
export const PROTOCOL_VERSION = 1

/**
 * Maximum message size for worker communication (10 MB).
 */
export const MAX_MESSAGE_BYTES = 10 * 1024 * 1024

/**
 * Default timeout for RPC requests (30 seconds).
 */
export const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Error codes for typed failures.
 */
export const ErrorCode = {
  // Generic errors
  UNKNOWN: 'UNKNOWN',
  INVALID_REQUEST: 'INVALID_REQUEST',
  INVALID_MESSAGE: 'INVALID_MESSAGE',
  TIMEOUT: 'TIMEOUT',
  CANCELLED: 'CANCELLED',

  // Source/initialization errors
  SOURCE_INIT_FAILED: 'SOURCE_INIT_FAILED',
  SOURCE_READ_FAILED: 'SOURCE_READ_FAILED',
  SOURCE_NOT_INITIALIZED: 'SOURCE_NOT_INITIALIZED',

  // Indexing errors
  INDEXING_FAILED: 'INDEXING_FAILED',
  INDEXING_CANCELLED: 'INDEXING_CANCELLED',
  OPFS_QUOTA_EXCEEDED: 'OPFS_QUOTA_EXCEEDED',
  OPFS_UNAVAILABLE: 'OPFS_UNAVAILABLE',

  // Filtering errors
  FILTER_FAILED: 'FILTER_FAILED',
  FILTER_CANCELLED: 'FILTER_CANCELLED',
  INVALID_JQ_PROGRAM: 'INVALID_JQ_PROGRAM',
  JQ_COMPILE_FAILED: 'JQ_COMPILE_FAILED',
  JQ_RUNTIME_ERROR: 'JQ_RUNTIME_ERROR',

  // Row access errors
  ROW_NOT_FOUND: 'ROW_NOT_FOUND',
  ROW_READ_FAILED: 'ROW_READ_FAILED',
  INVALID_LINE_ID: 'INVALID_LINE_ID',
  STALE_GENERATION: 'STALE_GENERATION',

  // Edit errors
  EDIT_FAILED: 'EDIT_FAILED',
  INVALID_JSON: 'INVALID_JSON',
  EDIT_TOO_LARGE: 'EDIT_TOO_LARGE',
  EDIT_CRLF_NOT_ALLOWED: 'EDIT_CRLF_NOT_ALLOWED',

  // Export errors
  EXPORT_FAILED: 'EXPORT_FAILED',
  EXPORT_CANCELLED: 'EXPORT_CANCELLED',
  EXPORT_TOKEN_INVALID: 'EXPORT_TOKEN_INVALID',
  EXPORT_BLOB_TOO_LARGE: 'EXPORT_BLOB_TOO_LARGE',

  // Handover errors
  HANDOVER_PAYLOAD_TOO_LARGE: 'HANDOVER_PAYLOAD_TOO_LARGE',
  HANDOVER_ORIGIN_DENIED: 'HANDOVER_ORIGIN_DENIED',
  HANDOVER_TIMEOUT: 'HANDOVER_TIMEOUT',

  // URL loading errors
  URL_INVALID: 'URL_INVALID',
  URL_FETCH_FAILED: 'URL_FETCH_FAILED',
  URL_CORS_DENIED: 'URL_CORS_DENIED',
  URL_INVALID_HEADERS: 'URL_INVALID_HEADERS',
  URL_REDIRECT_DENIED: 'URL_REDIRECT_DENIED',
  URL_QUOTA_EXCEEDED: 'URL_QUOTA_EXCEEDED',
  URL_FALLBACK_DECLINED: 'URL_FALLBACK_DECLINED',
} as const

export type ErrorCode = typeof ErrorCode[keyof typeof ErrorCode]

/**
 * Typed error structure for protocol responses.
 */
export interface ProtocolError {
  code: ErrorCode
  message: string
  details?: Record<string, unknown>
}

// ============================================================================
// Request/Response Base Types
// ============================================================================

export interface BaseRequest {
  requestId: string
}

export interface BaseResponse {
  requestId: string
}

export interface SuccessResponse<T> extends BaseResponse {
  ns: typeof PROTOCOL_NAMESPACE
  v: typeof PROTOCOL_VERSION
  ok: true
  value: T
}

export interface ErrorResponse extends BaseResponse {
  ns: typeof PROTOCOL_NAMESPACE
  v: typeof PROTOCOL_VERSION
  ok: false
  error: ProtocolError
}

export type RpcResponse<T> = SuccessResponse<T> | ErrorResponse

// ============================================================================
// Operation IDs for Long-Running Operations
// ============================================================================

export interface OperationRequest extends BaseRequest {
  operationId: string
}

export interface BaseProgressEvent {
  operationId: string
  progress: number // 0-100
  message?: string
  rowsProcessed?: number
  totalRows?: number
  bytesProcessed?: number
  totalBytes?: number
}

export interface CancelRequest extends BaseRequest {
  type: 'cancel'
  operationId: string
}

/**
 * Alias for BaseProgressEvent for backward compatibility
 */
export type ProgressEvent = BaseProgressEvent

// ============================================================================
// Source Initialization
// ============================================================================

export interface InitFileRequest extends OperationRequest {
  type: 'initFile'
  file: File // Structured clone
}

export interface InitUrlRequest extends OperationRequest {
  type: 'initUrl'
  url: string
  headers?: Record<string, string>
  /**
   * Origin of the requesting page. Dedicated workers cannot read
   * `location`, so the page passes its origin for CORS heuristics.
   */
  pageOrigin?: string
}

/**
 * Worker → main-thread event: the OPFS spool could not be used (unavailable
 * or quota) and the byte stream would fall back to fixed-size in-memory
 * pages. Sent for large or unknown-size responses; the main thread shows a
 * consent dialog and answers with a `UrlFallbackConfirmResponse`.
 */
export interface UrlFallbackConfirmRequest {
  ns: typeof PROTOCOL_NAMESPACE
  v: typeof PROTOCOL_VERSION
  type: 'urlFallbackConfirm'
  operationId: string
  url: string
  /** Content-Length in decoded bytes, when the response declared it unencoded. */
  declaredBytes?: number
  reason: 'opfs-unavailable' | 'opfs-quota-exceeded' | 'declared-size-over-quota'
}

/** Main-thread → worker: user decision for a pending `urlFallbackConfirm` event. */
export interface UrlFallbackConfirmResponse extends BaseRequest {
  type: 'urlFallbackConfirm'
  operationId: string
  accept: boolean
}

/**
 * Worker → main-thread event: URL download progress. `totalBytes` is only
 * present when the response declared an unencoded Content-Length (R12);
 * compressed or unknown-size responses report indeterminate progress.
 */
export interface UrlProgressEvent {
  ns: typeof PROTOCOL_NAMESPACE
  v: typeof PROTOCOL_VERSION
  type: 'urlProgress'
  operationId: string
  receivedBytes: number
  totalBytes?: number
}

export interface InitMemoryRequest extends OperationRequest {
  type: 'initMemory'
  name: string
  payload: string | ArrayBuffer // ArrayBuffer is transferred
}

export type InitRequest = InitFileRequest | InitUrlRequest | InitMemoryRequest

export interface InitResponse extends BaseResponse {
  ok: true
  value: InitResult
}

/** Uniform value returned by every source init. */
export interface InitResult {
  name: string
  size: number
  type: 'file' | 'url' | 'handover'
}

// ============================================================================
// Indexing
// ============================================================================

export interface IndexRequest extends OperationRequest {
  type: 'index'
}

export interface IndexProgressEvent extends BaseProgressEvent {
  ns: typeof PROTOCOL_NAMESPACE
  v: typeof PROTOCOL_VERSION
  type: 'indexProgress'
  committedRows: number
  committedBytes: number
}

export interface IndexCompleteEvent {
  ns: typeof PROTOCOL_NAMESPACE
  v: typeof PROTOCOL_VERSION
  operationId: string
  type: 'indexComplete'
  totalRows: number
  totalBytes: number
  durationMs: number
  /**
   * Worker generation after this commit (increments on index completion,
   * filter, and edit). The main thread uses it to invalidate row caches:
   * a commit changes which rows exist, so every cached window is stale.
   */
  generation: number
}

export interface IndexResponse extends BaseResponse {
  ok: true
  value: {
    totalRows: number
    totalBytes: number
    /**
     * Rows that contained invalid UTF-8 (decoded with replacement at display
     * time). Absent or 0 when the document is valid; the UI shows one
     * warning per load when non-zero.
     */
    invalidUtf8Rows?: number
  }
}

// ============================================================================
// Filtering
// ============================================================================

export type FilterKind = 'text' | 'jq'

export interface FilterRequest extends OperationRequest {
  type: 'filter'
  kind: FilterKind
  query: string
}

/**
 * Drops the active filter view (if any) and returns to the identity view.
 * Bumps the generation like a filter, so stale row caches invalidate.
 */
export interface ClearFilterRequest extends OperationRequest {
  type: 'clearFilter'
}

export interface FilterProgressEvent extends BaseProgressEvent {
  ns: typeof PROTOCOL_NAMESPACE
  v: typeof PROTOCOL_VERSION
  type: 'filterProgress'
  matchedRows: number
  scannedRows: number
  /** Committed rows at scan start (the scan's horizon). */
  totalRows: number
}

export interface FilterCompleteEvent {
  ns: typeof PROTOCOL_NAMESPACE
  v: typeof PROTOCOL_VERSION
  operationId: string
  type: 'filterComplete'
  matchedRows: number
  totalRows: number
  durationMs: number
  errorCount?: number
  errorSummary?: string
  /**
   * Worker generation after this (automatic) rerun. Emitted when indexing
   * completes and the worker reruns the latest filter over the full row
   * set — no RPC response is attached to it.
   */
  generation: number
  /** False for completion reruns (indexing is done); see FilterResult. */
  partial: boolean
}

/**
 * Emitted after a setEdit/reset has been applied and re-evaluated against
 * the active filter (TSK0030). Carries the NEW generation so main-thread
 * views (row caches, filter counts, selection) converge on it. `matchedRows`
 * is the current view size: matched rows when a filter is active, the
 * committed row total otherwise.
 */
export interface EditCompleteEvent {
  ns: typeof PROTOCOL_NAMESPACE
  v: typeof PROTOCOL_VERSION
  operationId: string
  type: 'editComplete'
  lineId: number
  isEdited: boolean
  matchedRows: number
  totalRows: number
  errorCount?: number
  errorSummary?: string
  generation: number
  partial: boolean
}

export interface FilterResponse extends BaseResponse {
  ok: true
  value: FilterResult
}

/** Result of a completed filter operation. */
export interface FilterResult {
  matchedRows: number
  totalRows: number
  generation: number
  /**
   * True when the scan covered only the rows committed at scan start
   * (indexing still in flight). The result is a valid view of that
   * snapshot; the worker reruns the latest query automatically when
   * indexing completes and announces it with a `filterComplete` event.
   */
  partial: boolean
  /** Rows skipped due to row-level errors (invalid JSON / jq runtime). */
  errorCount?: number
  /** One-line summary of the first row error (never a per-row list). */
  errorSummary?: string
}

// ============================================================================
// Row Access
// ============================================================================

/**
 * Stable source line identifier (1-based, never changes).
 * Distinct from filtered display index.
 */
export type LineId = number & { readonly __brand: unique symbol }

/**
 * Filtered display index (0-based, changes with filters).
 */
export type DisplayIndex = number & { readonly __brand: unique symbol }

/**
 * Generation counter - increments on any data change (index, filter, edit).
 * Used to detect stale responses.
 */
export type Generation = number & { readonly __brand: unique symbol }

export interface RowData {
  lineId: number // Stable source line ID (1-based)
  displayIndex: number // Current filtered position (0-based)
  /**
   * Escaped, single-line PREVIEW of the row, capped at the worker's
   * rowPreviewByteLimit bytes of the ORIGINAL row (control characters
   * escaped to \uXXXX). It is NOT the full row: fetch full detail via
   * getLine. Truncated multi-byte characters decode to U+FFFD.
   */
  text: string
  isEdited: boolean
  /** Full byte length of the ORIGINAL row (not the preview). */
  byteLength: number
}

export interface GetRowsRequest extends BaseRequest {
  type: 'getRows'
  start: number // Display index
  count: number // Number of rows to fetch
  generation: number // Current generation for stale detection
}

export interface GetRowsResponse extends BaseResponse {
  ok: true
  value: {
    rows: RowData[]
    generation: number
    totalFiltered: number
  }
}

export interface GetLineRequest extends BaseRequest {
  type: 'getLine'
  lineId: number
}

export interface GetLineResponse extends BaseResponse {
  ok: true
  value: {
    lineId: number
    text: string
    isEdited: boolean
  }
}

/**
 * Where (or whether) a stable source line is in the CURRENT view.
 * Used to keep selection stable across filter/index changes: the worker
 * is authoritative for the display->lineId mapping, so the UI never
 * guesses whether the active row still matches.
 */
export interface LinePositionRequest extends BaseRequest {
  type: 'linePosition'
  lineId: number
}

export interface LinePositionResponse extends BaseResponse {
  ok: true
  value: {
    lineId: number
    /** False when the line is not part of the current view (filtered out
     *  or past the committed rows). */
    visible: boolean
    /** Display index in the current view (null when not visible). */
    displayIndex: number | null
    /** Generation the answer was computed for (stale detection). */
    generation: number
  }
}

// ============================================================================
// Editing
// ============================================================================

export interface SetEditRequest extends BaseRequest {
  type: 'setEdit'
  lineId: number
  text?: string // undefined = reset to original
}

export interface SetEditResponse extends BaseResponse {
  ok: true
  value: {
    lineId: number
    isEdited: boolean
    newGeneration: number
    filteredIndex?: number // New filtered position if filter matches changed
  }
}

// ============================================================================
// Export Streaming
// ============================================================================

export interface ExportStartRequest extends BaseRequest {
  type: 'exportStart'
  generation: number // Snapshot generation
}

export interface ExportStartResponse extends BaseResponse {
  ok: true
  value: {
    token: string // Opaque token for subsequent next/ack/cancel
    estimatedBytes: number
    totalRows: number
  }
}

export interface ExportNextRequest extends BaseRequest {
  type: 'exportNext'
  token: string
}

export interface ExportChunk {
  data: Uint8Array
  done: boolean
  rowsExported: number
}

export interface ExportNextResponse extends BaseResponse {
  ok: true
  value: ExportChunk
}

export interface ExportAckRequest extends BaseRequest {
  type: 'exportAck'
  token: string
}

export interface ExportAckResponse extends BaseResponse {
  ok: true
  value: { acknowledged: boolean }
}

export interface ExportCancelRequest extends BaseRequest {
  type: 'exportCancel'
  token: string
}

export interface ExportCancelResponse extends BaseResponse {
  ok: true
  value: { cancelled: boolean }
}

// ============================================================================
// Dispose
// ============================================================================

export interface DisposeRequest extends BaseRequest {
  type: 'dispose'
}

export interface DisposeResponse extends BaseResponse {
  ok: true
  value: { disposed: boolean }
}

// ============================================================================
// Message Unions
// ============================================================================

export type WorkerRequest =
  | InitRequest
  | IndexRequest
  | FilterRequest
  | ClearFilterRequest
  | GetRowsRequest
  | GetLineRequest
  | LinePositionRequest
  | SetEditRequest
  | ExportStartRequest
  | ExportNextRequest
  | ExportAckRequest
  | ExportCancelRequest
  | UrlFallbackConfirmResponse
  | CancelRequest
  | DisposeRequest

export type WorkerResponse =
  | RpcResponse<InitResponse['value']>
  | RpcResponse<IndexResponse['value']>
  | RpcResponse<FilterResponse['value']>
  | RpcResponse<GetRowsResponse['value']>
  | RpcResponse<GetLineResponse['value']>
  | RpcResponse<LinePositionResponse['value']>
  | RpcResponse<SetEditResponse['value']>
  | RpcResponse<ExportStartResponse['value']>
  | RpcResponse<ExportNextResponse['value']>
  | RpcResponse<ExportAckResponse['value']>
  | RpcResponse<ExportCancelResponse['value']>
  | RpcResponse<DisposeResponse['value']>

/**
 * Events the engine delivers to the page (progress + completion).
 * `UrlFallbackConfirmRequest` is interactive (the page answers with a
 * `urlFallbackConfirm` response), so it is routed separately.
 */
export type EngineEvent =
  | IndexProgressEvent
  | IndexCompleteEvent
  | FilterProgressEvent
  | FilterCompleteEvent
  | EditCompleteEvent
  | UrlProgressEvent

export type WorkerEvent = EngineEvent | UrlFallbackConfirmRequest

// ============================================================================
// Type Guards / Validators
// ============================================================================

function isObject(data: unknown): data is Record<string, unknown> {
  return data !== null && typeof data === 'object'
}

function hasProperty<T extends string>(obj: unknown, prop: T): obj is Record<T, unknown> {
  return isObject(obj) && prop in obj
}

export function validateProtocolMessage(data: unknown): data is { ns: string; v: number; type: string } {
  if (!isObject(data)) return false
  return (
    data['ns'] === PROTOCOL_NAMESPACE &&
    data['v'] === PROTOCOL_VERSION &&
    typeof data['type'] === 'string'
  )
}

export function validateWorkerRequest(data: unknown): data is WorkerRequest {
  if (!validateProtocolMessage(data)) return false
  return hasProperty(data, 'requestId') && typeof data.requestId === 'string'
}

export function validateWorkerResponse(data: unknown): data is WorkerResponse {
  if (!validateProtocolMessage(data)) return false
  return hasProperty(data, 'requestId') && typeof data.requestId === 'string'
}

export function validateProgressEvent(data: unknown): data is WorkerEvent {
  if (!validateProtocolMessage(data)) return false
  return hasProperty(data, 'operationId') && typeof data.operationId === 'string'
}

export function createErrorResponse(requestId: string, code: ErrorCode, message: string, details?: Record<string, unknown>): ErrorResponse {
  return {
    ns: PROTOCOL_NAMESPACE,
    v: PROTOCOL_VERSION,
    requestId,
    ok: false,
    error: { code, message, details },
  }
}

export function createSuccessResponse<T>(requestId: string, value: T): SuccessResponse<T> {
  return { ns: PROTOCOL_NAMESPACE, v: PROTOCOL_VERSION, requestId, ok: true, value }
}

// ============================================================================
// Utility Types
// ============================================================================

/**
 * Creates a branded type for compile-time distinction.
 */
export function createLineId(id: number): LineId {
  return id as LineId
}

export function createDisplayIndex(index: number): DisplayIndex {
  return index as DisplayIndex
}

export function createGeneration(gen: number): Generation {
  return gen as Generation
}

/**
 * Checks if a response is an error.
 */
export function isErrorResponse<T>(response: RpcResponse<T>): response is ErrorResponse {
  return !response.ok
}

/**
 * Checks if a response is successful.
 */
export function isSuccessResponse<T>(response: RpcResponse<T>): response is SuccessResponse<T> {
  return response.ok
}

/**
 * Engine interface for the JSONL Explorer
 */
export interface JsonlEngine {
  /** Operation id of the most recently started operation (cancel target). */
  readonly activeOperationId: string | null
  initFile(file: File): Promise<InitResult>
  initUrl(url: string, options?: { headers?: Record<string, string>; pageOrigin?: string }): Promise<InitResult>
  initMemory(name: string, payload: string | ArrayBuffer): Promise<InitResult>
  index(options?: { operationId: string }): Promise<void>
  filter(options: { operationId: string; kind: 'text' | 'jq'; query: string }): Promise<FilterResult>
  /** Drops the active filter view; resolves to a match-all result. */
  clearFilter(options: { operationId: string }): Promise<FilterResult>
  getRows(options: { start: number; count: number; generation: number }): Promise<{ rows: RowData[]; generation: number; totalFiltered: number }>
  getLine(lineId: number): Promise<{ lineId: number; text: string; isEdited: boolean }>
  /**
   * Authoritative position of a stable line id in the current view
   * (TSK0023): where it renders if it still matches, or not-visible.
   * Used for selection transitions — the main thread never guesses.
   */
  linePosition(lineId: number): Promise<{ lineId: number; visible: boolean; displayIndex: number | null; generation: number }>
  setEdit(lineId: number, text?: string): Promise<{ lineId: number; isEdited: boolean; newGeneration: number; filteredIndex?: number }>
  exportStart(options: { generation: number }): Promise<{ token: string; estimatedBytes: number; totalRows: number }>
  exportNext(token: string): Promise<{ data: Uint8Array; done: boolean; rowsExported: number }>
  exportAck(token: string): Promise<void>
  exportCancel(token: string): Promise<void>
  cancel(operationId: string): Promise<void>
  /**
   * Drops the current source (and its spool artifacts) while keeping the
   * worker alive for the next init.
   */
  clearSource(): Promise<void>
  dispose(): Promise<void>
  /**
   * Fatal recovery: terminates a dead/crashed worker and clears the fatal
   * state; the next RPC spawns a fresh worker. Safe to call when healthy.
   */
  reset(): Promise<void>
  onProgress(callback: (event: EngineEvent) => void): () => void
  onError(callback: (error: Error) => void): () => void
  /**
   * Consent relay for the in-memory fallback handshake. The first
   * registered handler decides; with no handler the fallback is declined.
   */
  onUrlFallbackConfirm(
    callback: (request: UrlFallbackConfirmRequest) => boolean | Promise<boolean>,
  ): () => void
}
