/**
 * Exporter store (TSK0035): orchestration of the worker export contract.
 *
 * - FSA run: picker → pump → success toast, status back to idle.
 * - Blob run: pump → Blob download; over-threshold estimates hold for an
 *   explicit confirmation and RELEASE the export (edit lock) meanwhile.
 * - STALE_GENERATION retries once with the worker-reported generation.
 * - EXPORT_FILTER_IN_FLIGHT is refused typed (no retry).
 * - Cancel: exportCancel posted, worker's dead token fails the in-flight
 *   next, the run exits as cancelled (info toast, not an error).
 * - Every failure path toasts exactly once and returns to idle.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useFileStore } from '~/stores/file'
import { useFilterStore } from '~/stores/filter'
import { useExporterStore } from '~/stores/exporter'
import { useToastStore } from '~/stores/toasts'
import { useJsonlEngine, resetJsonlEngineForTests } from '~/composables/useJsonlEngine'
import { FakeWorker, success } from '../helpers/fakeWorker'

interface ScriptStep {
  type: string
  value?: unknown
  error?: [string, string, Record<string, unknown>?]
}

/** FakeWorker that answers requests from an ordered script (per type). */
class ScriptedWorker extends FakeWorker {
  constructor(private script: ScriptStep[]) {
    super()
  }
  override postMessage(message: unknown, transfer?: Transferable[]): void {
    super.postMessage(message, transfer)
    const msg = message as { type?: string; requestId?: string }
    const idx = this.script.findIndex((s) => s.type === msg.type)
    if (idx === -1 || !msg.requestId) return
    const step = this.script.splice(idx, 1)[0]!
    const requestId = msg.requestId
    queueMicrotask(() => {
      if (step.error) {
        this.emit({
          ns: 'jsonl-explorer',
          v: 1,
          requestId,
          ok: false,
          error: { code: step.error[0], message: step.error[1], details: step.error[2] },
        })
      } else {
        this.emit(success(requestId, step.value))
      }
    })
  }
}

let workers: FakeWorker[]
let injected: FakeWorker | null = null

function injectWorker(worker: FakeWorker): void {
  injected = worker
}

beforeEach(() => {
  setActivePinia(createPinia())
  resetJsonlEngineForTests()
  workers = []
  injected = null
  useJsonlEngine({
    workerFactory: () => {
      const worker = injected ?? new FakeWorker()
      injected = null
      workers.push(worker)
      return worker as unknown as Worker
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Opens a file so the exporter has something to export (answers initFile). */
async function openFile(worker: FakeWorker): Promise<void> {
  injectWorker(worker)
  const fileStore = useFileStore()
  const pending = fileStore.loadFile(new File(['a\n'], 'a.jsonl'))
  const last = worker.posted.at(-1) as { requestId?: string }
  worker.emit(success(last.requestId!, { name: 'a.jsonl', size: 2, type: 'file' }))
  await pending
}

function lastOfType(worker: FakeWorker, type: string): { requestId?: string; [k: string]: unknown } | undefined {
  return [...worker.posted].reverse().find((m) => (m as { type?: string }).type === type) as
    | { requestId?: string; [k: string]: unknown }
    | undefined
}

function answer(worker: FakeWorker, type: string, value: unknown): void {
  const msg = lastOfType(worker, type)
  if (!msg?.requestId) throw new Error(`no posted ${type}`)
  worker.emit(success(msg.requestId, value))
}

function fail(worker: FakeWorker, type: string, code: string, message: string, details?: Record<string, unknown>): void {
  const msg = lastOfType(worker, type)
  if (!msg?.requestId) throw new Error(`no posted ${type}`)
  worker.emit({ ns: 'jsonl-explorer', v: 1, requestId: msg.requestId, ok: false, error: { code, message, details } })
}

function startValue(token = 'tok'): unknown {
  return { token, estimatedBytes: 12, totalRows: 2, generation: 1, partial: false }
}

const chunk1 = () => ({ data: new TextEncoder().encode('a\n'), done: false, rowsExported: 1 })
const chunk2 = () => ({ data: new TextEncoder().encode('b\n'), done: true, rowsExported: 2 })

describe('exporter store (TSK0035)', () => {
  it('runs the FSA destination: start → pump with acks → success toast, idle again', async () => {
    const worker = new ScriptedWorker([
      { type: 'exportStart', value: startValue() },
      { type: 'exportNext', value: chunk1() },
      { type: 'exportNext', value: chunk2() },
      { type: 'exportAck', value: { acknowledged: true } },
      { type: 'exportAck', value: { acknowledged: true } },
    ])
    await openFile(worker)
    // FSA: stub the picker + writable.
    const writable = {
      write: async (_d: Uint8Array) => {},
      close: async () => {},
      abort: async () => {
        throw new Error('abort should not be called')
      },
    }
    vi.stubGlobal('window', {
      ...window,
      showSaveFilePicker: async () => ({ createWritable: async () => writable }),
    })

    const exporter = useExporterStore()
    await exporter.runFsa()

    expect(exporter.status).toBe('idle')
    expect(exporter.progress).toBeNull()
    // start carried the tracked view generation (0: no indexComplete yet).
    const start = lastOfType(worker, 'exportStart')!
    expect(start['generation']).toBe(0)
    // The ack gate held: next#2 only after ack#1.
    const seq = worker.posted
      .map((m) => (m as { type?: string }).type)
      .filter((t) => t === 'exportNext' || t === 'exportAck')
    expect(seq).toEqual(['exportNext', 'exportAck', 'exportNext', 'exportAck'])
    const toasts = useToastStore()
    expect(toasts.toasts.some((t) => t.type === 'success' && t.message.includes('2 rows'))).toBe(true)
    expect(toasts.toasts.some((t) => t.type === 'error')).toBe(false)
  })

  it('releases the worker state when the picker is closed (typed cancel, no error)', async () => {
    const worker = new ScriptedWorker([
      { type: 'exportStart', value: startValue() },
      { type: 'exportCancel', value: { cancelled: true } },
    ])
    await openFile(worker)
    vi.stubGlobal('showSaveFilePicker', async () => {
      throw new DOMException('Aborted', 'AbortError')
    })

    const exporter = useExporterStore()
    await exporter.runFsa()

    expect(exporter.status).toBe('idle')
    expect(lastOfType(worker, 'exportCancel')).toBeTruthy() // the token was released
    const toasts = useToastStore()
    expect(toasts.toasts.some((t) => t.type === 'info' && t.message.includes('cancelled'))).toBe(true)
    expect(toasts.toasts.some((t) => t.type === 'error')).toBe(false)
  })

  it('retries ONCE on STALE_GENERATION with the worker-reported generation', async () => {
    const worker = new ScriptedWorker([
      { type: 'exportStart', error: ['STALE_GENERATION', 'stale', { currentGeneration: 5 }] },
      { type: 'exportStart', value: startValue() },
      { type: 'exportNext', value: chunk1() },
      { type: 'exportNext', value: chunk2() },
      { type: 'exportAck', value: { acknowledged: true } },
      { type: 'exportAck', value: { acknowledged: true } },
    ])
    await openFile(worker)
    vi.stubGlobal('window', {
      ...window,
      showSaveFilePicker: async () => ({ createWritable: async () => makeWritable() }),
    })

    const exporter = useExporterStore()
    await exporter.runFsa()

    const starts = worker.posted.filter((m) => (m as { type?: string }).type === 'exportStart')
    expect(starts).toHaveLength(2)
    expect((starts[0] as { generation?: number })['generation']).toBe(0)
    expect((starts[1] as { generation?: number })['generation']).toBe(5) // worker-reported
    expect(exporter.status).toBe('idle')
    expect(useToastStore().toasts.some((t) => t.type === 'error')).toBe(false)
  })

  it('refuses typed (no retry) while a filter scan is in flight', async () => {
    const worker = new ScriptedWorker([
      { type: 'exportStart', error: ['EXPORT_FILTER_IN_FLIGHT', 'A filter is still running'] },
    ])
    await openFile(worker)
    vi.stubGlobal('window', {
      ...window,
      showSaveFilePicker: async () => ({ createWritable: async () => makeWritable() }),
    })

    const exporter = useExporterStore()
    await exporter.runFsa()

    expect(exporter.status).toBe('idle')
    expect(worker.posted.filter((m) => (m as { type?: string }).type === 'exportStart')).toHaveLength(1)
    const toasts = useToastStore()
    expect(toasts.toasts.some((t) => t.type === 'warning' && t.message.includes('filter'))).toBe(true)
  })

  it('blob below the threshold runs straight to the pump and revokes the URL', async () => {
    const worker = new ScriptedWorker([
      { type: 'exportStart', value: startValue() },
      { type: 'exportNext', value: chunk1() },
      { type: 'exportNext', value: chunk2() },
      { type: 'exportAck', value: { acknowledged: true } },
      { type: 'exportAck', value: { acknowledged: true } },
    ])
    await openFile(worker)
    vi.useFakeTimers()
    try {
      const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
      const exporter = useExporterStore()
      const pending = exporter.prepareBlob()
      await vi.advanceTimersByTimeAsync(0) // let the scripted microtask responses run
      await pending
      expect(exporter.status).toBe('idle')
      vi.advanceTimersByTime(1000)
      expect(revoke).toHaveBeenCalledTimes(1)
      expect(useToastStore().toasts.some((t) => t.type === 'success')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('blob above the threshold holds for confirmation and releases the export meanwhile', async () => {
    const big = { token: 'tok', estimatedBytes: 600 * 1024 * 1024, totalRows: 10, generation: 1, partial: false }
    const worker = new ScriptedWorker([
      { type: 'exportStart', value: big },
      { type: 'exportCancel', value: { cancelled: true } },
      { type: 'exportStart', value: { token: 'tok2', estimatedBytes: 600 * 1024 * 1024, totalRows: 10, generation: 1, partial: false } },
      { type: 'exportNext', value: chunk1() },
      { type: 'exportNext', value: chunk2() },
      { type: 'exportAck', value: { acknowledged: true } },
      { type: 'exportAck', value: { acknowledged: true } },
    ])
    await openFile(worker)
    vi.useFakeTimers()
    try {
      const exporter = useExporterStore()
      await exporter.prepareBlob()
      await vi.advanceTimersByTimeAsync(0)

      // Held for confirmation; the first export was released (lock freed).
      expect(exporter.blobConfirm).toEqual({
        estimatedBytes: 600 * 1024 * 1024,
        totalRows: 10,
        fileName: 'a.jsonl',
      })
      expect(exporter.status).toBe('idle')
      expect(lastOfType(worker, 'exportCancel')).toBeTruthy()
      expect(worker.posted.filter((m) => (m as { type?: string }).type === 'exportNext')).toHaveLength(0)

      await exporter.confirmBlob()
      await vi.advanceTimersByTimeAsync(0)
      expect(exporter.status).toBe('idle')
      expect(exporter.blobConfirm).toBeNull()
      // The confirmed run pumped with the fresh token.
      expect(lastOfType(worker, 'exportNext')?.['token']).toBe('tok2')
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancel stops the run: exportCancel posted, dead token fails the next, typed cancel toast', async () => {
    const worker = new ScriptedWorker([
      { type: 'exportStart', value: startValue() },
      { type: 'exportNext', value: chunk1() },
      { type: 'exportAck', value: { acknowledged: true } },
      { type: 'exportCancel', value: { cancelled: true } },
    ])
    await openFile(worker)

    const exporter = useExporterStore()
    const pending = exporter.prepareBlob()
    // Let the first chunk + ack land, then cancel while next#2 is in flight.
    await vi.waitFor(() => {
      const nexts = worker.posted.filter((m) => (m as { type?: string }).type === 'exportNext')
      const acks = worker.posted.filter((m) => (m as { type?: string }).type === 'exportAck')
      if (nexts.length < 1 || acks.length < 1) throw new Error('not yet')
    })
    await exporter.cancel()
    // The real worker answers the in-flight next with a dead token.
    fail(worker, 'exportNext', 'EXPORT_TOKEN_INVALID', 'Invalid or expired export token')
    await pending

    expect(exporter.status).toBe('idle')
    expect(exporter.progress).toBeNull()
    const toasts = useToastStore()
    expect(toasts.toasts.some((t) => t.type === 'info' && t.message.includes('cancelled'))).toBe(true)
    expect(toasts.toasts.some((t) => t.type === 'error')).toBe(false)
  })

  it('toasts a typed error (once) and returns to idle when the start fails', async () => {
    const worker = new ScriptedWorker([
      { type: 'exportStart', error: ['EXPORT_FAILED', 'Could not read the file while exporting.'] },
    ])
    await openFile(worker)

    const exporter = useExporterStore()
    await exporter.prepareBlob()
    expect(exporter.status).toBe('idle')
    expect(exporter.error).toBe('Could not read the file while exporting.')
    const toasts = useToastStore()
    const errors = toasts.toasts.filter((t) => t.type === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]!.message).toBe('Could not read the file while exporting.')
  })

  it('tracks the view generation from indexComplete/filter/editComplete events', async () => {
    const worker = new FakeWorker()
    injectWorker(worker)
    const fileStore = useFileStore()
    const pendingInit = fileStore.loadFile(new File(['a\n'], 'a.jsonl'))
    const last = worker.posted.at(-1) as { requestId?: string }
    worker.emit(success(last.requestId!, { name: 'a.jsonl', size: 2, type: 'file' }))
    await pendingInit
    const filterStore = useFilterStore()
    expect(filterStore.viewGeneration).toBe(0)

    worker.emit({ ns: 'jsonl-explorer', v: 1, type: 'indexComplete', operationId: 'op', totalRows: 1, totalBytes: 2, durationMs: 1, generation: 1 })
    expect(filterStore.viewGeneration).toBe(1)

    const filterPending = filterStore.runFilter('a', 'text')
    answer(worker, 'filter', { matchedRows: 1, totalRows: 1, generation: 2, partial: false })
    await filterPending
    expect(filterStore.viewGeneration).toBe(2)

    worker.emit({ ns: 'jsonl-explorer', v: 1, type: 'editComplete', operationId: 'op', lineId: 1, matchedRows: 1, totalRows: 1, generation: 3, partial: false, errorCount: 0, errorSummary: null })
    expect(filterStore.viewGeneration).toBe(3)

    filterStore.resetFilterState()
    expect(filterStore.viewGeneration).toBe(0)
  })
})

function makeWritable() {
  return { write: async (_d: Uint8Array) => {}, close: async () => {}, abort: async () => {} }
}
