/**
 * Virtualized row list (TSK0022): bounded DOM, placeholders for pending
 * windows, stable-lineId selection (no drift across filter generations),
 * clean zero-row state, and overscan windows handed to the row store.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { nextTick } from 'vue'
import RowList from '~/components/explorer/RowList.vue'
import { useJsonlEngine, resetJsonlEngineForTests } from '~/composables/useJsonlEngine'
import { useFilterStore } from '~/stores/filter'
import { useSelectionStore } from '~/stores/selection'
import type { RowData } from '@jsonl-explorer/shared'
import { FakeWorker, success, failure } from '../helpers/fakeWorker'

const ROW_HEIGHT = 28
/** 10 rows visible (280 / 28) + overscan on each side. */
const VIRTUAL_RECT = { height: 280, width: 384 }

interface PostedOp {
  type: string
  requestId?: string
  start?: number
  count?: number
  generation?: number
}

function makeRow(displayIndex: number, lineId: number, text: string): RowData {
  return { lineId, displayIndex, text, isEdited: false, byteLength: text.length }
}

describe('RowList (TSK0022)', () => {
  let pinia: Pinia
  let worker: FakeWorker
  let filterStore: ReturnType<typeof useFilterStore>
  let selectionStore: ReturnType<typeof useSelectionStore>
  let wrapper: VueWrapper<InstanceType<typeof RowList>>

  const getRowsOps = (): PostedOp[] =>
    worker.posted.filter((m) => (m as PostedOp).type === 'getRows') as PostedOp[]

  /** Answer the most recent getRows (each test pairs a call with a
   *  waitFor on the expected op count; FakeWorker.posted holds requests
   *  only, so the newest op is the outstanding one). */
  function answerLast(rows: RowData[], generation: number, totalFiltered: number): void {
    const ops = getRowsOps()
    expect(ops.length, 'a getRows RPC must exist').toBeGreaterThan(0)
    const op = ops[ops.length - 1]!
    worker.emit(success(op.requestId!, { rows, generation, totalFiltered }))
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

  /** Simulate an index commit (the event that gives the list its count). */
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
    filterStore = useFilterStore()
    selectionStore = useSelectionStore()
    wrapper = mount(RowList, {
      props: { rowHeight: ROW_HEIGHT, initialRect: VIRTUAL_RECT },
      global: { plugins: [pinia] },
    })
  })

  it('shows a clean empty state with zero rows', async () => {
    await initSource()
    await nextTick()
    expect(wrapper.find('[data-testid="row-list-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="row-list-scroll"]').exists()).toBe(false)
  })

  it('renders cached rows with source line numbers and previews', async () => {
    await initSource()
    emitIndexComplete(5, 1)
    await nextTick()
    // The scroller mounted -> the virtualizer requested its window.
    await vi.waitFor(() => expect(getRowsOps().length).toBe(1))
    answerLast(
      [
        makeRow(0, 1, '{"a":1}'),
        makeRow(1, 2, '{"b":2}'),
        makeRow(2, 3, '{"c":3}'),
        makeRow(3, 4, '{"d":4}'),
        makeRow(4, 5, '{"e":5}'),
      ],
      1,
      5,
    )
    // Wait for the response: placeholders flip to content.
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-testid="row-placeholder"]').length).toBe(0)
    })

    const items = wrapper.findAll('[data-testid="row-item"]')
    expect(items.length).toBe(5)
    expect(items[0]!.text()).toContain('1')
    expect(items[0]!.text()).toContain('{"a":1}')
    expect(items[4]!.text()).toContain('5')
    // The spacer is the full virtual height: count x fixed row height.
    const spacer = wrapper.find('[data-testid="row-list-scroll"] > div')
    expect(spacer.attributes('style')).toContain(`height: ${5 * ROW_HEIGHT}px`)
  })

  it('shows placeholders while a window is in flight', async () => {
    await initSource()
    emitIndexComplete(3, 1)
    await nextTick()
    await vi.waitFor(() => expect(getRowsOps().length).toBe(1))

    // Before the response: items exist but are placeholders.
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-testid="row-item"]').length).toBe(3)
    })
    expect(wrapper.findAll('[data-testid="row-placeholder"]').length).toBe(3)

    // After: placeholders are replaced by real previews.
    answerLast(
      [makeRow(0, 1, 'x'), makeRow(1, 2, 'y'), makeRow(2, 3, 'z')],
      1,
      3,
    )
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-testid="row-placeholder"]').length).toBe(0)
    })
    expect(wrapper.find('[data-testid="row-item"]').text()).toContain('x')
  })

  it('hands a single coalesced overscan window to the row store', async () => {
    await initSource()
    emitIndexComplete(1000, 1)
    await nextTick()
    await vi.waitFor(() => expect(getRowsOps().length).toBe(1))

    const op = getRowsOps()[0]!
    expect(op.start).toBe(0)
    // 10 visible rows + overscan on both sides: one batched RPC.
    expect(op.count!).toBeGreaterThan(10)
    expect(op.count!).toBeLessThanOrEqual(10 + 16)
    expect(op.generation).toBe(1)
  })

  it('keeps DOM nodes bounded for a 100k-row file', async () => {
    await initSource()
    emitIndexComplete(100_000, 1)
    await nextTick()
    await vi.waitFor(() => expect(getRowsOps().length).toBe(1))

    const rendered = wrapper.findAll('[data-testid="row-item"]').length
    expect(rendered).toBeGreaterThan(0)
    // ~10 visible + 16 overscan — nowhere near 100k DOM nodes.
    expect(rendered).toBeLessThanOrEqual(40)
    // One RPC for the initial window (coalesced, bounded messages).
    expect(getRowsOps().length).toBe(1)
    // The virtual spacer covers the whole file.
    const spacer = wrapper.find('[data-testid="row-list-scroll"] > div')
    expect(spacer.attributes('style')).toContain(`height: ${100_000 * ROW_HEIGHT}px`)
  })

  it('highlights by stable lineId and the highlight survives a filter change', async () => {
    await initSource()
    emitIndexComplete(4, 1)
    await nextTick()
    await vi.waitFor(() => expect(getRowsOps().length).toBe(1))
    answerLast(
      [
        makeRow(0, 1, 'r1'),
        makeRow(1, 2, 'r2'),
        makeRow(2, 3, 'r3'),
        makeRow(3, 4, 'r4'),
      ],
      1,
      4,
    )
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-testid="row-placeholder"]').length).toBe(0)
    })

    // Activate the row with lineId 3 (display index 2).
    const item3 = wrapper
      .findAll('[data-testid="row-item"]')
      .find((w) => w.text().includes('r3'))!
    await item3.trigger('click')
    expect(selectionStore.activeLineId).toBe(3)
    expect(item3.classes()).toContain('bg-primary/10')

    // A filter completes: the view shrinks to lineId 3 only, now at
    // display index 0. The SELECTION (stable lineId 3) must follow it —
    // no drift to "display index 2" (which no longer exists).
    filterStore.result = { matchedRows: 1, totalRows: 4, generation: 2 }
    await nextTick()
    await vi.waitFor(() => expect(getRowsOps().length).toBe(2))
    answerLast([makeRow(0, 3, 'r3')], 2, 1)
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-testid="row-item"]').length).toBe(1)
    })

    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-testid="row-placeholder"]').length).toBe(0)
    })
    const only = wrapper.find('[data-testid="row-item"]')
    expect(only.text()).toContain('r3')
    expect(only.classes()).toContain('bg-primary/10')
    expect(selectionStore.activeLineId).toBe(3)
  })

  it('renders blank and control-heavy previews safely (single line, escaped)', async () => {
    await initSource()
    emitIndexComplete(2, 1)
    await nextTick()
    await vi.waitFor(() => expect(getRowsOps().length).toBe(1))
    // The worker contract: C0/DEL arrive PRE-ESCAPED (\u00XX sequences),
    // so the list can render them as plain text, always one line.
    answerLast([makeRow(0, 1, ''), makeRow(1, 2, 'a\\u0000b\\u0009c')], 1, 2)
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-testid="row-placeholder"]').length).toBe(0)
    })
    const items = wrapper.findAll('[data-testid="row-item"]')
    expect(items.length).toBe(2)
    // Blank row: renders (empty preview), no crash.
    expect(items[0]!.find('[data-line-id="1"]').exists()).toBe(true)
    // The escaped form is shown as-is; no raw control character leaks in.
    expect(items[1]!.text()).toContain('a\\u0000b\\u0009c')
    expect(items[1]!.text()).not.toContain('\u0000')
    expect(items[1]!.text()).not.toContain('\t')
  })

  it('surfaces a window fetch failure with a message and a working retry', async () => {
    await initSource()
    emitIndexComplete(4, 1)
    await nextTick()
    await vi.waitFor(() => expect(getRowsOps().length).toBe(1))

    // The window RPC fails (typed worker error).
    worker.emit(failure(getRowsOps()[0]!.requestId!, 'internal', 'Disk read failed'))
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="row-list-error"]').exists()).toBe(true)
    })
    const bar = wrapper.find('[data-testid="row-list-error"]')
    expect(bar.attributes('role')).toBe('alert')
    expect(bar.text()).toContain('Disk read failed')

    // Retry posts a NEW window RPC and clears the bar on success.
    wrapper.find('[data-testid="row-list-retry"]').trigger('click')
    await vi.waitFor(() => expect(getRowsOps().length).toBe(2))
    answerLast(
      [
        makeRow(0, 1, 'a'),
        makeRow(1, 2, 'b'),
        makeRow(2, 3, 'c'),
        makeRow(3, 4, 'd'),
      ],
      1,
      4,
    )
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="row-list-error"]').exists()).toBe(false)
    })
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-testid="row-placeholder"]').length).toBe(0)
    })
  })
})
