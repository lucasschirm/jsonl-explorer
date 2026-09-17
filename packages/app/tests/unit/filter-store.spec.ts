/**
 * Filter store (TSK0026): result lifecycle.
 *
 * - A successful RPC stores the result (including `partial`).
 * - FILTER_CANCELLED is not an error: status returns to idle, the previous
 *   result is kept, and nothing is rethrown.
 * - Other failures set `error` but keep the previous result.
 * - filterComplete events (automatic completion reruns) upgrade a partial
 *   result to the final one; stale (older-generation) events are ignored.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useFileStore } from '~/stores/file'
import { useFilterStore } from '~/stores/filter'
import { useJsonlEngine, resetJsonlEngineForTests } from '~/composables/useJsonlEngine'
import { PROTOCOL_NAMESPACE, PROTOCOL_VERSION } from '@jsonl-explorer/shared'
import { AutoWorker, FakeWorker, failure, success } from '../helpers/fakeWorker'

let workers: FakeWorker[]
let injected: FakeWorker | null = null

function injectWorker(worker: FakeWorker | AutoWorker): void {
  injected = worker
}

beforeEach(() => {
  setActivePinia(createPinia())
  resetJsonlEngineForTests()
  workers = []
  injected = null
  useJsonlEngine({
    workerFactory: () => {
      const worker = injected ?? new AutoWorker()
      injected = null
      workers.push(worker)
      return worker as unknown as Worker
    },
  })
})

async function openFile(worker: FakeWorker | AutoWorker = new AutoWorker()): Promise<void> {
  if (injected === null) injectWorker(worker)
  const fileStore = useFileStore()
  const pending = fileStore.loadFile(new File(['a\n'], 'a.jsonl'))
  if (worker instanceof FakeWorker) {
    // FakeWorker never auto-responds: answer the initFile RPC ourselves.
    answerLast(worker, { name: 'a.jsonl', size: 11, type: 'file' })
  }
  await pending
}

/** Answers the last posted request (by its requestId) with a canned value. */
function answerLast(worker: FakeWorker, value: unknown): void {
  const last = worker.posted.at(-1) as { requestId?: string }
  worker.emit(success(last.requestId!, value))
}

function failLast(worker: FakeWorker, code: string, message: string): void {
  const last = worker.posted.at(-1) as { requestId?: string }
  worker.emit(failure(last.requestId!, code, message))
}

describe('filter store result lifecycle (TSK0026)', () => {
  it('stores the worker result including the partial flag', async () => {
    const worker = new FakeWorker()
    injectWorker(worker)
    await openFile(worker)
    const filterStore = useFilterStore()

    const pending = filterStore.runFilter('hello', 'text')
    answerLast(worker, { matchedRows: 2, totalRows: 10, generation: 1, partial: true })
    const result = await pending

    expect(result).toEqual({ matchedRows: 2, totalRows: 10, generation: 1, partial: true })
    expect(filterStore.matchedRows).toBe(2)
    expect(filterStore.totalRows).toBe(10)
    expect(filterStore.generation).toBe(1)
    expect(filterStore.isPartial).toBe(true)
    expect(filterStore.status).toBe('idle')
  })

  it('a cancelled filter is not an error and keeps the previous result', async () => {
    const worker = new FakeWorker()
    injectWorker(worker)
    await openFile(worker)
    const filterStore = useFilterStore()

    // Establish a previous result first.
    const first = filterStore.runFilter('hello', 'text')
    answerLast(worker, { matchedRows: 2, totalRows: 10, generation: 1, partial: false })
    await first
    expect(filterStore.result).not.toBeNull()

    // A second run is cancelled by the worker.
    const second = filterStore.runFilter('world', 'text')
    failLast(worker, 'FILTER_CANCELLED', 'Filter cancelled')
    await expect(second).resolves.toEqual(filterStore.result)
    expect(filterStore.status).toBe('idle')
    expect(filterStore.error).toBeNull()
    // The previous result survived the cancel.
    expect(filterStore.result).toEqual({ matchedRows: 2, totalRows: 10, generation: 1, partial: false })
    expect(filterStore.isPartial).toBe(false)
  })

  it('a real failure sets error but keeps the previous result', async () => {
    const worker = new FakeWorker()
    injectWorker(worker)
    await openFile(worker)
    const filterStore = useFilterStore()

    const first = filterStore.runFilter('hello', 'text')
    answerLast(worker, { matchedRows: 2, totalRows: 10, generation: 1, partial: false })
    await first

    const second = filterStore.runFilter('world', 'text')
    failLast(worker, 'FILTER_FAILED', 'boom')
    await expect(second).rejects.toThrow('boom')
    expect(filterStore.status).toBe('error')
    expect(filterStore.error).toBe('boom')
    expect(filterStore.result).toEqual({ matchedRows: 2, totalRows: 10, generation: 1, partial: false })
  })

  it('adopts filterComplete events from automatic completion reruns', async () => {
    const worker = new FakeWorker()
    injectWorker(worker)
    await openFile(worker)
    const filterStore = useFilterStore()

    // A partial result is active (indexing still in flight).
    const pending = filterStore.runFilter('"n":42', 'text')
    answerLast(worker, { matchedRows: 0, totalRows: 0, generation: 1, partial: true })
    await pending
    expect(filterStore.isPartial).toBe(true)

    // Indexing completes: the worker reruns the latest query and announces
    // the final result via filterComplete (no RPC in flight).
    worker.emit({
      ns: PROTOCOL_NAMESPACE,
      v: PROTOCOL_VERSION,
      type: 'filterComplete',
      operationId: 'filter-rerun-1',
      matchedRows: 11,
      totalRows: 1000,
      durationMs: 3,
      generation: 3,
      partial: false,
    })
    expect(filterStore.matchedRows).toBe(11)
    expect(filterStore.totalRows).toBe(1000)
    expect(filterStore.generation).toBe(3)
    expect(filterStore.isPartial).toBe(false)
    expect(filterStore.status).toBe('idle')
  })

  it('ignores stale filterComplete events (older generation)', async () => {
    const worker = new FakeWorker()
    injectWorker(worker)
    await openFile(worker)
    const filterStore = useFilterStore()

    const pending = filterStore.runFilter('hello', 'text')
    answerLast(worker, { matchedRows: 2, totalRows: 10, generation: 5, partial: false })
    await pending

    // A late event from an OLDER generation must not downgrade the state.
    worker.emit({
      ns: PROTOCOL_NAMESPACE,
      v: PROTOCOL_VERSION,
      type: 'filterComplete',
      operationId: 'filter-rerun-1',
      matchedRows: 99,
      totalRows: 100,
      durationMs: 1,
      generation: 2,
      partial: true,
    })
    expect(filterStore.matchedRows).toBe(2)
    expect(filterStore.generation).toBe(5)
    expect(filterStore.isPartial).toBe(false)
  })

  it('resetFilterState drops the result and partiality', async () => {
    const worker = new AutoWorker()
    injectWorker(worker)
    await openFile(worker)
    const filterStore = useFilterStore()
    const result = await filterStore.runFilter('hello', 'text')
    expect(result).not.toBeNull()

    filterStore.resetFilterState()
    expect(filterStore.result).toBeNull()
    expect(filterStore.isPartial).toBe(false)
    expect(filterStore.matchedRows).toBe(0)
    expect(filterStore.status).toBe('idle')
  })
})

describe('filter store: clear + row-error summary (TSK0028)', () => {
  it('clearFilter drops the view: RPC, match-all result, empty query', async () => {
    const worker = new FakeWorker()
    injectWorker(worker)
    await openFile(worker)
    const filterStore = useFilterStore()

    const pending = filterStore.runFilter('hello', 'text')
    answerLast(worker, { matchedRows: 2, totalRows: 10, generation: 1, partial: false })
    await pending
    expect(filterStore.hasActiveFilter).toBe(true)

    const clearPending = filterStore.clearFilter()
    const clearMsg = worker.posted.at(-1) as { type: string }
    expect(clearMsg.type).toBe('clearFilter')
    answerLast(worker, { matchedRows: 10, totalRows: 10, generation: 2, partial: false })
    await clearPending

    expect(filterStore.result).toEqual({ matchedRows: 10, totalRows: 10, generation: 2, partial: false })
    expect(filterStore.query).toBe('')
    expect(filterStore.status).toBe('idle')
    expect(filterStore.error).toBeNull()
  })

  it('clearFilter is a no-op RPC-wise when no filter is active', async () => {
    const worker = new FakeWorker()
    injectWorker(worker)
    await openFile(worker)
    const filterStore = useFilterStore()
    const postedBefore = worker.posted.length

    await filterStore.clearFilter()

    expect(worker.posted.length).toBe(postedBefore)
    expect(filterStore.query).toBe('')
    expect(filterStore.status).toBe('idle')
  })

  it('a failed clear keeps the last query (retryable) and sets error', async () => {
    const worker = new FakeWorker()
    injectWorker(worker)
    await openFile(worker)
    const filterStore = useFilterStore()

    const pending = filterStore.runFilter('hello', 'text')
    answerLast(worker, { matchedRows: 2, totalRows: 10, generation: 1, partial: false })
    await pending

    const clearPending = filterStore.clearFilter()
    failLast(worker, 'FILTER_FAILED', 'clear failed')
    await expect(clearPending).rejects.toThrow('clear failed')
    expect(filterStore.query).toBe('hello')
    expect(filterStore.status).toBe('error')
    expect(filterStore.error).toBe('clear failed')
    // The previous (filtered) view survives a failed clear.
    expect(filterStore.result).toEqual({ matchedRows: 2, totalRows: 10, generation: 1, partial: false })
  })

  it('exposes row-error count and one-line summary from the result', async () => {
    const worker = new FakeWorker()
    injectWorker(worker)
    await openFile(worker)
    const filterStore = useFilterStore()

    const pending = filterStore.runFilter('.x', 'jq')
    answerLast(worker, {
      matchedRows: 1,
      totalRows: 4,
      generation: 1,
      partial: false,
      errorCount: 3,
      errorSummary: 'jq: error (at <stdin>:2): Cannot index string with number',
    })
    await pending

    expect(filterStore.errorCount).toBe(3)
    expect(filterStore.errorSummary).toBe('jq: error (at <stdin>:2): Cannot index string with number')
    expect(filterStore.error).toBeNull() // row errors are NOT operation failures
    expect(filterStore.status).toBe('idle')
  })

  it('filterComplete reruns propagate the row-error summary', async () => {
    const worker = new FakeWorker()
    injectWorker(worker)
    await openFile(worker)
    const filterStore = useFilterStore()

    worker.emit({
      ns: PROTOCOL_NAMESPACE,
      v: PROTOCOL_VERSION,
      type: 'filterComplete',
      operationId: 'filter-rerun-2',
      matchedRows: 5,
      totalRows: 100,
      durationMs: 2,
      errorCount: 1,
      errorSummary: 'invalid JSON near line 42',
      generation: 2,
      partial: false,
    })
    expect(filterStore.errorCount).toBe(1)
    expect(filterStore.errorSummary).toBe('invalid JSON near line 42')
  })
})
