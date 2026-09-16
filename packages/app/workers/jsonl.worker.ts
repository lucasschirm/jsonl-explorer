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
  CancelRequest,
  DisposeRequest,
  ErrorCode,
  RpcResponse,
  RowData,
  LineId,
  DisplayIndex,
  Generation,
} from '@jsonl-explorer/shared'

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

const CHUNK_SIZE = 64 * 1024 // 64 KiB
const PROGRESS_INTERVAL_ROWS = 1000
const INDEX_BLOCK_GROWTH_FACTOR = 2

// ============================================================================
// Source Types
// ============================================================================

interface JsonlSource {
  readRange(offset: number, length: number): Promise<Uint8Array>
  getSize(): Promise<number>
  getName(): string
  dispose(): Promise<void>
}

class FileSource implements JsonlSource {
  private file: File

  constructor(file: File) {
    this.file = file
  }

  async readRange(offset: number, length: number): Promise<Uint8Array> {
    const slice = this.file.slice(offset, offset + length)
    return new Uint8Array(await slice.arrayBuffer())
  }

  async getSize(): Promise<number> {
    return this.file.size
  }

  getName(): string {
    return this.file.name
  }

  async dispose(): Promise<void> {
    // File is owned by main thread, nothing to dispose
  }
}

class UrlSource implements JsonlSource {
  private url: string
  private headers: Record<string, string>
  private opfsDir: FileSystemDirectoryHandle | null = null
  private opfsFile: FileSystemFileHandle | null = null
  private opfsWriter: FileSystemSyncAccessHandle | null = null
  private size: number | null = null
  private downloaded = false

  constructor(url: string, headers: Record<string, string>) {
    this.url = url
    this.headers = headers
  }

  async readRange(offset: number, length: number): Promise<Uint8Array> {
    await this.ensureDownloaded()
    if (this.opfsWriter) {
      const buffer = new Uint8Array(length)
      const read = this.opfsWriter.read(buffer, { at: offset })
      return buffer.subarray(0, read)
    }
    throw new Error('URL source memory fallback not implemented')
  }

  async getSize(): Promise<number> {
    if (this.size !== null) return this.size
    await this.ensureDownloaded()
    return this.size ?? 0
  }

  getName(): string {
    return this.url
  }

  private async ensureDownloaded(): Promise<void> {
    if (this.downloaded) return
    this.downloaded = true

    try {
      const response = await fetch(this.url, {
        headers: this.headers,
        credentials: 'omit',
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      if ('storage' in navigator && 'getDirectory' in navigator.storage) {
        try {
          const opfsDir = await navigator.storage.getDirectory()
          const fileName = `jsonl-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`
          const opfsFile = await opfsDir.getFileHandle(fileName, { create: true })
          const opfsWriter = await opfsFile.createSyncAccessHandle()

          const reader = response.body?.getReader()
          if (reader) {
            let offset = 0
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              opfsWriter.write(value, { at: offset })
              offset += value.length
            }
          }

          this.opfsDir = opfsDir
          this.opfsFile = opfsFile
          this.opfsWriter = opfsWriter
          this.size = opfsWriter.getSize()
          return
        } catch (opfsError) {
          console.warn('OPFS unavailable, falling back to memory:', opfsError)
        }
      }

      throw new Error('URL source requires OPFS for large files')
    } catch (error) {
      throw new Error(`Failed to download URL: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async dispose(): Promise<void> {
    if (this.opfsWriter) {
      this.opfsWriter.close()
      this.opfsWriter = null
    }
    if (this.opfsFile && this.opfsDir) {
      try {
        await this.opfsDir.removeEntry((await this.opfsFile).name)
      } catch {
        // Ignore cleanup errors
      }
      this.opfsFile = null
      this.opfsDir = null
    }
  }
}

class MemorySource implements JsonlSource {
  private data: Uint8Array
  private name: string

  constructor(name: string, payload: string | ArrayBuffer) {
    this.name = name
    if (payload instanceof ArrayBuffer) {
      this.data = new Uint8Array(payload)
    } else {
      this.data = new TextEncoder().encode(payload)
    }
  }

  async readRange(offset: number, length: number): Promise<Uint8Array> {
    return this.data.subarray(offset, offset + length)
  }

  async getSize(): Promise<number> {
    return this.data.byteLength
  }

  getName(): string {
    return this.name
  }

  async dispose(): Promise<void> {
    // Nothing to dispose
  }
}

// ============================================================================
// Indexer
// ============================================================================

interface IndexerState {
  lineStarts: Uint32Array
  lineStartsHi: Uint32Array
  committedRows: number
  committedBytes: number
  totalBytes: number
  isComplete: boolean
  hasCRLF: boolean
}

class Indexer {
  private source: JsonlSource
  private state: IndexerState
  private buffer: Uint8Array
  private bufferOffset: number
  private operationId: string | null = null
  private cancelled = false
  private lastProgressTime = 0
  private lastProgressRows = 0

  constructor(source: JsonlSource) {
    this.source = source
    this.state = {
      lineStarts: new Uint32Array(1024),
      lineStartsHi: new Uint32Array(1024),
      committedRows: 0,
      committedBytes: 0,
      totalBytes: 0,
      isComplete: false,
      hasCRLF: false,
    }
    this.buffer = new Uint8Array(CHUNK_SIZE)
    this.bufferOffset = 0
  }

  setOperationId(operationId: string): void {
    this.operationId = operationId
  }

  cancel(): void {
    this.cancelled = true
  }

  async index(onProgress?: (event: IndexProgressEvent) => void): Promise<{ totalRows: number; totalBytes: number }> {
    const size = await this.source.getSize()
    this.state.totalBytes = size

    this.ensureCapacity(1)

    let offset = 0
    let bytesRead = 0
    let rowCount = 0

    while (bytesRead < size && !this.cancelled) {
      const chunkSize = Math.min(CHUNK_SIZE, size - bytesRead)
      const chunk = await this.source.readRange(bytesRead, chunkSize)

      if (chunk.length === 0) break

      let chunkOffset = 0
      while (chunkOffset < chunk.length) {
        const nlIndex = findNewline(chunk, chunkOffset)

        if (nlIndex === -1) {
          chunkOffset = chunk.length
          continue
        }

        const lineEnd = nlIndex
        const lineStart = chunkOffset

        const isCRLF = lineEnd > 0 && chunk[lineEnd - 1] === 0x0d
        if (isCRLF) {
          this.state.hasCRLF = true
        }

        const absoluteOffset = bytesRead + lineStart
        this.addLineStart(absoluteOffset)
        rowCount++

        chunkOffset = lineEnd + 1

        if (rowCount % PROGRESS_INTERVAL_ROWS === 0) {
          this.state.committedRows = rowCount
          this.state.committedBytes = bytesRead + chunkOffset

          if (this.operationId && this.shouldEmitProgress()) {
            const event: IndexProgressEvent = {
              ns: 'jsonl-explorer',
              v: 1,
              type: 'indexProgress',
              operationId: this.operationId!,
              progress: Math.min(100, (bytesRead / size) * 100),
              rowsProcessed: rowCount,
              committedRows: rowCount,
              committedBytes: this.state.committedBytes,
            }
            self.postMessage(event)
          }
        }
      }

      bytesRead += chunk.length
    }

    if (bytesRead > 0 && !this.cancelled) {
      const lastByte = await this.source.readRange(size - 1, 1)
      if (lastByte[0] !== 0x0a) {
        this.addLineStart(size)
        rowCount++
      }
    }

    this.state.committedRows = rowCount
    this.state.committedBytes = size
    this.state.isComplete = true

    if (this.operationId) {
      const event: IndexCompleteEvent = {
        ns: 'jsonl-explorer',
        v: 1,
        type: 'indexComplete',
        operationId: this.operationId,
        totalRows: rowCount,
        totalBytes: size,
        durationMs: 0,
      }
      self.postMessage(event)
    }

    return { totalRows: rowCount, totalBytes: size }
  }

  private shouldEmitProgress(): boolean {
    const now = performance.now()
    if (now - this.lastProgressTime >= 50) {
      this.lastProgressTime = now
      return true
    }
    return false
  }

  private ensureCapacity(minRows: number): void {
    const needed = this.state.committedRows + minRows + 1
    if (this.state.lineStarts.length >= needed) return

    const newCapacity = Math.max(this.state.lineStarts.length * 2, needed)
    const newStarts = new Uint32Array(newCapacity)
    const newStartsHi = new Uint32Array(newCapacity)
    newStarts.set(this.state.lineStarts)
    newStartsHi.set(this.state.lineStartsHi)
    this.state.lineStarts = newStarts
    this.state.lineStartsHi = newStartsHi
  }

  private addLineStart(offset: number): void {
    const index = this.state.committedRows
    if (index >= this.state.lineStarts.length) {
      this.ensureCapacity(1024)
    }

    this.state.lineStarts[index] = offset & 0xffffffff
    this.state.lineStartsHi[index] = (offset / 0x100000000) | 0
  }

  getLineStart(row: number): number {
    const low = this.state.lineStarts[row] ?? 0
    const high = this.state.lineStartsHi[row] ?? 0
    return (high * 0x100000000) + (low >>> 0)
  }

  getLineEnd(row: number): number {
    const start = this.getLineStart(row)
    const nextStart = this.getLineStart(row + 1)
    return nextStart > start ? nextStart - 1 : start
  }

  getCommittedRows(): number {
    return this.state.committedRows
  }

  isComplete(): boolean {
    return this.state.isComplete
  }

  getHasCRLF(): boolean {
    return this.state.hasCRLF
  }
}

function findNewline(buffer: Uint8Array, start: number): number {
  for (let i = start; i < buffer.length; i++) {
    if (buffer[i] === 0x0a) return i
  }
  return -1
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
    const response = createErrorResponse(request.requestId, 'UNKNOWN', error instanceof Error ? error.message : String(error))
    self.postMessage(response)
  }
}

async function handleInitFile(request: InitFileRequest): Promise<void> {
  source = new FileSource(request.file)
  indexer = new Indexer(source)
  filterEngine = new FilterEngine(indexer, source)
  currentGeneration = 0

  const response = createSuccessResponse(request.requestId, {
    name: request.file.name,
    size: request.file.size,
    type: 'file',
  })
  self.postMessage(response)
}

async function handleInitUrl(request: InitUrlRequest): Promise<void> {
  source = new UrlSource(request.url, request.headers || {})
  indexer = new Indexer(source)
  filterEngine = new FilterEngine(indexer, source)
  currentGeneration = 0

  const response = createSuccessResponse(request.requestId, {
    name: new URL(request.url).pathname.split('/').pop() || 'remote.jsonl',
    size: 0,
    type: 'url',
  })
  self.postMessage(response)
}

async function handleInitMemory(request: InitMemoryRequest): Promise<void> {
  source = new MemorySource(request.name, request.payload)
  indexer = new Indexer(source)
  filterEngine = new FilterEngine(indexer, source)
  currentGeneration = 0

  const response = createSuccessResponse(request.requestId, {
    name: request.name,
    size: request.payload instanceof ArrayBuffer ? request.payload.byteLength : new TextEncoder().encode(request.payload).length,
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
    const { totalRows, totalBytes } = await indexer.index((event) => self.postMessage(event))

    currentGeneration++

    const response = createSuccessResponse(request.requestId, {
      totalRows,
      totalBytes,
    })
    self.postMessage(response)
  } catch (error) {
    const response = createErrorResponse(request.requestId, 'INDEXING_FAILED', error instanceof Error ? error.message : String(error))
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
  const response = createSuccessResponse(request.requestId, {})
  self.postMessage(response)
}

async function handleDispose(request: DisposeRequest): Promise<void> {
  if (source) {
    await source.dispose()
    source = null
  }
  indexer = null
  filterEngine = null
  exportStates.clear()
  currentGeneration = 0

  const response = createSuccessResponse(request.requestId, { disposed: true })
  self.postMessage(response)
}

self.addEventListener('unload', () => {
  if (source) {
    source.dispose().catch(console.error)
  }
})
