/**
 * DetailPanel (TSK0024): idle/loading/error states, the tree for valid
 * JSON, raw fallback + banner for invalid JSON, the large-row confirm
 * gate (no auto-parse above the threshold), and Format/Compact as
 * presentation-only controls (no setEdit ever).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { mount, type VueWrapper } from '@vue/test-utils'
import { useJsonlEngine, resetJsonlEngineForTests } from '~/composables/useJsonlEngine'
import { useSelectionStore } from '~/stores/selection'
import { useDetailStore } from '~/stores/detail'
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
    wrapper = mount(DetailPanel, { global: { plugins: [pinia] } })
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
})
