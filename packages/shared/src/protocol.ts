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
  URL_FETCH_FAILED: 'URL_FETCH_FAILED',
  URL_CORS_DENIED: 'URL_CORS_DENIED',
  URL_INVALID_HEADERS: 'URL_INVALID_HEADERS',
  URL_REDIRECT_DENIED: 'URL_REDIRECT_DENIED',
  URL_QUOTA_EXCEEDED: 'URL_QUOTA_EXCEEDED',
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
}

export interface InitMemoryRequest extends OperationRequest {
  type: 'initMemory'
  name: string
  payload: string | ArrayBuffer // ArrayBuffer is transferred
}

export type InitRequest = InitFileRequest | InitUrlRequest | InitMemoryRequest

export interface InitResponse extends BaseResponse {
  ok: true
  value: {
    name: string
    size: number
    type: 'file' | 'url' | 'handover'
  }
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
}

export interface IndexResponse extends BaseResponse {
  ok: true
  value: {
    totalRows: number
    totalBytes: number
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

export interface FilterProgressEvent extends BaseProgressEvent {
  ns: typeof PROTOCOL_NAMESPACE
  v: typeof PROTOCOL_VERSION
  type: 'filterProgress'
  matchedRows: number
  scannedRows: number
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
}

export interface FilterResponse extends BaseResponse {
  ok: true
  value: {
    matchedRows: number
    totalRows: number
    generation: number
  }
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
  text: string // Row text (escaped for display)
  isEdited: boolean
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
  | GetRowsRequest
  | GetLineRequest
  | SetEditRequest
  | ExportStartRequest
  | ExportNextRequest
  | ExportAckRequest
  | ExportCancelRequest
  | CancelRequest
  | DisposeRequest

export type WorkerResponse =
  | RpcResponse<InitResponse['value']>
  | RpcResponse<IndexResponse['value']>
  | RpcResponse<FilterResponse['value']>
  | RpcResponse<GetRowsResponse['value']>
  | RpcResponse<GetLineResponse['value']>
  | RpcResponse<SetEditResponse['value']>
  | RpcResponse<ExportStartResponse['value']>
  | RpcResponse<ExportNextResponse['value']>
  | RpcResponse<ExportAckResponse['value']>
  | RpcResponse<ExportCancelResponse['value']>
  | RpcResponse<DisposeResponse['value']>

export type WorkerEvent =
  | IndexProgressEvent
  | IndexCompleteEvent
  | FilterProgressEvent
  | FilterCompleteEvent

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
  initFile(file: File): Promise<void>
  initUrl(url: string, headers?: Record<string, string>): Promise<void>
  initMemory(name: string, payload: string | ArrayBuffer): Promise<void>
  index(options?: { operationId: string }): Promise<void>
  filter(options: { operationId: string; kind: 'text' | 'jq'; query: string }): Promise<void>
  getRows(options: { start: number; count: number; generation: number }): Promise<{ rows: RowData[]; generation: number; totalFiltered: number }>
  getLine(lineId: number): Promise<{ lineId: number; text: string; isEdited: boolean }>
  setEdit(lineId: number, text?: string): Promise<{ lineId: number; isEdited: boolean; newGeneration: number; filteredIndex?: number }>
  exportStart(options: { generation: number }): Promise<{ token: string; estimatedBytes: number; totalRows: number }>
  exportNext(token: string): Promise<{ data: Uint8Array; done: boolean; rowsExported: number }>
  exportAck(token: string): Promise<void>
  exportCancel(token: string): Promise<void>
  cancel(operationId: string): Promise<void>
  dispose(): Promise<void>
  onProgress(callback: (event: ProgressEvent) => void): () => void
  onError(callback: (error: Error) => void): () => void
}
