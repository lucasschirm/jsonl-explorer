/**
 * Worker RPC client — the main-thread side of the engine.
 *
 * Owns exactly one `jsonl.worker` at a time and implements the shared
 * `JsonlEngine` contract:
 * - request/response correlation by `requestId` (concurrent RPCs safe)
 * - engine events (index/url/filter progress, completions) fanned out to
 *   `onProgress` subscribers
 * - the `urlFallbackConfirm` consent handshake relayed via
 *   `onUrlFallbackConfirm` (no handler ⇒ decline, never silent)
 * - typed failures: `EngineRpcError` (worker-reported, carries the
 *   protocol `ErrorCode`), `EngineFatalError` (worker crashed),
 *   `EngineDisposedError` (client disposed), `InitInProgressError`
 *   (concurrent init), `SourceReplacedError` (in-flight RPC made stale by
 *   a new init)
 *
 * Scalable data (source bytes, offset/match indexes) never crosses this
 * boundary into the page: only scalars, row pages, and export chunks do.
 */

import type {
  EngineEvent,
  ErrorCode,
  FilterResult,
  InitResult,
  JsonlEngine,
  RowData,
  SuccessResponse,
  UrlFallbackConfirmRequest,
  WorkerRequest,
} from '@jsonl-explorer/shared'
import { PROTOCOL_NAMESPACE, PROTOCOL_VERSION } from '@jsonl-explorer/shared'

/** Typed error for worker-reported RPC failures (carries the code). */
export class EngineRpcError extends Error {
  readonly code: ErrorCode
  constructor(code: ErrorCode, message: string) {
    super(message)
    this.name = 'EngineRpcError'
    this.code = code
  }
}

/** The client was disposed; all further RPCs reject with this. */
export class EngineDisposedError extends Error {
  constructor() {
    super('Engine is disposed')
    this.name = 'EngineDisposedError'
  }
}

/** The worker crashed; call `reset()` before using the engine again. */
export class EngineFatalError extends Error {
  constructor(message = 'Worker crashed') {
    super(message)
    this.name = 'EngineFatalError'
  }
}

/** An init is already in flight; inits are serialized. */
export class InitInProgressError extends Error {
  constructor() {
    super('Another source init is already in progress')
    this.name = 'InitInProgressError'
  }
}

/** The pending RPC was made stale by a newer source init. */
export class SourceReplacedError extends Error {
  constructor() {
    super('Superseded by a new source init')
    this.name = 'SourceReplacedError'
  }
}

/** Grace for the best-effort graceful 'dispose' RPC before terminate. */
const DISPOSE_GRACE_MS = 300

export interface WorkerClientOptions {
  /**
   * Creates the underlying Worker. Injectable for tests; defaults to the
   * app's jsonl.worker module.
   */
  workerFactory?: () => Worker
}

let requestIdSeq = 0

function nextRequestId(): string {
  requestIdSeq += 1
  return `r-${requestIdSeq}-${Math.random().toString(36).slice(2, 8)}`
}

let operationSeq = 0

function nextOperationId(): string {
  operationSeq += 1
  return `op-${operationSeq}-${Math.random().toString(36).slice(2, 8)}`
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

/** Distributive Omit: keeps the request union discriminated. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** A worker request without the client-assigned `requestId`. */
export type WorkerRequestInput = DistributiveOmit<WorkerRequest, 'requestId'>

/** Init payloads without client-assigned `requestId`/`operationId`. */
type InitRequestInput = DistributiveOmit<
  Extract<WorkerRequest, { type: 'initFile' | 'initUrl' | 'initMemory' }>,
  'requestId' | 'operationId'
>

export class WorkerClient implements JsonlEngine {
  private options: WorkerClientOptions
  private worker: Worker | null = null
  private pending = new Map<string, PendingRequest>()
  private progressSubs = new Set<(event: EngineEvent) => void>()
  private errorSubs = new Set<(error: Error) => void>()
  private fallbackSubs = new Set<(request: UrlFallbackConfirmRequest) => boolean | Promise<boolean>>()
  private disposed = false
  private fatal = false
  private initInFlight = false
  private currentOperationId: string | null = null

  constructor(options: WorkerClientOptions = {}) {
    this.options = options
  }

  get activeOperationId(): string | null {
    return this.currentOperationId
  }

  // --- Source initialization (exactly one at a time) -----------------------

  initFile(file: File): Promise<InitResult> {
    return this.runInit({ type: 'initFile', file })
  }

  initUrl(url: string, options?: { headers?: Record<string, string>; pageOrigin?: string }): Promise<InitResult> {
    return this.runInit({
      type: 'initUrl',
      url,
      headers: options?.headers,
      pageOrigin: options?.pageOrigin,
    })
  }

  initMemory(name: string, payload: string | ArrayBuffer): Promise<InitResult> {
    return this.runInit({ type: 'initMemory', name, payload })
  }

  private runInit(request: InitRequestInput): Promise<InitResult> {
    if (this.disposed) return Promise.reject(new EngineDisposedError())
    if (this.fatal) {
      return Promise.reject(new EngineFatalError('Worker is in a fatal state; call reset() first'))
    }
    if (this.initInFlight) return Promise.reject(new InitInProgressError())
    this.initInFlight = true
    // Any in-flight RPC belongs to the outgoing source: its result would be
    // stale the moment the new source exists.
    this.rejectPending(new SourceReplacedError())
    const operationId = nextOperationId()
    this.currentOperationId = operationId
    // Init requests are OperationRequests: tag them with their operation id.
    return this.postRequest<InitResult>({ ...request, operationId } as WorkerRequestInput).finally(() => {
      this.initInFlight = false
    })
  }

  // --- Operations ------------------------------------------------------------

  async index(options?: { operationId: string }): Promise<void> {
    const operationId = options?.operationId ?? this.startOperation()
    await this.postRequest<void>({ type: 'index', operationId })
  }

  async filter(options: { operationId: string; kind: 'text' | 'jq'; query: string }): Promise<FilterResult> {
    this.currentOperationId = options.operationId
    return await this.postRequest<FilterResult>({
      type: 'filter',
      operationId: options.operationId,
      kind: options.kind,
      query: options.query,
    })
  }

  async getRows(options: { start: number; count: number; generation: number }): Promise<{
    rows: RowData[]
    generation: number
    totalFiltered: number
  }> {
    return await this.postRequest<{ rows: RowData[]; generation: number; totalFiltered: number }>({
      type: 'getRows',
      start: options.start,
      count: options.count,
      generation: options.generation,
    })
  }

  async getLine(lineId: number): Promise<{ lineId: number; text: string; isEdited: boolean }> {
    return await this.postRequest<{ lineId: number; text: string; isEdited: boolean }>({ type: 'getLine', lineId })
  }

  async setEdit(
    lineId: number,
    text?: string,
  ): Promise<{ lineId: number; isEdited: boolean; newGeneration: number; filteredIndex?: number }> {
    return await this.postRequest<{ lineId: number; isEdited: boolean; newGeneration: number; filteredIndex?: number }>({
      type: 'setEdit',
      lineId,
      text,
    })
  }

  async exportStart(options: { generation: number }): Promise<{ token: string; estimatedBytes: number; totalRows: number }> {
    return await this.postRequest<{ token: string; estimatedBytes: number; totalRows: number }>({
      type: 'exportStart',
      generation: options.generation,
    })
  }

  async exportNext(token: string): Promise<{ data: Uint8Array; done: boolean; rowsExported: number }> {
    return await this.postRequest<{ data: Uint8Array; done: boolean; rowsExported: number }>({ type: 'exportNext', token })
  }

  async exportAck(token: string): Promise<void> {
    await this.postRequest<void>({ type: 'exportAck', token })
  }

  async exportCancel(token: string): Promise<void> {
    await this.postRequest<void>({ type: 'exportCancel', token })
  }

  async cancel(operationId: string): Promise<void> {
    await this.postRequest<void>({ type: 'cancel', operationId })
  }

  /** Drops the current source (worker-side) but keeps the worker alive. */
  async clearSource(): Promise<void> {
    await this.postRequest<{ disposed: boolean }>({ type: 'dispose' })
    this.currentOperationId = null
  }

  // --- Lifecycle -------------------------------------------------------------

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.rejectPending(new EngineDisposedError())
    const worker = this.worker
    this.worker = null
    if (!worker) return
    await this.disposeWorkerGracefully(worker)
    worker.terminate()
  }

  async reset(): Promise<void> {
    const worker = this.worker
    this.worker = null
    this.rejectPending(new EngineFatalError('Worker was reset'))
    this.fatal = false
    this.initInFlight = false
    this.currentOperationId = null
    if (worker) worker.terminate()
  }

  // --- Subscriptions ---------------------------------------------------------

  onProgress(callback: (event: EngineEvent) => void): () => void {
    this.progressSubs.add(callback)
    return () => this.progressSubs.delete(callback)
  }

  onError(callback: (error: Error) => void): () => void {
    this.errorSubs.add(callback)
    return () => this.errorSubs.delete(callback)
  }

  onUrlFallbackConfirm(
    callback: (request: UrlFallbackConfirmRequest) => boolean | Promise<boolean>,
  ): () => void {
    this.fallbackSubs.add(callback)
    return () => this.fallbackSubs.delete(callback)
  }

  // --- Internals ---------------------------------------------------------------

  private startOperation(): string {
    this.currentOperationId = nextOperationId()
    return this.currentOperationId
  }

  private getWorker(): Worker {
    if (!this.worker) {
      const factory = this.options.workerFactory ?? defaultWorkerFactory
      this.worker = factory()
      this.worker.onmessage = (event: MessageEvent) => this.handleMessage(event.data)
      this.worker.onerror = () => this.handleFatal()
      this.worker.onmessageerror = () => this.handleFatal(new Error('Failed to deserialize a worker message'))
    }
    return this.worker
  }

  private postRequest<T>(request: WorkerRequestInput): Promise<T> {
    if (this.disposed) return Promise.reject(new EngineDisposedError())
    if (this.fatal) return Promise.reject(new EngineFatalError())
    const worker = this.getWorker()
    const requestId = nextRequestId()
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject })
      try {
        const fullRequest = { ...request, requestId } as WorkerRequest
        // Handover payloads are transferred (zero-copy), not cloned: the
        // main thread gives up the buffer the protocol says it sends.
        const transferables: Transferable[] = []
        const payload = (request as { payload?: unknown }).payload
        if (payload instanceof ArrayBuffer) transferables.push(payload)
        worker.postMessage(fullRequest, transferables)
      } catch (error) {
        this.pending.delete(requestId)
        this.handleFatal(error instanceof Error ? error : new Error('Failed to post to worker'))
        reject(new EngineFatalError())
      }
    })
  }

  private handleMessage(data: unknown): void {
    const msg = data as { type?: string; requestId?: string; ok?: boolean } | null
    if (!msg || typeof msg !== 'object') return
    if (msg.type === 'urlFallbackConfirm') {
      void this.routeFallbackConfirm(msg as UrlFallbackConfirmRequest)
      return
    }
    if (typeof msg.requestId === 'string' && typeof msg.ok === 'boolean') {
      const entry = this.pending.get(msg.requestId)
      if (!entry) return // stale (already rejected by reset/dispose/init)
      this.pending.delete(msg.requestId)
      if (msg.ok) {
        entry.resolve((msg as SuccessResponse<unknown>).value)
      } else {
        const errorResponse = msg as { error: { code: ErrorCode; message: string } }
        entry.reject(new EngineRpcError(errorResponse.error.code, errorResponse.error.message))
      }
      return
    }
    for (const callback of this.progressSubs) callback(msg as EngineEvent)
  }

  private async routeFallbackConfirm(request: UrlFallbackConfirmRequest): Promise<void> {
    let accept = false // safe default: never a silent fallback
    for (const callback of this.fallbackSubs) {
      accept = await callback(request)
      break
    }
    const worker = this.worker
    if (!worker) return
    worker.postMessage({
      ns: PROTOCOL_NAMESPACE,
      v: PROTOCOL_VERSION,
      type: 'urlFallbackConfirm',
      requestId: nextRequestId(),
      operationId: request.operationId,
      accept,
    })
  }

  private handleFatal(error?: Error): void {
    if (this.fatal || this.disposed) return
    this.fatal = true
    const fatalError = new EngineFatalError(error?.message ?? 'Worker crashed')
    this.rejectPending(fatalError)
    for (const callback of this.errorSubs) callback(fatalError)
  }

  private rejectPending(error: Error): void {
    for (const [, entry] of this.pending) entry.reject(error)
    this.pending.clear()
  }

  /**
   * Best-effort graceful shutdown: post 'dispose' (the worker disposes the
   * source and cleans spool artifacts) and wait for the ack with a short
   * grace; the caller terminates the worker afterwards either way.
   */
  private disposeWorkerGracefully(worker: Worker): Promise<void> {
    const requestId = nextRequestId()
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, DISPOSE_GRACE_MS)
      const handler = (event: MessageEvent): void => {
        const msg = event.data as { requestId?: string } | null
        if (msg && msg.requestId === requestId) {
          clearTimeout(timer)
          worker.removeEventListener('message', handler)
          resolve()
        }
      }
      worker.addEventListener('message', handler)
      try {
        worker.postMessage({ ns: PROTOCOL_NAMESPACE, v: PROTOCOL_VERSION, type: 'dispose', requestId })
      } catch {
        clearTimeout(timer)
        resolve()
      }
    })
  }
}

function defaultWorkerFactory(): Worker {
  return new Worker(new URL('../workers/jsonl.worker.ts', import.meta.url), { type: 'module' })
}
