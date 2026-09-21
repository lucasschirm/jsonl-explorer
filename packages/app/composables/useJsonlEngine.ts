/**
 * useJsonlEngine — the single owner of the worker engine on the main
 * thread.
 *
 * Exactly one engine (and therefore at most one source) exists at a time.
 * Every piece of state exposed here is scalar UI metadata (name, size,
 * row counts, progress, generation): the engine instance is held in a
 * `shallowRef` and the source bytes / offset / match indexes never enter
 * Pinia or Vue proxies.
 *
 * Progress is slot-based (TSK0019): download and index are represented
 * separately so a URL load can show "downloading 62% · 1,204 rows" while
 * both are in flight. Events for operations the composable does not own
 * (filters) are left to their stores; stale load events (from an older
 * operation than the active one) are dropped so cancel/restart can never
 * surface stale progress.
 */

import { computed, ref, shallowRef, type Ref, type ShallowRef } from 'vue'
import {
  createJsonlEngine,
  EngineFatalError,
  EngineDisposedError,
  EngineRpcError,
  SourceReplacedError,
  type WorkerClientOptions,
} from '~/engine/index'
import type { EngineEvent, InitResult, JsonlEngine, UrlFallbackConfirmRequest } from '@jsonl-explorer/shared'

export type SourceType = InitResult['type']

export interface ProgressSlot {
  /** Determinate percent (0-100) or null when indeterminate (R12). */
  percent: number | null
  /** Bytes received (download) or scanned (index). */
  bytes: number
  totalBytes: number | null
  /** Rows committed so far (index slot only). */
  rows: number | null
}

export interface EngineProgressState {
  download: ProgressSlot | null
  index: ProgressSlot | null
  filter: ProgressSlot | null
}

const IDLE_PROGRESS: EngineProgressState = { download: null, index: null, filter: null }

export type IndexState = 'idle' | 'running' | 'cancelled' | 'failed'

export type OpenKind = 'file' | 'url' | 'handover'

export interface OpenPayload {
  file?: File
  url?: string
  headers?: Record<string, string>
  name?: string
  payload?: string | ArrayBuffer
}

export interface JsonlEngineApi {
  engine: ShallowRef<JsonlEngine | null>
  sourceName: Ref<string | null>
  sourceType: Ref<SourceType | null>
  sourceSize: Ref<number>
  totalRows: Ref<number>
  loading: Ref<boolean>
  progress: Ref<EngineProgressState>
  indexState: Ref<IndexState>
  indexError: Ref<string | null>
  /** True while a background file/handover index is running. */
  indexing: Ref<boolean>
  /** The operation the composable is currently tracking (null when idle). */
  activeOperationId: Ref<string | null>
  /** Pending OPFS-fallback consent request, when the worker is waiting. */
  fallbackRequest: Ref<UrlFallbackConfirmRequest | null>
  fatal: Ref<boolean>
  fatalMessage: Ref<string | null>
  getEngine(): JsonlEngine
  open(kind: OpenKind, payload: OpenPayload): Promise<InitResult>
  /** Starts (or restarts after a cancel) the background index for the loaded source. */
  startIndex(): Promise<void>
  /** Cancels the active load/index operation by its operation id. */
  cancelActive(): Promise<void>
  /** Answers a pending fallback consent; a stale consent is answered false. */
  confirmUrlFallback(accept: boolean): void
  closeSource(): Promise<void>
  recoverFromFatal(): Promise<void>
  disposeEngine(): Promise<void>
}

function createSingleton(engineOptions?: WorkerClientOptions): JsonlEngineApi {
  const engine = shallowRef<JsonlEngine | null>(null)
  const sourceName = ref<string | null>(null)
  const sourceType = ref<SourceType | null>(null)
  const sourceSize = ref(0)
  const totalRows = ref(0)
  const loading = ref(false)
  const progress = ref<EngineProgressState>({ ...IDLE_PROGRESS })
  const indexState = ref<IndexState>('idle')
  const indexError = ref<string | null>(null)
  const activeOperationId = ref<string | null>(null)
  const fallbackRequest = ref<UrlFallbackConfirmRequest | null>(null)
  const fatal = ref(false)
  const fatalMessage = ref<string | null>(null)
  const indexing = computed(() => indexState.value === 'running')
  let fallbackResolve: ((accept: boolean) => void) | null = null

  /** True when the event belongs to an older operation than the active one. */
  function isStaleLoadEvent(event: EngineEvent): boolean {
    const active = activeOperationId.value
    return active !== null && event.operationId !== active
  }

  function handleEngineEvent(event: EngineEvent): void {
    switch (event.type) {
      case 'urlProgress':
        if (isStaleLoadEvent(event)) return
        progress.value = {
          ...progress.value,
          download: {
            percent:
              event.totalBytes !== undefined && event.totalBytes > 0
                ? Math.min(100, Math.round((event.receivedBytes / event.totalBytes) * 100))
                : null,
            bytes: event.receivedBytes,
            totalBytes: event.totalBytes ?? null,
            rows: null,
          },
        }
        break
      case 'indexProgress':
        if (isStaleLoadEvent(event)) return
        progress.value = {
          ...progress.value,
          index: {
            percent: event.totalBytes !== undefined && event.totalBytes > 0 ? event.progress : null,
            bytes: event.committedBytes,
            totalBytes: event.totalBytes ?? null,
            rows: event.committedRows,
          },
        }
        break
      case 'filterProgress':
        // Filter operations are owned by the filter store (which scopes by
        // operation id itself); the slot here is best-effort for display.
        progress.value = {
          ...progress.value,
          filter: {
            percent: event.totalBytes !== undefined ? event.progress : null,
            bytes: event.scannedRows,
            totalBytes: event.totalBytes ?? null,
            rows: event.matchedRows,
          },
        }
        break
      case 'indexComplete':
        if (isStaleLoadEvent(event)) return
        totalRows.value = event.totalRows
        progress.value = { ...progress.value, index: null }
        break
      case 'filterComplete':
        if (progress.value.filter !== null) progress.value = { ...progress.value, filter: null }
        break
    }
  }

  function handleEngineError(error: Error): void {
    if (error instanceof EngineFatalError) {
      fatal.value = true
      fatalMessage.value = 'The processing worker crashed. Reset to try again.'
      loading.value = false
      activeOperationId.value = null
      clearProgressState()
      confirmUrlFallback(false)
    }
  }

  function getEngine(): JsonlEngine {
    if (!engine.value) {
      const created = createJsonlEngine(engineOptions)
      created.onProgress(handleEngineEvent)
      created.onError(handleEngineError)
      // Fallback consent is decided by the UI (FallbackConfirmModal via
      // app.vue). Until it answers, the worker pauses the download. The
      // handler returns a promise that resolves on confirmUrlFallback().
      created.onUrlFallbackConfirm((request) => {
        return new Promise<boolean>((resolve) => {
          fallbackRequest.value = request
          fallbackResolve = resolve
        })
      })
      engine.value = created
    }
    return engine.value
  }

  function clearProgressState(): void {
    progress.value = { ...IDLE_PROGRESS }
    indexState.value = 'idle'
    indexError.value = null
  }

  function applyInitResult(result: InitResult): void {
    sourceName.value = result.name
    sourceType.value = result.type
    sourceSize.value = result.size
    // NB: totalRows is NOT touched here — for URL sources the
    // indexComplete event (carrying the real row count) arrives BEFORE
    // this response, and clearing it here would wipe the count.
    progress.value = { ...IDLE_PROGRESS }
  }

  function clearMetadata(): void {
    sourceName.value = null
    sourceType.value = null
    sourceSize.value = 0
    totalRows.value = 0
    activeOperationId.value = null
    clearProgressState()
  }

  let loadCount = 0

  async function open(kind: OpenKind, payload: OpenPayload): Promise<InitResult> {
    const current = getEngine()
    loadCount += 1
    loading.value = true
    // A new load invalidates the previous operation: its events are stale
    // from this point on (isStaleLoadEvent) and any in-flight index is
    // rejected with SourceReplacedError by the client's runInit. The row
    // count of the previous source is dropped up front (see
    // applyInitResult for why it is not cleared after the response).
    totalRows.value = 0
    clearProgressState()
    try {
      let result: InitResult
      if (kind === 'file') {
        const pending = current.initFile(payload.file as File)
        activeOperationId.value = current.activeOperationId
        result = await pending
      } else if (kind === 'url') {
        const pending = current.initUrl(payload.url as string, {
          headers: payload.headers,
          pageOrigin: typeof location !== 'undefined' ? location.origin : undefined,
        })
        activeOperationId.value = current.activeOperationId
        result = await pending
      } else {
        const pending = current.initMemory(payload.name as string, payload.payload as string | ArrayBuffer)
        activeOperationId.value = current.activeOperationId
        result = await pending
      }
      applyInitResult(result)
      // File/handover sources index after init: rows become queryable while
      // the scan continues, so the explorer can be entered immediately.
      if (kind !== 'url') void startIndex()
      return result
    } catch (error) {
      // A failed/cancelled load must not leave stale progress behind.
      clearProgressState()
      throw error
    } finally {
      loadCount -= 1
      loading.value = loadCount > 0
    }
  }

  async function startIndex(): Promise<void> {
    const current = getEngine()
    if (indexState.value === 'running') return
    if (!sourceName.value) return // no source loaded; nothing to index
    indexState.value = 'running'
    indexError.value = null
    const pending = current.index()
    // The index owns a new operation: track it so its progress events are
    // current (and so cancelActive() targets it).
    activeOperationId.value = current.activeOperationId
    const operationId = current.activeOperationId
    try {
      await pending
      indexState.value = 'idle'
    } catch (error) {
      // If a newer operation took over (new source, reset, fatal), this
      // rejection is stale: the newer operation owns the state now.
      if (operationId !== null && operationId !== activeOperationId.value) {
        indexState.value = 'idle'
        return
      }
      if (error instanceof EngineRpcError && error.code === 'INDEXING_CANCELLED') {
        indexState.value = 'cancelled'
      } else if (
        error instanceof SourceReplacedError ||
        error instanceof EngineFatalError ||
        error instanceof EngineDisposedError
      ) {
        indexState.value = 'idle'
      } else {
        indexState.value = 'failed'
        indexError.value = error instanceof Error ? error.message : String(error)
      }
      progress.value = { ...IDLE_PROGRESS }
    }
  }

  async function cancelActive(): Promise<void> {
    const current = engine.value
    const operationId = activeOperationId.value
    if (!current || !operationId) return
    await current.cancel(operationId)
    clearProgressState()
  }

  function confirmUrlFallback(accept: boolean): void {
    fallbackRequest.value = null
    if (!fallbackResolve) return
    const resolve = fallbackResolve
    fallbackResolve = null
    resolve(accept)
  }

  const api: JsonlEngineApi = {
    engine,
    sourceName,
    sourceType,
    sourceSize,
    totalRows,
    loading,
    progress,
    indexState,
    indexError,
    indexing,
    activeOperationId,
    fallbackRequest,
    fatal,
    fatalMessage,
    getEngine,
    open,
    startIndex,
    cancelActive,
    confirmUrlFallback,
    async closeSource() {
      const current = engine.value
      confirmUrlFallback(false)
      clearMetadata()
      // A fatal engine cannot take RPCs; recoverFromFatal() is the path.
      if (current && !fatal.value) await current.clearSource()
    },
    async recoverFromFatal() {
      const current = engine.value
      if (current) await current.reset()
      fatal.value = false
      fatalMessage.value = null
      clearMetadata()
    },
    async disposeEngine() {
      const current = engine.value
      engine.value = null
      confirmUrlFallback(false)
      if (current) await current.dispose()
    },
  }
  return api
}

let singleton: JsonlEngineApi | null = null

/**
 * Returns the shared engine singleton. `engineOptions` is only honored the
 * first time (tests inject a fake worker factory via this).
 */
export function useJsonlEngine(engineOptions?: WorkerClientOptions): JsonlEngineApi {
  if (!singleton) singleton = createSingleton(engineOptions)
  return singleton
}

/** Test hook: reset the module singleton (fresh engine + state). */
export function resetJsonlEngineForTests(): void {
  singleton = null
}

let pageHideWired = false

/**
 * Wires pagehide cleanup once: the worker is disposed when the page is
 * hidden (bfcache or unload), releasing its memory and letting the next
 * startup clean stale spool artifacts.
 */
export function wireEnginePageCleanup(): void {
  if (pageHideWired || typeof window === 'undefined') return
  pageHideWired = true
  window.addEventListener('pagehide', () => {
    const current = singleton
    if (!current) return
    const currentEngine = current.engine.value
    current.engine.value = null
    void currentEngine?.dispose().catch(() => {})
  })
}
