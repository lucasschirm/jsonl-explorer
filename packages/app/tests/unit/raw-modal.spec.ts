/**
 * RawModal (TSK0025): virtualized raw view of the current FILTERED
 * dataset. Bounded DOM/memory (no concatenation), same window/cache and
 * preview semantics as the list, per-row full-text copy with surfaced
 * errors, accessible modal (focus/Escape via Modal contract).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { mount, type VueWrapper } from '@vue/test-utils'
import { useJsonlEngine, resetJsonlEngineForTests } from '~/composables/useJsonlEngine'
import { useRowStore } from '~/stores/rows'
import { useSelectionStore } from '~/stores/selection'
import { useToastStore } from '~/stores/toasts'
import RawModal from '~/components/explorer/RawModal.vue'
import { FakeWorker, success } from '../helpers/fakeWorker'

interface PostedOp {
  type: string
  requestId?: string
  lineId?: number
  start?: number
  count?: number
}

function makeRow(displayIndex: number, lineId: number, text: string) {
  return { lineId, displayIndex, text, isEdited: false, byteLength: text.length }
}

describe('RawModal (TSK0025)', () => {
  let pinia: Pinia
  let worker: FakeWorker
  let wrapper: VueWrapper<InstanceType<typeof RawModal>>
  let clipboardMock: { writeText: ReturnType<typeof vi.fn> }

  const getRowsOps = (): PostedOp[] =>
    worker.posted.filter((m) => (m as PostedOp).type === 'getRows') as PostedOp[]

  const getLineOps = (): PostedOp[] =>
    worker.posted.filter((m) => (m as PostedOp).type === 'getLine') as PostedOp[]

  function answerLast(rows: ReturnType<typeof makeRow>[], generation = 1, totalFiltered = rows.length): void {
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

  function emitIndexComplete(totalRows: number): void {
    worker.emit({
      ns: 'jsonl-explorer',
      v: 1,
      type: 'indexComplete',
      operationId: 'op-index',
      totalRows,
      totalBytes: totalRows * 10,
      durationMs: 1,
      generation: 1,
    })
  }

  const body = (selector: string): Element | null => document.body.querySelector(selector)

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    resetJsonlEngineForTests()
    worker = new FakeWorker()
    useJsonlEngine({ workerFactory: () => worker as unknown as Worker })
    useSelectionStore()
    clipboardMock = { writeText: vi.fn().mockResolvedValue(undefined) }
    Object.defineProperty(navigator, 'clipboard', { value: clipboardMock, configurable: true })
    wrapper = mount(RawModal, {
      props: { modelValue: false, initialRect: { height: 280, width: 800 } },
      global: { plugins: [pinia] },
    })
  })

  afterEach(() => {
    wrapper.unmount()
    delete (navigator as { clipboard?: unknown }).clipboard
    document.body.innerHTML = ''
  })

  it('stays bounded on a large fixture: one small window, viewport-only DOM', async () => {
    await initSource()
    emitIndexComplete(100_000)
    await vi.waitFor(() => expect(useRowStore().totalFiltered).toBe(100_000))

    wrapper.setProps({ modelValue: true })
    await vi.waitFor(() => expect(getRowsOps().length).toBe(1))

    // The request is a SMALL window at the top — never the whole dataset.
    const op = getRowsOps()[0]!
    expect(op.start).toBe(0)
    expect(op.count).toBeLessThan(60)

    // Answer just that window (the rows the modal actually asked for).
    const rows = Array.from({ length: (op.count ?? 0) }, (_, i) =>
      makeRow(i, i, `{"i":${i}}`),
    )
    answerLast(rows, 1, 100_000)
    await vi.waitFor(() => {
      expect(document.body.querySelectorAll('[data-testid="raw-item"]').length).toBeGreaterThan(0)
    })

    // 100k rows exist logically, but the DOM holds only the viewport.
    const domRows = document.body.querySelectorAll('[data-testid="raw-item"]').length
    expect(domRows).toBeLessThan(60)
    expect(body('[data-testid="raw-footer"]')!.textContent).toContain('100000 rows')
  })

  it('shows placeholders while the window is in flight, then the rows', async () => {
    await initSource()
    emitIndexComplete(50)
    await vi.waitFor(() => expect(useRowStore().totalFiltered).toBe(50))

    wrapper.setProps({ modelValue: true })
    await vi.waitFor(() => expect(getRowsOps().length).toBe(1))
    // In flight: bounded placeholders, no content yet.
    expect(document.body.querySelectorAll('[data-testid="raw-placeholder"]').length).toBeGreaterThan(0)

    const op = getRowsOps()[0]!
    const rows = Array.from({ length: (op.count ?? 0) }, (_, i) =>
      makeRow(i, i, `line ${i}`),
    )
    answerLast(rows, 1, 50)
    await vi.waitFor(() =>
      expect(document.body.querySelectorAll('[data-testid="raw-placeholder"]').length).toBe(0),
    )
    const gutter = document.body.querySelector('[data-testid="raw-item"]')!
    expect(gutter.textContent).toContain('0') // lineId gutter
    expect(gutter.textContent).toContain('line 0')
  })

  it('follows the FILTERED view (display index -> lineId mapping)', async () => {
    await initSource()
    emitIndexComplete(1000) // 1000 source rows...
    await vi.waitFor(() => expect(useRowStore().totalFiltered).toBe(1000))

    wrapper.setProps({ modelValue: true })
    await vi.waitFor(() => expect(getRowsOps().length).toBe(1))
    const op = getRowsOps()[0]!
    // ...but a filter kept only the even lineIds: the worker answers with
    // displayIndex i -> lineId 2i (and the filtered total).
    const filtered = 500
    const rows = Array.from({ length: (op.count ?? 0) }, (_, i) =>
      makeRow(i, 2 * i, `kept ${i}`),
    )
    answerLast(rows, 1, filtered)
    await vi.waitFor(() =>
      expect(document.body.querySelectorAll('[data-testid="raw-placeholder"]').length).toBe(0),
    )

    // The gutters show the SOURCE lineIds of the filtered rows (0, 2, 4…).
    const gutters = Array.from(document.body.querySelectorAll('[data-testid="raw-item"]'))
      .slice(0, 4)
      .map((el) => el.textContent!.match(/\d+/)![0])
    expect(gutters).toEqual(['0', '2', '4', '6'])
    expect(body('[data-testid="raw-footer"]')!.textContent).toContain('500 rows')
  })

  it('copies a row FULL text via getLine (not the capped preview)', async () => {
    await initSource()
    emitIndexComplete(10)
    await vi.waitFor(() => expect(useRowStore().totalFiltered).toBe(10))
    wrapper.setProps({ modelValue: true })
    await vi.waitFor(() => expect(getRowsOps().length).toBe(1))
    const op = getRowsOps()[0]!
    // Preview is capped; full text is much longer.
    const rows = Array.from({ length: (op.count ?? 0) }, (_, i) =>
      makeRow(i, i, `preview-${i}`),
    )
    answerLast(rows, 1, 10)
    await vi.waitFor(() =>
      expect(document.body.querySelector('[data-testid="raw-copy-btn"]')).not.toBeNull(),
    )

    const firstCopy = document.body.querySelector('[data-testid="raw-copy-btn"]') as HTMLButtonElement
    firstCopy.click()
    await vi.waitFor(() => expect(getLineOps().length).toBe(1))
    const fullText = '{"full":true,"text":"' + 'y'.repeat(200) + '"}'
    worker.emit(success(getLineOps()[0]!.requestId!, { lineId: 0, text: fullText, isEdited: false }))

    await vi.waitFor(() => expect(clipboardMock.writeText).toHaveBeenCalledWith(fullText))
    const toastStore = useToastStore()
    await vi.waitFor(() =>
      expect(toastStore.toasts.some((t) => t.title === 'Copied')).toBe(true),
    )
  })

  it('surfaces copy failures (no silent copy)', async () => {
    await initSource()
    emitIndexComplete(10)
    await vi.waitFor(() => expect(useRowStore().totalFiltered).toBe(10))
    wrapper.setProps({ modelValue: true })
    await vi.waitFor(() => expect(getRowsOps().length).toBe(1))
    const op = getRowsOps()[0]!
    const rows = Array.from({ length: (op.count ?? 0) }, (_, i) =>
      makeRow(i, i, `row ${i}`),
    )
    answerLast(rows, 1, 10)
    await vi.waitFor(() =>
      expect(document.body.querySelector('[data-testid="raw-copy-btn"]')).not.toBeNull(),
    )

    clipboardMock.writeText.mockRejectedValueOnce(new Error('Clipboard access denied'))
    const firstCopy = document.body.querySelector('[data-testid="raw-copy-btn"]') as HTMLButtonElement
    firstCopy.click()
    await vi.waitFor(() => expect(getLineOps().length).toBe(1))
    worker.emit(success(getLineOps()[0]!.requestId!, { lineId: 0, text: 'x', isEdited: false }))

    const toastStore = useToastStore()
    await vi.waitFor(() =>
      expect(toastStore.toasts.some((t) => t.title === 'Copy failed')).toBe(true),
    )
    expect(clipboardMock.writeText).toHaveBeenCalled()
  })

  it('shows an empty state (no scroller) when the view has no rows', async () => {
    await initSource()
    wrapper.setProps({ modelValue: true })
    await vi.waitFor(() => expect(body('[data-testid="raw-empty"]')).not.toBeNull())
    expect(body('[data-testid="raw-scroll"]')).toBeNull()
    expect(getRowsOps().length).toBe(0)
  })

  it('is an accessible dialog and unmounts on close', async () => {
    await initSource()
    emitIndexComplete(5)
    await vi.waitFor(() => expect(useRowStore().totalFiltered).toBe(5))

    wrapper.setProps({ modelValue: true })
    await vi.waitFor(() => expect(body('[role="dialog"]')).not.toBeNull())
    expect(body('[role="dialog"]')!.getAttribute('aria-modal')).toBe('true')

    wrapper.setProps({ modelValue: false })
    await vi.waitFor(() => expect(body('[role="dialog"]')).toBeNull())
    expect(body('[data-testid="raw-modal-body"]')).toBeNull()
  })
})
