/**
 * Row-window store (TSK0021): coalesced window fetching, generation +
 * lineId keyed caching under a byte budget, stale-response protection,
 * and invalidation on filter-generation / index-commit / reset.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { useJsonlEngine, resetJsonlEngineForTests } from '~/composables/useJsonlEngine'
import { useFilterStore } from '~/stores/filter'
import {
  useRowStore,
  setRowCacheLimitsForTests,
  resetRowCacheLimitsForTests,
} from '~/stores/rows'
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

function makeRow(displayIndex: number, text: string, lineId?: number): RowData {
  return {
    lineId: lineId ?? displayIndex + 1,
    displayIndex,
    text,
    isEdited: false,
    byteLength: text.length,
  }
}

/** Rows for a getRows span (lineId = displayIndex + 1, like the worker). */
function spanRows(start: number, count: number, text = 'x'): RowData[] {
  const rows: RowData[] = []
  for (let i = 0; i < count; i++) rows.push(makeRow(start + i, text))
  return rows
}

function settle(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0))
}

describe('row window store (TSK0021)', () => {
  let pinia: Pinia
  let worker: FakeWorker
  let rowStore: ReturnType<typeof useRowStore>
  let filterStore: ReturnType<typeof useFilterStore>

  const getRowsOps = (): PostedOp[] =>
    worker.posted.filter((m) => (m as PostedOp).type === 'getRows') as PostedOp[]

  /** Initialize a (fake) source so the engine exists for row RPCs. */
  async function initSource(): Promise<void> {
    const pending = useJsonlEngine().open('file', new File(['a\n'], 't.jsonl'))
    await vi.waitFor(() => {
      expect(worker.posted.some((m) => (m as PostedOp).type === 'initFile')).toBe(true)
    })
    const op = worker.posted.find((m) => (m as PostedOp).type === 'initFile') as PostedOp
    worker.emit(success(op.requestId!, { name: 't.jsonl', size: 2, type: 'file' }))
    await pending
  }

  /** Wait until exactly `n` getRows RPCs have been posted. */
  async function waitGetRows(n: number): Promise<void> {
    await vi.waitFor(() => expect(getRowsOps().length).toBe(n))
  }

  const answeredIds = new Set<string>()

  /** Answer every getRows whose requestId has not been answered yet. */
  async function answerWindows(generation: number, totalFiltered?: number): Promise<void> {
    for (const op of getRowsOps()) {
      if (op.requestId === undefined || answeredIds.has(op.requestId)) continue
      answeredIds.add(op.requestId)
      worker.emit(
        success(op.requestId, {
          rows: spanRows(op.start!, op.count!),
          generation,
          totalFiltered: totalFiltered ?? op.start! + op.count!,
        }),
      )
    }
  }

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    resetJsonlEngineForTests()
    resetRowCacheLimitsForTests()
    worker = new FakeWorker()
    useJsonlEngine({ workerFactory: () => worker as unknown as Worker })
    rowStore = useRowStore()
    filterStore = useFilterStore()
  })

  afterEach(() => {
    resetRowCacheLimitsForTests()
  })

  it('fetches a window once and serves it from the cache', async () => {
    await initSource()
    rowStore.ensureWindow(0, 4)
    await waitGetRows(1)

    const op = getRowsOps()[0]!
    expect(op.start).toBe(0)
    expect(op.count).toBe(5)
    expect(op.generation).toBe(0)

    await answerWindows(0)
    await settle()

    expect(rowStore.totalFiltered).toBe(5)
    expect(rowStore.rowForDisplay(0)?.lineId).toBe(1)
    expect(rowStore.rowForDisplay(4)?.lineId).toBe(5)
    expect(rowStore.rowCount).toBe(5)

    // A second request for the same window posts NO new RPC (cache hit).
    rowStore.ensureWindow(0, 4)
    await settle()
    expect(getRowsOps().length).toBe(1)
  })

  it('coalesces an in-flight overscan into one follow-up span (no duplicates)', async () => {
    await initSource()
    rowStore.ensureWindow(0, 4)
    await waitGetRows(1)
    // The virtualizer expands while the first RPC is still in flight: the
    // same loop picks it up — one span at a time, never parallel windows.
    rowStore.ensureWindow(3, 9)
    await settle()
    await answerWindows(0, 10)
    await settle()
    // The follow-up span (5..9) was posted as the loop continued: answer it.
    await answerWindows(0, 10)
    await settle()

    const ops = getRowsOps()
    expect(ops.length).toBe(2)
    expect(ops[0]).toMatchObject({ start: 0, count: 5 })
    expect(ops[1]).toMatchObject({ start: 5, count: 5 })
    expect(rowStore.rowForDisplay(9)?.lineId).toBe(10)
  })

  it('never applies a stale (older-generation) response and re-fetches on demand', async () => {
    await initSource()
    rowStore.ensureWindow(0, 9)
    await waitGetRows(1)

    // A filter completes while the window is in flight: generation bumps.
    filterStore.result = { matchedRows: 2, totalRows: 10, generation: 3 }
    await settle()

    // An OLD response (gen 0, from before the filter) arrives late: it
    // must NOT be applied and must not downgrade the generation.
    const stale = getRowsOps()[0]!
    worker.emit(
      success(stale.requestId!, {
        rows: spanRows(0, 10),
        generation: 0,
        totalFiltered: 10,
      }),
    )
    await settle()
    expect(rowStore.generation).toBe(3)
    expect(rowStore.rowCount).toBe(0)

    // The next demand (virtualizer re-request after the view bump) fetches
    // for the CURRENT generation — and those rows are applied.
    rowStore.ensureWindow(0, 1)
    await waitGetRows(2)
    const fresh = getRowsOps()[1]!
    expect(fresh.generation).toBe(3)
    worker.emit(
      success(fresh.requestId!, {
        rows: [makeRow(0, 'kept-a', 4), makeRow(1, 'kept-b', 9)],
        generation: 3,
        totalFiltered: 2,
      }),
    )
    await settle()
    expect(rowStore.rowCount).toBe(2)
    expect(rowStore.rowForDisplay(0)?.lineId).toBe(4)
    expect(rowStore.rowForDisplay(1)?.lineId).toBe(9)
  })

  it('adopts a newer generation from the response and applies its rows', async () => {
    await initSource()
    rowStore.ensureWindow(0, 2)
    await waitGetRows(1)
    // The worker moved on (index commit) between request and response.
    const op = getRowsOps()[0]!
    worker.emit(
      success(op.requestId!, {
        rows: spanRows(0, 3),
        generation: 1,
        totalFiltered: 3,
      }),
    )
    await settle()

    expect(rowStore.generation).toBe(1)
    // The response describes the NEW generation — its rows may be applied.
    expect(rowStore.rowCount).toBe(3)
    // No spin: exactly one RPC (the re-check finds nothing missing).
    expect(getRowsOps().length).toBe(1)
  })

  it('clamps the window to totalFiltered (no empty-fetch spin)', async () => {
    await initSource()
    rowStore.ensureWindow(0, 49)
    await waitGetRows(1)
    // The filtered view has only 3 rows.
    const op = getRowsOps()[0]!
    worker.emit(
      success(op.requestId!, {
        rows: spanRows(0, 3),
        generation: 0,
        totalFiltered: 3,
      }),
    )
    await settle()
    expect(rowStore.rowCount).toBe(3)
    expect(getRowsOps().length).toBe(1)
  })

  it('evicts oldest off-window rows under a small entry budget', async () => {
    setRowCacheLimitsForTests(10 * 1024, 6)
    await initSource()
    rowStore.ensureWindow(0, 3)
    await waitGetRows(1)
    await answerWindows(0)
    await settle()
    expect(rowStore.rowCount).toBe(4)

    // The virtualizer scrolls away: a window outside the cached one.
    rowStore.ensureWindow(4, 7)
    await waitGetRows(2)
    await answerWindows(0, 8)
    await settle()
    // 8 rows cached but only 6 fit: the oldest OFF-window rows (0..1) go,
    // the on-screen window (4..7) is always kept.
    expect(rowStore.rowCount).toBe(6)
    expect(rowStore.rowForDisplay(0)).toBeNull()
    expect(rowStore.rowForDisplay(1)).toBeNull()
    expect(rowStore.rowForDisplay(4)?.lineId).toBe(5)
    expect(rowStore.rowForDisplay(7)?.lineId).toBe(8)
  })

  it('clears the cache when the filter generation changes', async () => {
    await initSource()
    rowStore.ensureWindow(0, 2)
    await waitGetRows(1)
    await answerWindows(0)
    await settle()
    expect(rowStore.rowCount).toBe(3)

    filterStore.result = { matchedRows: 1, totalRows: 10, generation: 2 }
    await settle()
    expect(rowStore.generation).toBe(2)
    expect(rowStore.rowCount).toBe(0)
    expect(rowStore.rowForDisplay(0)).toBeNull()
    // The view count follows the filter result (event-driven), so the
    // list re-derives its window instead of getting stuck at 0.
    expect(rowStore.totalFiltered).toBe(1)
  })

  it('invalidates on an index-commit event (new rows exist)', async () => {
    await initSource()
    rowStore.ensureWindow(0, 1)
    await waitGetRows(1)
    await answerWindows(0)
    await settle()
    expect(rowStore.generation).toBe(0)

    worker.emit({
      ns: 'jsonl-explorer',
      v: 1,
      type: 'indexComplete',
      operationId: 'op-1',
      totalRows: 99,
      totalBytes: 990,
      durationMs: 1,
      generation: 7,
    })
    await settle()
    expect(rowStore.generation).toBe(7)
    expect(rowStore.rowCount).toBe(0)
    // The committed row count comes from the event, not from a fetch.
    expect(rowStore.totalFiltered).toBe(99)
  })

  it('reset() clears everything (new source)', async () => {
    await initSource()
    rowStore.ensureWindow(0, 1)
    await waitGetRows(1)
    await answerWindows(0)
    await settle()

    rowStore.reset()
    expect(rowStore.generation).toBe(0)
    expect(rowStore.rowCount).toBe(0)
    expect(rowStore.totalFiltered).toBe(0)
    expect(rowStore.loadError).toBeNull()
  })

  it('getFullText fetches the full row via getLine', async () => {
    await initSource()
    rowStore.ensureWindow(0, 0)
    await waitGetRows(1)
    const op = getRowsOps()[0]!
    worker.emit(
      success(op.requestId!, { rows: [makeRow(0, 'p', 42)], generation: 0, totalFiltered: 1 }),
    )
    await settle()

    const pending = rowStore.getFullText(42)
    await vi.waitFor(() => {
      expect(worker.posted.some((m) => (m as PostedOp).type === 'getLine')).toBe(true)
    })
    const getLine = worker.posted.find((m) => (m as PostedOp).type === 'getLine') as PostedOp
    expect(getLine.lineId).toBe(42)
    worker.emit(success(getLine.requestId!, { lineId: 42, text: 'FULL TEXT', isEdited: false }))
    await expect(pending).resolves.toEqual({ lineId: 42, text: 'FULL TEXT', isEdited: false })
  })
})
