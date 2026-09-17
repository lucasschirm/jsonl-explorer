import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useFileStore } from '~/stores/file'
import { useFilterStore } from '~/stores/filter'
import { useSelectionStore } from '~/stores/selection'
import { useJsonlEngine, resetJsonlEngineForTests } from '~/composables/useJsonlEngine'
import { InitInProgressError } from '~/engine/workerClient'
import { PROTOCOL_NAMESPACE, PROTOCOL_VERSION } from '@jsonl-explorer/shared'
import { AutoWorker } from '../helpers/fakeWorker'

let workers: AutoWorker[]
let injected: AutoWorker | null = null

/** Queues a specific worker to be used for the next engine spawn. */
function injectWorker(worker: AutoWorker): void {
  injected = worker
}

beforeEach(() => {
  setActivePinia(createPinia())
  resetJsonlEngineForTests()
  workers = []
  injected = null
  // First call wires the fake factory into the module singleton.
  useJsonlEngine({
    workerFactory: () => {
      const worker = injected ?? new AutoWorker()
      injected = null
      workers.push(worker)
      return worker as unknown as Worker
    },
  })
})

describe('file store', () => {
  it('stores scalar metadata only — no File, bytes, or indexes in state', async () => {
    const fileStore = useFileStore()
    await fileStore.loadFile(new File(['line1\n'], 'a.jsonl', { type: 'application/jsonl' }))

    expect(fileStore.metadata).toEqual({ name: 'a.jsonl', size: 11, type: 'file' })
    expect(fileStore.hasFile).toBe(true)
    expect(fileStore.fileName).toBe('a.jsonl')
    expect(fileStore.fileSize).toBe(11)

    // The whole store state must be plain JSON — reactive state never holds
    // the File object, source bytes, or offset/match arrays.
    const state = JSON.parse(JSON.stringify(fileStore.$state))
    expect(state.metadata).toEqual({ name: 'a.jsonl', size: 11, type: 'file' })
    expect(JSON.stringify(state)).not.toContain('Uint8Array')
    expect(Object.keys(state)).not.toContain('file')
  })

  it('a second open fully disposes the first source (worker-side) and resets derived state', async () => {
    const fileStore = useFileStore()
    const filterStore = useFilterStore()
    const selectionStore = useSelectionStore()

    await fileStore.loadFile(new File(['a\n'], 'a.jsonl'))
    selectionStore.add(1)
    selectionStore.add(2)
    await filterStore.runFilter('a', 'text')
    expect(selectionStore.count).toBe(2)
    expect(filterStore.matchedRows).toBe(3)

    await fileStore.loadFromUrl('https://example.com/b.jsonl')

    expect(fileStore.metadata).toEqual({
      name: 'remote.jsonl',
      size: 22,
      type: 'url',
      url: 'https://example.com/b.jsonl',
    })
    expect(selectionStore.count).toBe(0)
    expect(filterStore.result).toBeNull()
    expect(filterStore.query).toBe('')
  })

  it('reset() fully disposes the engine (dispose RPC + terminate) and clears local metadata', async () => {
    const fileStore = useFileStore()
    await fileStore.loadFile(new File(['a\n'], 'a.jsonl'))
    const worker = workers[0]!

    await fileStore.reset()

    expect(fileStore.hasFile).toBe(false)
    expect(fileStore.metadata).toBeNull()
    // The worker-side dispose RPC runs first (spool cleanup), then the
    // worker is terminated — no warm worker is kept across sources.
    const disposeRpcs = worker.posted.filter((m) => (m as { type?: string }).type === 'dispose')
    expect(disposeRpcs.length).toBe(1)
    expect(worker.terminated).toBe(1)

    // The next load lazily creates a fresh engine (and worker).
    await fileStore.loadFile(new File(['b\n'], 'b.jsonl'))
    expect(workers.length).toBe(2)
    expect(workers[1]).not.toBe(worker)
  })

  it('concurrent opens surface a typed error and do not clear the in-flight load', async () => {
    const fileStore = useFileStore()
    // The engine spawns lazily, so the first open gets this gated worker.
    const worker = new AutoWorker({ gate: ['initFile', 'initUrl'] })
    injectWorker(worker)
    const first = fileStore.loadFile(new File(['a\n'], 'a.jsonl'))
    await expect(fileStore.loadFromUrl('https://example.com/b.jsonl')).rejects.toBeInstanceOf(InitInProgressError)
    expect(fileStore.isLoading).toBe(true)

    worker.release()
    await first
    expect(fileStore.metadata?.name).toBe('a.jsonl')
    expect(fileStore.isLoading).toBe(false)
    // The rejected concurrent open left its typed error visible.
    expect(fileStore.loadError).toMatch(/already in progress/i)
  })

  it('a fatal worker error surfaces a reset path and recoverFromFatal restores the engine', async () => {
    const fileStore = useFileStore()
    const engineApi = useJsonlEngine()
    await fileStore.loadFile(new File(['a\n'], 'a.jsonl'))
    const deadWorker = workers[0]!

    deadWorker.fail()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(engineApi.fatal.value).toBe(true)
    expect(engineApi.fatalMessage.value).toMatch(/crashed/i)

    await engineApi.recoverFromFatal()
    expect(engineApi.fatal.value).toBe(false)
    expect(engineApi.fatalMessage.value).toBeNull()
    expect(fileStore.hasFile).toBe(false)
    expect(deadWorker.terminated).toBe(1)

    // The engine is usable again: a fresh worker is spawned on demand.
    await fileStore.loadFile(new File(['b\n'], 'b.jsonl'))
    expect(workers).toHaveLength(2)
    expect(fileStore.metadata?.name).toBe('b.jsonl')
  })

  it('disposes the worker when the engine is disposed (pagehide path)', async () => {
    const engineApi = useJsonlEngine()
    const fileStore = useFileStore()
    await fileStore.loadFile(new File(['a\n'], 'a.jsonl'))
    const worker = workers[0]!

    await engineApi.disposeEngine()
    expect(worker.terminated).toBe(1)
    expect(fileStore.getEngine()).toBeNull()
  })
})

describe('filter store', () => {
  it('runFilter stores the worker result and resets progress afterwards', async () => {
    const fileStore = useFileStore()
    const filterStore = useFilterStore()
    await fileStore.loadFile(new File(['a\n'], 'a.jsonl'))

    const result = await filterStore.runFilter('a', 'text')

    expect(result).toEqual({ matchedRows: 3, totalRows: 10, generation: 1 })
    expect(filterStore.matchedRows).toBe(3)
    expect(filterStore.totalRows).toBe(10)
    expect(filterStore.generation).toBe(1)
    expect(filterStore.status).toBe('idle')
    expect(filterStore.progress).toBeNull()
  })

  it('ignores progress events from stale operations', async () => {
    const fileStore = useFileStore()
    const filterStore = useFilterStore()
    await fileStore.loadFile(new File(['a\n'], 'a.jsonl'))
    const worker = workers[0]!

    const first = filterStore.runFilter('stale', 'text')
    await first
    // A late progress event from a superseded operation must be ignored.
    worker.emit({
      ns: PROTOCOL_NAMESPACE,
      v: PROTOCOL_VERSION,
      type: 'filterProgress',
      operationId: 'filter-000-old',
      progress: 0,
      matchedRows: 99,
      scannedRows: 99,
    })
    expect(filterStore.progress).toBeNull()
    expect(filterStore.matchedRows).toBe(3)
  })

  it('streams live progress while a filter is running', async () => {
    const fileStore = useFileStore()
    const filterStore = useFilterStore()
    const worker = new AutoWorker({ gate: ['filter'] })
    injectWorker(worker)
    await fileStore.loadFile(new File(['a\n'], 'a.jsonl'))

    const pending = filterStore.runFilter('live', 'text')
    const operationId = (worker.posted.find((m) => (m as { type?: string }).type === 'filter') as {
      operationId: string
    }).operationId

    worker.emit({
      ns: PROTOCOL_NAMESPACE,
      v: PROTOCOL_VERSION,
      type: 'filterProgress',
      operationId,
      progress: 40,
      matchedRows: 2,
      scannedRows: 5,
    })
    expect(filterStore.progress).toEqual({ scannedRows: 5, matchedRows: 2 })

    worker.release()
    await pending
    expect(filterStore.status).toBe('idle')
  })
})

describe('engine composable', () => {
  it('forwards the page origin for URL inits (CORS heuristic input)', async () => {
    const fileStore = useFileStore()
    await fileStore.loadFromUrl('https://example.com/a.jsonl')
    const worker = workers[0]!
    const initMessage = worker.posted.find((m) => (m as { type?: string }).type === 'initUrl') as {
      pageOrigin?: string
    }
    expect(initMessage.pageOrigin).toBe(location.origin)
  })

  it('disposes the engine on pagehide (worker released before unload)', async () => {
    const { wireEnginePageCleanup } = await import('~/composables/useJsonlEngine')
    const fileStore = useFileStore()
    await fileStore.loadFile(new File(['a\n'], 'a.jsonl'))
    const worker = workers[0]!

    wireEnginePageCleanup()
    window.dispatchEvent(new Event('pagehide'))
    // dispose is graceful-then-hard: let the ack microtask/timeout run.
    await new Promise((resolve) => setTimeout(resolve, 400))

    expect(worker.terminated).toBe(1)
    expect(useJsonlEngine().engine.value).toBeNull()
  })
})

describe('selection store', () => {
  it('toggles, ranges, and resets by line id only', () => {
    const selectionStore = useSelectionStore()
    selectionStore.add(1)
    selectionStore.add(2)
    selectionStore.toggle(2)
    expect(selectionStore.count).toBe(1)
    expect(selectionStore.has(1)).toBe(true)
    expect(selectionStore.has(2)).toBe(false)

    selectionStore.selectRange(4, 2) // inclusive, order-insensitive
    expect(selectionStore.count).toBe(4)
    expect(selectionStore.has(2)).toBe(true)
    expect(selectionStore.has(4)).toBe(true)

    selectionStore.set([9])
    expect(selectionStore.count).toBe(1)
    selectionStore.resetSelection()
    expect(selectionStore.isEmpty).toBe(true)
  })
})
