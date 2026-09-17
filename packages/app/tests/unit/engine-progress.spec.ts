/**
 * Engine composable loading-state tests (TSK0019): slot-based progress
 * (download vs index), operation-scoped stale-event dropping, background
 * indexing for file sources, cancellation, and OPFS-fallback consent.
 *
 * The worker is faked (AutoWorker gates long-running inits; FakeWorker
 * simulates in-flight downloads) so every event is delivered on demand.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { nextTick } from 'vue'
import { useJsonlEngine, resetJsonlEngineForTests } from '~/composables/useJsonlEngine'
import { AutoWorker, FakeWorker, success, failure } from '../helpers/fakeWorker'
import { EngineFatalError, EngineRpcError, SourceReplacedError } from '~/engine/index'
import { PROTOCOL_NAMESPACE, PROTOCOL_VERSION } from '@jsonl-explorer/shared'

interface PostedOp {
  type: string
  requestId: string
  operationId?: string
}

function ev(partial: Record<string, unknown>): Record<string, unknown> {
  return { ns: PROTOCOL_NAMESPACE, v: PROTOCOL_VERSION, ...partial }
}

const tick = (): Promise<void> => nextTick()

function makeFile(): File {
  return new File(['{"a":1}\n'], 'sample.jsonl', { type: 'application/x-ndjson' })
}

describe('engine loading state (TSK0019)', () => {
  beforeEach(() => {
    resetJsonlEngineForTests()
  })

  it('tracks download and index slots separately for a URL load', async () => {
    const worker = new AutoWorker({ gate: ['initUrl'] })
    const engine = useJsonlEngine({ workerFactory: () => worker as unknown as Worker })

    const pending = engine.open('url', { url: 'https://example.com/a.jsonl' })
    await tick()
    const init = worker.posted[0] as PostedOp
    expect(init.type).toBe('initUrl')

    // Determinate download progress (Content-Length known, uncompressed).
    worker.emit(ev({ type: 'urlProgress', operationId: init.operationId, receivedBytes: 512, totalBytes: 2048 }))
    await tick()
    expect(engine.progress.value.download).toEqual({ percent: 25, bytes: 512, totalBytes: 2048, rows: null })

    // Unknown remaining size -> indeterminate (R12).
    worker.emit(ev({ type: 'urlProgress', operationId: init.operationId, receivedBytes: 700 }))
    await tick()
    expect(engine.progress.value.download?.percent).toBeNull()
    expect(engine.progress.value.download?.bytes).toBe(700)

    // Incremental indexing reports committed rows while the download runs.
    worker.emit(
      ev({
        type: 'indexProgress',
        operationId: init.operationId,
        progress: 10,
        committedRows: 12,
        committedBytes: 256,
        rowsProcessed: 12,
        totalBytes: 2048,
      }),
    )
    await tick()
    // Both slots are live at the same time.
    expect(engine.progress.value.download).not.toBeNull()
    expect(engine.progress.value.index).toEqual({ percent: 10, bytes: 256, totalBytes: 2048, rows: 12 })

    // indexComplete finalizes the row count and clears the index slot.
    worker.emit(
      ev({ type: 'indexComplete', operationId: init.operationId, totalRows: 42, totalBytes: 2048, durationMs: 5 }),
    )
    await tick()
    expect(engine.totalRows.value).toBe(42)
    expect(engine.progress.value.index).toBeNull()
    expect(engine.progress.value.download).not.toBeNull()

    // Init completion clears the download slot and loading flag — and the
    // row count from indexComplete survives (the response does not wipe it).
    worker.release()
    await pending
    expect(engine.loading.value).toBe(false)
    expect(engine.progress.value).toEqual({ download: null, index: null, filter: null })
    expect(engine.totalRows.value).toBe(42)
  })

  it('drops progress events from stale operations after a new load', async () => {
    const worker = new AutoWorker({ gate: ['initUrl'] })
    const engine = useJsonlEngine({ workerFactory: () => worker as unknown as Worker })

    const first = engine.open('url', { url: 'https://example.com/a.jsonl' })
    await tick()
    const initA = worker.posted[0] as PostedOp

    worker.release()
    await first

    // Second load: file (auto-index).
    await engine.open('file', { file: makeFile() })
    await tick()
    const indexMsg = worker.posted.find((m) => (m as PostedOp).type === 'index') as PostedOp
    expect(indexMsg.operationId).toBeTruthy()

    // Stale: a urlProgress from the FIRST operation must be ignored.
    worker.emit(ev({ type: 'urlProgress', operationId: initA.operationId, receivedBytes: 999, totalBytes: 1000 }))
    await tick()
    expect(engine.progress.value.download).toBeNull()

    // Current: index progress from the active operation is applied.
    worker.emit(
      ev({
        type: 'indexProgress',
        operationId: indexMsg.operationId,
        progress: 50,
        committedRows: 3,
        committedBytes: 100,
        rowsProcessed: 3,
        totalBytes: 200,
      }),
    )
    await tick()
    expect(engine.progress.value.index?.rows).toBe(3)
    expect(engine.progress.value.index?.percent).toBe(50)
  })

  it('starts a background index for file sources right after init', async () => {
    const worker = new AutoWorker({ gate: ['index'] })
    const engine = useJsonlEngine({ workerFactory: () => worker as unknown as Worker })

    await engine.open('file', { file: makeFile() })
    expect(engine.indexState.value).toBe('running')
    expect(engine.indexing.value).toBe(true)

    const indexMsg = worker.posted.find((m) => (m as PostedOp).type === 'index') as PostedOp
    worker.emit(
      ev({
        type: 'indexComplete',
        operationId: indexMsg.operationId,
        totalRows: 7,
        totalBytes: 11,
        durationMs: 3,
      }),
    )
    worker.release()
    await tick()
    await tick()
    expect(engine.indexState.value).toBe('idle')
    expect(engine.indexing.value).toBe(false)
    expect(engine.totalRows.value).toBe(7)
  })

  it('cancels the active URL load by operation id and clears progress', async () => {
    const worker = new FakeWorker()
    const engine = useJsonlEngine({ workerFactory: () => worker as unknown as Worker })

    const pending = engine.open('url', { url: 'https://example.com/a.jsonl' }).catch((e) => e)
    await tick()
    const init = worker.posted[0] as PostedOp

    // The FakeWorker answers nothing: fire the cancel, then answer it.
    void engine.cancelActive()
    await vi.waitFor(() =>
      expect(worker.posted.some((m) => (m as PostedOp).type === 'cancel')).toBe(true),
    )
    const cancelMsg = worker.posted.find((m) => (m as PostedOp).type === 'cancel') as PostedOp
    expect(cancelMsg.operationId).toBe(init.operationId)

    worker.emit(success(cancelMsg.requestId, {}))
    worker.emit(failure(init.requestId, 'CANCELLED', 'Cancelled'))
    const error: unknown = await pending
    expect(error).toBeInstanceOf(EngineRpcError)
    expect((error as EngineRpcError).code).toBe('CANCELLED')
    expect(engine.loading.value).toBe(false)
    expect(engine.progress.value).toEqual({ download: null, index: null, filter: null })
  })

  it('treats a cancelled background index as resumable, not failed', async () => {
    const worker = new AutoWorker({ gate: ['index'] })
    const engine = useJsonlEngine({ workerFactory: () => worker as unknown as Worker })

    await engine.open('file', { file: makeFile() })
    await tick()
    const indexMsg = worker.posted.find((m) => (m as PostedOp).type === 'index') as PostedOp
    expect(engine.indexState.value).toBe('running')

    await engine.cancelActive()
    const cancelMsg = worker.posted.find((m) => (m as PostedOp).type === 'cancel') as PostedOp
    expect(cancelMsg.operationId).toBe(indexMsg.operationId)

    worker.emit(failure(indexMsg.requestId, 'INDEXING_CANCELLED', 'Indexing cancelled'))
    await tick()
    await tick()
    expect(engine.indexState.value).toBe('cancelled')
    expect(engine.indexError.value).toBeNull()

    // Resume starts a NEW operation and runs to completion.
    void engine.startIndex()
    await vi.waitFor(() =>
      expect(worker.posted.filter((m) => (m as PostedOp).type === 'index').length).toBe(2),
    )
    const resumeMsg = worker.posted.filter((m) => (m as PostedOp).type === 'index')[1] as PostedOp
    expect(resumeMsg.operationId).not.toBe(indexMsg.operationId)
    worker.release()
    await vi.waitFor(() => expect(engine.indexState.value).toBe('idle'))
  })

  it('records a failed background index with its typed message', async () => {
    const worker = new AutoWorker({ gate: ['index'] })
    const engine = useJsonlEngine({ workerFactory: () => worker as unknown as Worker })

    await engine.open('file', { file: makeFile() })
    await tick()
    const indexMsg = worker.posted.find((m) => (m as PostedOp).type === 'index') as PostedOp

    worker.emit(failure(indexMsg.requestId, 'INDEXING_FAILED', 'Scan failed: bad utf-8'))
    await tick()
    await tick()
    expect(engine.indexState.value).toBe('failed')
    expect(engine.indexError.value).toBe('Scan failed: bad utf-8')
  })

  it('exposes the fallback request and answers it when confirmed', async () => {
    const worker = new AutoWorker({ gate: ['initUrl'] })
    const engine = useJsonlEngine({ workerFactory: () => worker as unknown as Worker })

    const pending = engine.open('url', { url: 'https://example.com/big.jsonl' })
    await tick()
    const init = worker.posted[0] as PostedOp

    worker.emit(
      ev({
        type: 'urlFallbackConfirm',
        operationId: init.operationId,
        url: 'https://example.com/big.jsonl',
        declaredBytes: 5368709120,
        reason: 'opfs-quota-exceeded',
      }),
    )
    await tick()
    expect(engine.fallbackRequest.value?.reason).toBe('opfs-quota-exceeded')
    expect(engine.fallbackRequest.value?.declaredBytes).toBe(5368709120)

    engine.confirmUrlFallback(true)
    await vi.waitFor(() =>
      expect(worker.posted.some((m) => (m as PostedOp).type === 'urlFallbackConfirm')).toBe(true),
    )
    const confirm = worker.posted.find((m) => (m as PostedOp).type === 'urlFallbackConfirm') as PostedOp & {
      accept: boolean
    }
    expect(confirm.accept).toBe(true)
    expect(confirm.operationId).toBe(init.operationId)
    expect(engine.fallbackRequest.value).toBeNull()

    worker.release()
    await pending
  })

  it('answers a pending fallback with reject when the source is closed', async () => {
    const worker = new AutoWorker({ gate: ['initUrl'] })
    const engine = useJsonlEngine({ workerFactory: () => worker as unknown as Worker })

    const pending = engine.open('url', { url: 'https://example.com/big.jsonl' }).catch((e) => e)
    await tick()
    const init = worker.posted[0] as PostedOp

    worker.emit(
      ev({
        type: 'urlFallbackConfirm',
        operationId: init.operationId,
        url: 'https://example.com/big.jsonl',
        reason: 'opfs-unavailable',
      }),
    )
    await tick()
    expect(engine.fallbackRequest.value).not.toBeNull()

    await engine.closeSource()
    expect(engine.fallbackRequest.value).toBeNull()
    const confirm = worker.posted.find((m) => (m as PostedOp).type === 'urlFallbackConfirm') as PostedOp & {
      accept: boolean
    }
    expect(confirm.accept).toBe(false)

    // Closing the source while init is in flight rejects the load.
    const error: unknown = await pending
    expect(error).toBeInstanceOf(SourceReplacedError)
    expect(engine.sourceName.value).toBeNull()
  })

  it('clears progress and answers false on a fatal worker error', async () => {
    const worker = new FakeWorker()
    const engine = useJsonlEngine({ workerFactory: () => worker as unknown as Worker })

    const pending = engine.open('url', { url: 'https://example.com/a.jsonl' }).catch((e) => e)
    await tick()
    const init = worker.posted[0] as PostedOp
    worker.emit(ev({ type: 'urlProgress', operationId: init.operationId, receivedBytes: 10, totalBytes: 100 }))
    worker.emit(
      ev({ type: 'urlFallbackConfirm', operationId: init.operationId, url: 'https://example.com/a.jsonl', reason: 'declared-size-over-quota' }),
    )
    await tick()
    expect(engine.progress.value.download).not.toBeNull()
    expect(engine.fallbackRequest.value).not.toBeNull()

    worker.fail()
    await tick()
    const error: unknown = await pending
    expect(error).toBeInstanceOf(EngineFatalError)
    expect(engine.fatal.value).toBe(true)
    expect(engine.fallbackRequest.value).toBeNull()
    expect(engine.progress.value.download).toBeNull()
    const confirm = worker.posted.find((m) => (m as PostedOp).type === 'urlFallbackConfirm') as PostedOp & {
      accept: boolean
    }
    expect(confirm.accept).toBe(false)
  })

  it('answers confirmUrlFallback(false) as a no-op when nothing is pending', () => {
    const worker = new FakeWorker()
    const engine = useJsonlEngine({ workerFactory: () => worker as unknown as Worker })
    expect(() => engine.confirmUrlFallback(false)).not.toThrow()
    expect(worker.posted.length).toBe(0)
  })
})
