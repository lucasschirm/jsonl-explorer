/**
 * useJsonlEngine — the single owner of the worker engine on the main
 * thread.
 *
 * Exactly one engine (and therefore at most one source) exists at a time.
 * Every piece of state exposed here is scalar UI metadata (name, size,
 * row counts, progress, generation): the engine instance is held in a
 * `shallowRef` and the source bytes / offset / match indexes never enter
 * Pinia or Vue proxies.
 */

import { ref, shallowRef, type Ref, type ShallowRef } from 'vue'
import { createJsonlEngine, EngineFatalError, type WorkerClientOptions } from '~/engine/index'
import type { EngineEvent, InitResult, JsonlEngine } from '@jsonl-explorer/shared'

export type SourceType = InitResult['type']

export interface EngineProgressState {
  kind: 'index' | 'url' | 'filter' | 'none'
  /** Determinate percent (0-100) or null when indeterminate (R12). */
  percent: number | null
  receivedBytes: number
  totalBytes: number | null
}

const IDLE_PROGRESS: EngineProgressState = {
  kind: 'none',
  percent: null,
  receivedBytes: 0,
  totalBytes: null,
}

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
  fatal: Ref<boolean>
  fatalMessage: Ref<string | null>
  getEngine(): JsonlEngine
  open(kind: OpenKind, payload: OpenPayload): Promise<InitResult>
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
  const fatal = ref(false)
  const fatalMessage = ref<string | null>(null)

  function handleEngineEvent(event: EngineEvent): void {
    switch (event.type) {
      case 'indexProgress':
        progress.value = {
          kind: 'index',
          percent: event.totalBytes !== undefined ? event.progress : null,
          receivedBytes: event.committedBytes,
          totalBytes: event.totalBytes ?? null,
        }
        break
      case 'urlProgress':
        progress.value = {
          kind: 'url',
          percent:
            event.totalBytes !== undefined && event.totalBytes > 0
              ? Math.min(100, Math.round((event.receivedBytes / event.totalBytes) * 100))
              : null,
          receivedBytes: event.receivedBytes,
          totalBytes: event.totalBytes ?? null,
        }
        break
      case 'filterProgress':
        progress.value = {
          kind: 'filter',
          percent: event.totalBytes !== undefined ? event.progress : null,
          receivedBytes: event.scannedRows,
          totalBytes: null,
        }
        break
      case 'indexComplete':
        totalRows.value = event.totalRows
        progress.value = { ...IDLE_PROGRESS }
        break
      case 'filterComplete':
        if (progress.value.kind === 'filter') progress.value = { ...IDLE_PROGRESS }
        break
    }
  }

  function handleEngineError(error: Error): void {
    if (error instanceof EngineFatalError) {
      fatal.value = true
      fatalMessage.value = 'The processing worker crashed. Reset to try again.'
      loading.value = false
      progress.value = { ...IDLE_PROGRESS }
    }
  }

  function getEngine(): JsonlEngine {
    if (!engine.value) {
      const created = createJsonlEngine(engineOptions)
      created.onProgress(handleEngineEvent)
      created.onError(handleEngineError)
      engine.value = created
    }
    return engine.value
  }

  function applyInitResult(result: InitResult): void {
    sourceName.value = result.name
    sourceType.value = result.type
    sourceSize.value = result.size
    totalRows.value = 0
    progress.value = { ...IDLE_PROGRESS }
  }

  function clearMetadata(): void {
    sourceName.value = null
    sourceType.value = null
    sourceSize.value = 0
    totalRows.value = 0
    progress.value = { ...IDLE_PROGRESS }
  }

  let loadCount = 0

  async function open(kind: OpenKind, payload: OpenPayload): Promise<InitResult> {
    const current = getEngine()
    loadCount += 1
    loading.value = true
    try {
      let result: InitResult
      if (kind === 'file') {
        result = await current.initFile(payload.file as File)
      } else if (kind === 'url') {
        result = await current.initUrl(payload.url as string, {
          headers: payload.headers,
          pageOrigin: typeof location !== 'undefined' ? location.origin : undefined,
        })
      } else {
        result = await current.initMemory(payload.name as string, payload.payload as string | ArrayBuffer)
      }
      applyInitResult(result)
      return result
    } finally {
      loadCount -= 1
      loading.value = loadCount > 0
    }
  }

  const api: JsonlEngineApi = {
    engine,
    sourceName,
    sourceType,
    sourceSize,
    totalRows,
    loading,
    progress,
    fatal,
    fatalMessage,
    getEngine,
    open,
    async closeSource() {
      const current = engine.value
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
