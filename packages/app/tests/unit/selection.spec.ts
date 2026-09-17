/**
 * Selection transitions (TSK0023): auto-select the first row once
 * available; keep the active row across view changes when it still
 * matches (worker-answered via linePosition), replace it with the first
 * result otherwise, clear for zero results; clear on source replacement.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { nextTick } from 'vue'
import { useJsonlEngine, resetJsonlEngineForTests } from '~/composables/useJsonlEngine'
import { useRowStore } from '~/stores/rows'
import { useSelectionStore } from '~/stores/selection'
import type { RowData } from '@jsonl-explorer/shared'
import { FakeWorker, success } from '../helpers/fakeWorker'

interface PostedOp {
  type: string
  requestId?: string
  start?: number
  count?: number
  generation?: number
  lineId?: number
}

function makeRow(displayIndex: number, lineId: number, text: string): RowData {
  return { lineId, displayIndex, text, isEdited: false, byteLength: text.length }
}

describe('selection transitions (TSK0023)', () => {
  let pinia: Pinia
  let worker: FakeWorker
  let rowStore: ReturnType<typeof useRowStore>
  let selectionStore: ReturnType<typeof useSelectionStore>

  const postedOps = (type: string): PostedOp[] =>
    worker.posted.filter((m) => (m as PostedOp).type === type) as PostedOp[]

  /** Answer the most recent op of a type (tests pair calls with waits). */
  function answerLast(type: string, value: unknown): void {
    const ops = postedOps(type)
    expect(ops.length, `a ${type} RPC must exist`).toBeGreaterThan(0)
    const op = ops[ops.length - 1]!
    worker.emit(success(op.requestId!, value))
  }

  async function initSource(): Promise<void> {
    const pending = useJsonlEngine().open('file', new File(['a\n'], 't.jsonl'))
    await vi.waitFor(() => {
      expect(worker.posted.some((m) => (m as PostedOp).type === 'initFile')).toBe(true)
    })
    const op = worker.posted.find((m) => (m as PostedOp).type === 'initFile') as PostedOp
    worker.emit(success(op.requestId!, { name: 't.jsonl', size: 2, type: 'file' }))
    await pending
  }

  /** Index commit: bumps generation + totalFiltered on the rows store. */
  function emitIndexComplete(totalRows: number, generation: number): void {
    worker.emit({
      ns: 'jsonl-explorer',
      v: 1,
      type: 'indexComplete',
      operationId: 'op-index',
      totalRows,
      totalBytes: totalRows * 10,
      durationMs: 1,
      generation,
    })
  }

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    resetJsonlEngineForTests()
    worker = new FakeWorker()
    useJsonlEngine({ workerFactory: () => worker as unknown as Worker })
    rowStore = useRowStore()
    selectionStore = useSelectionStore()
  })

  it('auto-selects the first row once it is available', async () => {
    await initSource()
    expect(selectionStore.activeLineId).toBeNull()

    emitIndexComplete(4, 1)
    await nextTick()
    await vi.waitFor(() => expect(rowStore.totalFiltered).toBe(4))

    // Rows arrive (first window): the first row becomes active.
    rowStore.ensureWindow(0, 0)
    await vi.waitFor(() => expect(postedOps('getRows').length).toBe(1))
    answerLast('getRows', { rows: [makeRow(0, 1, 'first')], generation: 1, totalFiltered: 4 })
    await vi.waitFor(() => {
      expect(selectionStore.activeLineId).toBe(1)
    })
    expect(selectionStore.activeDisplayIndex).toBe(0)
  })

  it('keeps the active row when it still matches after a filter change', async () => {
    await initSource()
    emitIndexComplete(4, 1)
    await nextTick()

    // Make line 3 active (display index 2).
    selectionStore.activate(3, 2)

    // A filter completes: only line 3 survives.
    const { useFilterStore } = await import('~/stores/filter')
    const filterStore = useFilterStore()
    filterStore.result = { matchedRows: 1, totalRows: 4, generation: 2 }
    await nextTick()
    await vi.waitFor(() => expect(rowStore.generation).toBe(2))

    // The store asks the worker where the active row is now.
    await vi.waitFor(() => expect(postedOps('linePosition').length).toBe(1))
    const op = postedOps('linePosition')[0]!
    expect(op.lineId).toBe(3)
    answerLast('linePosition', { lineId: 3, visible: true, displayIndex: 0, generation: 2 })

    // Kept — same stable id, new display index.
    await vi.waitFor(() => expect(selectionStore.activeDisplayIndex).toBe(0))
    expect(selectionStore.activeLineId).toBe(3)
  })

  it('replaces the active row with the first result when filtered out', async () => {
    await initSource()
    emitIndexComplete(4, 1)
    await nextTick()
    selectionStore.activate(1, 0)

    const { useFilterStore } = await import('~/stores/filter')
    const filterStore = useFilterStore()
    filterStore.result = { matchedRows: 1, totalRows: 4, generation: 2 }
    await nextTick()
    await vi.waitFor(() => expect(rowStore.generation).toBe(2))

    await vi.waitFor(() => expect(postedOps('linePosition').length).toBe(1))
    answerLast('linePosition', { lineId: 1, visible: false, displayIndex: null, generation: 2 })

    // Replaced: cleared, then the first result activates when cached.
    await vi.waitFor(() => expect(selectionStore.activeLineId).toBeNull())
    expect(selectionStore.activeDisplayIndex).toBe(0)
    rowStore.ensureWindow(0, 0)
    await vi.waitFor(() => expect(postedOps('getRows').length).toBe(1))
    answerLast('getRows', { rows: [makeRow(0, 3, 'only')], generation: 2, totalFiltered: 1 })
    await vi.waitFor(() => {
      expect(selectionStore.activeLineId).toBe(3)
    })
    expect(selectionStore.activeDisplayIndex).toBe(0)
  })

  it('clears the selection for a zero-result filter', async () => {
    await initSource()
    emitIndexComplete(4, 1)
    await nextTick()
    selectionStore.activate(2, 1)

    const { useFilterStore } = await import('~/stores/filter')
    const filterStore = useFilterStore()
    filterStore.result = { matchedRows: 0, totalRows: 4, generation: 2 }
    await nextTick()
    await vi.waitFor(() => expect(rowStore.generation).toBe(2))

    await vi.waitFor(() => expect(postedOps('linePosition').length).toBe(1))
    answerLast('linePosition', { lineId: 2, visible: false, displayIndex: null, generation: 2 })
    await vi.waitFor(() => expect(selectionStore.activeLineId).toBeNull())
    expect(selectionStore.activeDisplayIndex).toBeNull()
  })

  it('ignores a stale linePosition answer (a newer view superseded it)', async () => {
    await initSource()
    emitIndexComplete(4, 1)
    await nextTick()
    selectionStore.activate(2, 1)

    const { useFilterStore } = await import('~/stores/filter')
    const filterStore = useFilterStore()
    filterStore.result = { matchedRows: 1, totalRows: 4, generation: 2 }
    await nextTick()
    await vi.waitFor(() => expect(rowStore.generation).toBe(2))
    await vi.waitFor(() => expect(postedOps('linePosition').length).toBe(1))

    // A SECOND view change lands before the first answer (generation 3).
    filterStore.result = { matchedRows: 2, totalRows: 4, generation: 3 }
    await nextTick()
    await vi.waitFor(() => expect(rowStore.generation).toBe(3))
    await vi.waitFor(() => expect(postedOps('linePosition').length).toBe(2))

    // The STALE answer (generation 2, not visible) must NOT clear the row.
    const stale = postedOps('linePosition')[0]!
    worker.emit(success(stale.requestId!, { lineId: 2, visible: false, displayIndex: null, generation: 2 }))
    await nextTick()
    expect(selectionStore.activeLineId).toBe(2)

    // The fresh answer (generation 3, visible) applies.
    const fresh = postedOps('linePosition')[1]!
    expect(fresh.lineId).toBe(2)
    answerLast('linePosition', { lineId: 2, visible: true, displayIndex: 1, generation: 3 })
    await vi.waitFor(() => expect(selectionStore.activeDisplayIndex).toBe(1))
    expect(selectionStore.activeLineId).toBe(2)
  })

  it('clears everything on source replacement (resetDerivedState contract)', async () => {
    selectionStore.activate(9, 4)
    selectionStore.add(9)

    // What fileStore.resetDerivedState() does on a new source / fatal.
    selectionStore.resetSelection()
    const { useFilterStore } = await import('~/stores/filter')
    useFilterStore().resetFilterState()
    rowStore.reset()

    expect(selectionStore.activeLineId).toBeNull()
    expect(selectionStore.activeDisplayIndex).toBeNull()
    expect(selectionStore.count).toBe(0)
    expect(rowStore.generation).toBe(0)
    expect(rowStore.totalFiltered).toBe(0)
  })

  it('counts always agree with the worker snapshots (no local arithmetic)', async () => {
    await initSource()
    emitIndexComplete(12, 1)
    await nextTick()
    await vi.waitFor(() => expect(rowStore.totalFiltered).toBe(12))

    const { useFilterStore } = await import('~/stores/filter')
    const filterStore = useFilterStore()
    filterStore.result = { matchedRows: 5, totalRows: 12, generation: 2 }
    await vi.waitFor(() => expect(rowStore.totalFiltered).toBe(5))
  })
})
