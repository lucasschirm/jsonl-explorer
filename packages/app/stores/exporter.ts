/**
 * Export orchestration store (TSK0035).
 *
 * Connects the worker's snapshot/backpressure export contract (TSK0034) to
 * a browser destination:
 * - `runFsa()` — File System Access: picker → writable stream;
 * - `prepareBlob()` / `confirmBlob()` — Blob download; estimates above
 *   `exportBlobConfirmBytes` require an explicit confirmation FIRST (the
 *   Blob keeps the whole export in memory), so the pump is not started for
 *   a download the user might refuse.
 *
 * Generation discipline: exportStart carries the filter store's tracked
 * view generation; a STALE_GENERATION rejection (a bump landed between the
 * read and the RPC) retries ONCE with the worker-reported current
 * generation. EXPORT_FILTER_IN_FLIGHT is NOT retried — the user sees the
 * filter finishing and retries.
 *
 * Every exit path (success, cancel, failure, picker closed) clears the
 * running state, releases the worker's export state (final ack / cancel),
 * and toasts at most once with a typed, actionable message.
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { ExportChunk } from '@jsonl-explorer/shared'
import { ENGINE_DEFAULTS } from '~/engine/config/adr'
import { useJsonlEngine } from '~/composables/useJsonlEngine'
import { EngineRpcError } from '~/engine/workerClient'
import { useFileStore } from '~/stores/file'
import { useFilterStore } from '~/stores/filter'
import { useToastStore } from '~/stores/toasts'
import { blobExport, fsaExport, supportsFsa } from '~/utils/exportSave'
import type { ExportDestinationStatus, StartedExport } from '~/utils/exportSave'
import { formatBytes } from '~/utils/format'

export type ExportStatus = 'idle' | 'running'

export interface ExportProgress {
  rows: number
  totalRows: number
  bytes: number
}

interface BlobConfirmation {
  estimatedBytes: number
  totalRows: number
  fileName: string
}

export const useExporterStore = defineStore('exporter', () => {
  const engineApi = useJsonlEngine()
  const fileStore = useFileStore()
  const filterStore = useFilterStore()
  const toastStore = useToastStore()

  const status = ref<ExportStatus>('idle')
  const destination = ref<'fsa' | 'blob' | null>(null)
  const fileName = ref('')
  const progress = ref<ExportProgress | null>(null)
  const error = ref<string | null>(null)
  /** Blob estimate awaiting explicit confirmation (above the threshold). */
  const blobConfirm = ref<BlobConfirmation | null>(null)

  let token: string | null = null
  let cancelRequested = false

  const isRunning = computed(() => status.value === 'running')
  const hasFsa = computed(() => supportsFsa())
  /** Nothing to export, already running, or a filter scan still settling. */
  const canStart = computed(() => fileStore.hasFile && status.value === 'idle' && !filterStore.isRunning)
  const progressPercent = computed(() => {
    const p = progress.value
    if (!p || p.totalRows <= 0) return 0
    return Math.min(100, Math.round((p.rows / p.totalRows) * 100))
  })
  const defaultName = computed(() => fileStore.fileName ?? 'export.jsonl')

  function reportError(message: string): void {
    error.value = message
    toastStore.error(message, 'Export failed')
  }

  /**
   * exportStart carrying the tracked view generation, with ONE retry on
   * STALE_GENERATION using the worker-reported current generation (a bump
   * may have landed between our read and the RPC; the main thread's
   * tracking may not have caught up yet).
   */
  async function startExportedView(): Promise<StartedExport | null> {
    let retryGeneration: number | null = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const generation = retryGeneration ?? filterStore.viewGeneration
      try {
        const started = await engineApi.getEngine().exportStart({ generation })
        token = started.token
        return { token: started.token, totalRows: started.totalRows, estimatedBytes: started.estimatedBytes }
      } catch (err) {
        if (err instanceof EngineRpcError && err.code === 'STALE_GENERATION' && attempt === 0) {
          const reported = err.details?.['currentGeneration']
          retryGeneration = typeof reported === 'number' ? reported : filterStore.viewGeneration
          continue
        }
        if (err instanceof EngineRpcError && err.code === 'EXPORT_FILTER_IN_FLIGHT') {
          toastStore.warning(err.message, 'Export not started')
          return null
        }
        reportError(err instanceof Error ? err.message : 'Export failed to start')
        return null
      }
    }
    return null
  }

  /**
   * Releases the worker's export state when the run did NOT end on the
   * final ack (which already deletes it): picker closed, user cancel,
   * or a failure. Idempotent on the worker side.
   */
  function releaseToken(): void {
    if (!token) return
    const t = token
    token = null
    void engineApi.getEngine().exportCancel(t).catch(() => {})
  }

  /** Releases the running state after any destination run. */
  function finishRun(outcome: { status: ExportDestinationStatus; bytes: number; message?: string }): void {
    if (outcome.status !== 'saved') releaseToken()
    else token = null
    if (outcome.status === 'saved') {
      const totalRows = progress.value?.totalRows ?? 0
      toastStore.success(`Exported ${totalRows} rows (${formatBytes(outcome.bytes)}) to ${fileName.value}`, 'Export complete')
    } else if (outcome.status === 'cancelled') {
      toastStore.info(`Export of ${fileName.value} was cancelled.`, 'Export cancelled')
    } else {
      reportError(outcome.message ?? 'Export failed')
    }
    progress.value = null
    error.value = outcome.status === 'failed' ? error.value : null
    status.value = 'idle'
    destination.value = null
    cancelRequested = false
  }

  function onChunk(chunk: ExportChunk, totalRows: number): void {
    progress.value = { rows: chunk.rowsExported, totalRows, bytes: (progress.value?.bytes ?? 0) + chunk.data.byteLength }
  }

  /** File System Access: picker → stream chunks into the chosen file. */
  async function runFsa(): Promise<void> {
    const started = await startExportedView()
    if (!started) return
    destination.value = 'fsa'
    fileName.value = defaultName.value
    progress.value = { rows: 0, totalRows: started.totalRows, bytes: 0 }
    status.value = 'running'
    const outcome = await fsaExport(
      engineApi.getEngine(),
      started,
      defaultName.value,
      () => cancelRequested,
      (chunk) => onChunk(chunk, started.totalRows),
    )
    finishRun(outcome)
  }

  /**
   * Blob fallback: start the export to read the estimate; above the
   * threshold, RELEASE it (exportCancel — the edit lock frees) and wait
   * for the user's confirmation. Below it, straight to the pump.
   */
  async function prepareBlob(): Promise<void> {
    const started = await startExportedView()
    if (!started) return
    destination.value = 'blob'
    fileName.value = defaultName.value
    if (started.estimatedBytes > ENGINE_DEFAULTS.exportBlobConfirmBytes) {
      // Release the export (and the edit lock) while the user decides.
      releaseToken()
      blobConfirm.value = { estimatedBytes: started.estimatedBytes, totalRows: started.totalRows, fileName: fileName.value }
      return
    }
    await runBlobPump(started)
  }

  /** After the user confirmed an over-threshold estimate. */
  async function confirmBlob(): Promise<void> {
    const pending = blobConfirm.value
    if (!pending) return
    blobConfirm.value = null
    const started = await startExportedView()
    if (!started) return
    fileName.value = pending.fileName
    await runBlobPump(started)
  }

  function dismissBlobConfirm(): void {
    blobConfirm.value = null
  }

  async function runBlobPump(started: StartedExport): Promise<void> {
    progress.value = { rows: 0, totalRows: started.totalRows, bytes: 0 }
    status.value = 'running'
    const outcome = await blobExport(
      engineApi.getEngine(),
      started,
      defaultName.value,
      () => cancelRequested,
      (chunk) => onChunk(chunk, started.totalRows),
    )
    finishRun(outcome)
  }

  /**
   * User cancel: stop the pump and release the worker state (which also
   * fails any in-flight exportNext with EXPORT_TOKEN_INVALID, unwinding
   * the pump). The info toast comes from the run's exit path.
   */
  async function cancel(): Promise<void> {
    if (!token && status.value !== 'running') return
    cancelRequested = true
    if (token) {
      const t = token
      token = null
      await engineApi.getEngine().exportCancel(t).catch(() => {})
    }
  }

  return {
    status,
    destination,
    fileName,
    progress,
    error,
    blobConfirm,
    isRunning,
    hasFsa,
    canStart,
    progressPercent,
    defaultName,
    runFsa,
    prepareBlob,
    confirmBlob,
    dismissBlobConfirm,
    cancel,
  }
})
