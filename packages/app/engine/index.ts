/**
 * JSONL Engine — main entry point.
 *
 * `createJsonlEngine()` returns the worker RPC client
 * (`WorkerClient`), which implements the shared `JsonlEngine` contract
 * against the `jsonl.worker` module. All heavy processing (scanning,
 * indexing, filtering, exports) happens in the worker; the client only
 * moves scalars, row pages, and export chunks across the boundary.
 */

import type { JsonlEngine as JsonlEngineType } from '@jsonl-explorer/shared'
import type { WorkerClientOptions } from './workerClient'
import { WorkerClient } from './workerClient'

export type { JsonlEngine } from '@jsonl-explorer/shared'
export { PROTOCOL_NAMESPACE, PROTOCOL_VERSION } from '@jsonl-explorer/shared'
export type {
  WorkerRequest,
  WorkerResponse,
  WorkerEvent,
  ProgressEvent,
  EngineEvent,
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
export type { WorkerClientOptions, WorkerRequestInput } from './workerClient'
export {
  WorkerClient,
  EngineRpcError,
  EngineDisposedError,
  EngineFatalError,
  InitInProgressError,
  SourceReplacedError,
} from './workerClient'

/**
 * Creates a new JSONL engine instance backed by a dedicated worker.
 */
export function createJsonlEngine(options?: WorkerClientOptions): JsonlEngineType {
  return new WorkerClient(options)
}
