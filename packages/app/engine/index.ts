/**
 * JSONL Engine - Main entry point
 *
 * Provides a high-level API for loading and interacting with JSONL files.
 * The actual processing happens in a Web Worker.
 */

import type { JsonlEngine as JsonlEngineType } from '@jsonl-explorer/shared'

// Re-export shared types
export type {
  WorkerRequest,
  WorkerResponse,
  WorkerEvent,
  ProgressEvent,
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
  RpcResponse,
  ErrorCode,
  LineId,
  DisplayIndex,
  Generation,
  RowData,
} from '@jsonl-explorer/shared'

export type { JsonlEngine } from '@jsonl-explorer/shared'
export { PROTOCOL_NAMESPACE, PROTOCOL_VERSION } from '@jsonl-explorer/shared'

/**
 * Creates a new JSONL engine instance
 * Returns a stub implementation for development
 */
export function createJsonlEngine(): JsonlEngineType {
  let disposed = false

  return {
    async initFile(file: File): Promise<void> {
      console.log('Stub: initFile', file.name, file.size)
    },
    async initUrl(url: string, headers?: Record<string, string>): Promise<void> {
      console.log('Stub: initUrl', url, headers)
    },
    async initMemory(name: string, payload: string | ArrayBuffer): Promise<void> {
      console.log('Stub: initMemory', name, payload instanceof ArrayBuffer ? 'ArrayBuffer' : 'string')
    },
    async index(options?: { operationId: string }): Promise<void> {
      console.log('Stub: index', options)
    },
    async filter(options: { operationId: string; kind: 'text' | 'jq'; query: string }): Promise<void> {
      console.log('Stub: filter', options)
    },
    async getRows(options: { start: number; count: number; generation: number }): Promise<{ rows: any[]; generation: number; totalFiltered: number }> {
      console.log('Stub: getRows', options)
      return { rows: [], generation: 0, totalFiltered: 0 }
    },
    async getLine(lineId: number): Promise<{ lineId: number; text: string; isEdited: boolean }> {
      console.log('Stub: getLine', lineId)
      return { lineId, text: '', isEdited: false }
    },
    async setEdit(lineId: number, text?: string): Promise<{ lineId: number; isEdited: boolean; newGeneration: number; filteredIndex?: number }> {
      console.log('Stub: setEdit', lineId, text)
      return { lineId, isEdited: false, newGeneration: 0 }
    },
    async exportStart(options: { generation: number }): Promise<{ token: string; estimatedBytes: number; totalRows: number }> {
      console.log('Stub: exportStart', options)
      return { token: '', estimatedBytes: 0, totalRows: 0 }
    },
    async exportNext(token: string): Promise<{ data: Uint8Array; done: boolean; rowsExported: number }> {
      console.log('Stub: exportNext', token)
      return { data: new Uint8Array(0), done: true, rowsExported: 0 }
    },
    async exportAck(token: string): Promise<void> {
      console.log('Stub: exportAck', token)
    },
    async exportCancel(token: string): Promise<void> {
      console.log('Stub: exportCancel', token)
    },
    async cancel(operationId: string): Promise<void> {
      console.log('Stub: cancel', operationId)
    },
    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      console.log('Stub: dispose')
    },
    onProgress(callback: (event: any) => void): () => void {
      return () => {}
    },
    onError(callback: (error: Error) => void): () => void {
      return () => {}
    },
  }
}