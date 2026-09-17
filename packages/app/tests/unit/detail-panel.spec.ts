/**
 * DetailPanel (TSK0024): idle/loading/error states, the tree for valid
 * JSON, raw fallback + banner for invalid JSON, the large-row confirm
 * gate (no auto-parse above the threshold), and Format/Compact as
 * presentation-only controls (no setEdit ever).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { mount, type VueWrapper } from '@vue/test-utils'
import { useJsonlEngine, resetJsonlEngineForTests } from '~/composables/useJsonlEngine'
import { useSelectionStore } from '~/stores/selection'
import { useDetailStore } from '~/stores/detail'
import { useToastStore } from '~/stores/toasts'
import DetailPanel from '~/components/explorer/DetailPanel.vue'
import { FakeWorker, success, failure } from '../helpers/fakeWorker'

interface PostedOp {
  type: string
  requestId?: string
  lineId?: number
}

const LARGE_TEXT = JSON.stringify({ data: 'x'.repeat(1200 * 1024) }) // > 1 MiB

describe('DetailPanel (TSK0024)', () => {
  let pinia: Pinia
  let worker: FakeWorker
  let wrapper: VueWrapper<InstanceType<typeof DetailPanel>>
  let selectionStore: ReturnType<typeof useSelectionStore>
  let detailStore: ReturnType<typeof useDetailStore>
  let clipboardMock: { writeText: ReturnType<typeof vi.fn> }

  const getLineOps = (): PostedOp[] =>
    worker.posted.filter((m) => (m as PostedOp).type === 'getLine') as PostedOp[]

  async function initSource(): Promise<void> {
    const pending = useJsonlEngine().open('file', new File(['a\n'], 't.jsonl'))
    await vi.waitFor(() => {
      expect(worker.posted.some((m) => (m as PostedOp).type === 'initFile')).toBe(true)
    })
    const op = worker.posted.find((m) => (m as PostedOp).type === 'initFile') as PostedOp
    worker.emit(success(op.requestId!, { name: 't.jsonl', size: 2, type: 'file' }))
    await pending
  }

  async function selectAndAnswer(text: string): Promise<void> {
    selectionStore.activate(1, 0)
    await vi.waitFor(() => expect(getLineOps().length).toBe(1))
    worker.emit(success(getLineOps()[0]!.requestId!, { lineId: 1, text, isEdited: false }))
    await vi.waitFor(() => expect(useDetailStore().status).toBe('ready'))
  }

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    resetJsonlEngineForTests()
    worker = new FakeWorker()
    useJsonlEngine({ workerFactory: () => worker as unknown as Worker })
    selectionStore = useSelectionStore()
    detailStore = useDetailStore()
    clipboardMock = { writeText: vi.fn().mockResolvedValue(undefined) }
    Object.defineProperty(navigator, 'clipboard', { value: clipboardMock, configurable: true })
    wrapper = mount(DetailPanel, { global: { plugins: [pinia] } })
  })

  afterEach(() => {
    wrapper.unmount()
    delete (navigator as { clipboard?: unknown }).clipboard
    document.body.innerHTML = ''
  })

  it('shows the placeholder before a row is selected', () => {
    expect(wrapper.find('[data-testid="detail-placeholder"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="json-tree"]').exists()).toBe(false)
  })

  it('shows a loading state while getLine is in flight', async () => {
    await initSource()
    selectionStore.activate(1, 0)
    await vi.waitFor(() => expect(getLineOps().length).toBe(1))
    expect(wrapper.find('[data-testid="detail-loading"]').exists()).toBe(true)

    worker.emit(success(getLineOps()[0]!.requestId!, { lineId: 1, text: '{"a":1}', isEdited: false }))
    await vi.waitFor(() => expect(wrapper.find('[data-testid="json-tree"]').exists()).toBe(true))
    expect(wrapper.find('[data-testid="detail-loading"]').exists()).toBe(false)
  })

  it('renders a valid row as a collapsible tree', async () => {
    await initSource()
    await selectAndAnswer('{"greeting":"hi","n":[1,2]}')
    const tree = wrapper.find('[data-testid="json-tree"]')
    expect(tree.exists()).toBe(true)
    expect(tree.text()).toContain('"hi"')
    // Collapsing works from the panel (independent node state).
    await tree.find('[data-testid="json-toggle-n-1"]').trigger('click')
    expect(tree.find('[data-testid="json-count-n-1"]').text()).toContain('2 items')
  })

  it('shows invalid JSON as raw text with an error banner', async () => {
    await initSource()
    await selectAndAnswer('this is not json')
    expect(wrapper.find('[data-testid="detail-invalid-banner"]').attributes('role')).toBe('alert')
    const raw = wrapper.find('[data-testid="detail-raw"]')
    expect(raw.exists()).toBe(true)
    expect(raw.text()).toContain('this is not json')
    expect(wrapper.find('[data-testid="json-tree"]').exists()).toBe(false)
  })

  it('gates a giant row behind explicit confirmation (no auto tree parse)', async () => {
    await initSource()
    await selectAndAnswer(LARGE_TEXT)

    // Default: raw + confirm banner, NO tree in the DOM.
    expect(wrapper.find('[data-testid="detail-large-confirm"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="detail-raw"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="json-tree"]').exists()).toBe(false)

    // Confirm: the tree is parsed and rendered.
    await wrapper.find('[data-testid="detail-large-confirm-btn"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.find('[data-testid="json-tree"]').exists()).toBe(true))
    expect(wrapper.find('[data-testid="detail-large-confirm"]').exists()).toBe(false)
  })

  it('Format/Compact are presentation-only: mode flips, no setEdit posted', async () => {
    await initSource()
    await selectAndAnswer('{"a":1}')

    const panel = wrapper.find('[data-testid="detail-panel"]')
    expect(panel.attributes('data-mode')).toBe('format')

    await wrapper.find('[data-testid="detail-compact-btn"]').trigger('click')
    expect(wrapper.find('[data-testid="detail-panel"]').attributes('data-mode')).toBe('compact')
    await wrapper.find('[data-testid="detail-format-btn"]').trigger('click')
    expect(wrapper.find('[data-testid="detail-panel"]').attributes('data-mode')).toBe('format')

    // The worker never received an edit (the row text is untouched).
    const types = worker.posted.map((m) => (m as PostedOp).type)
    expect(types).not.toContain('setEdit')
  })

  it('surfaces a typed load failure with an actionable message', async () => {
    await initSource()
    selectionStore.activate(1, 0)
    await vi.waitFor(() => expect(getLineOps().length).toBe(1))
    worker.emit(failure(getLineOps()[0]!.requestId!, 'internal', 'Disk read failed'))
    await vi.waitFor(() => expect(wrapper.find('[data-testid="detail-error"]').exists()).toBe(true))
    expect(wrapper.find('[data-testid="detail-error"]').text()).toContain('Disk read failed')
  })

  it('returns to the placeholder when the selection is cleared', async () => {
    await initSource()
    await selectAndAnswer('{"a":1}')
    expect(wrapper.find('[data-testid="json-tree"]').exists()).toBe(true)

    selectionStore.resetSelection()
    await vi.waitFor(() => expect(wrapper.find('[data-testid="detail-placeholder"]').exists()).toBe(true))
  })

  it('Copy is mode-aware for valid JSON (format pretty / compact minified)', async () => {
    // Not ready: disabled.
    expect(wrapper.find('[data-testid="detail-copy-btn"]').attributes('disabled')).toBeDefined()

    await initSource()
    await selectAndAnswer('{"a":1, "b":[2,3]}')
    const copyBtn = wrapper.find('[data-testid="detail-copy-btn"]')
    expect(copyBtn.attributes('disabled')).toBeUndefined()

    // Default mode (format): pretty-printed, two-space.
    await copyBtn.trigger('click')
    await vi.waitFor(() => expect(clipboardMock.writeText).toHaveBeenCalledTimes(1))
    expect(clipboardMock.writeText).toHaveBeenCalledWith('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}')

    // Compact mode: minified. (Wait for the copy state to settle: the
    // button is disabled while a copy is in flight.)
    await vi.waitFor(() => expect(copyBtn.attributes('disabled')).toBeUndefined())
    detailStore.setViewMode('compact')
    await copyBtn.trigger('click')
    await vi.waitFor(() => expect(clipboardMock.writeText).toHaveBeenCalledTimes(2))
    expect(clipboardMock.writeText).toHaveBeenLastCalledWith('{"a":1,"b":[2,3]}')
  })

  it('Copy of an INVALID row uses the raw text (no serialization)', async () => {
    await initSource()
    await selectAndAnswer('not json, just text')
    await wrapper.find('[data-testid="detail-copy-btn"]').trigger('click')
    const toastStore = useToastStore()
    await vi.waitFor(() =>
      expect(toastStore.toasts.some((t) => t.title === 'Copied')).toBe(true),
    )
    expect(clipboardMock.writeText).toHaveBeenCalledWith('not json, just text')
  })

  it('surfaces a clipboard failure (typed toast, not silent)', async () => {
    await initSource()
    await selectAndAnswer('{"a":1}')
    clipboardMock.writeText.mockRejectedValueOnce(new Error('Clipboard access denied'))

    await wrapper.find('[data-testid="detail-copy-btn"]').trigger('click')
    const toastStore = useToastStore()
    await vi.waitFor(() =>
      expect(toastStore.toasts.some((t) => t.title === 'Copy failed')).toBe(true),
    )
  })

  it('Raw opens the virtualized raw modal (dialog on body)', async () => {
    await initSource()
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    await wrapper.find('[data-testid="detail-raw-btn"]').trigger('click')
    await vi.waitFor(() =>
      expect(document.body.querySelector('[role="dialog"]')).not.toBeNull(),
    )
  })
})
