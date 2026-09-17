/**
 * DetailPanel (TSK0024): idle/loading/error states, the tree for valid
 * JSON, raw fallback + banner for invalid JSON, the large-row confirm
 * gate (no auto-parse above the threshold), and Format/Compact as
 * presentation-only controls (no setEdit ever).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { mount, type VueWrapper } from '@vue/test-utils'
import { useJsonlEngine, resetJsonlEngineForTests } from '~/composables/useJsonlEngine'
import { useSelectionStore } from '~/stores/selection'
import { useDetailStore } from '~/stores/detail'
import { useEditsStore } from '~/stores/edits'
import { useToastStore } from '~/stores/toasts'
import DetailPanel from '~/components/explorer/DetailPanel.vue'
import { FakeWorker, success, failure } from '../helpers/fakeWorker'

interface PostedOp {
  type: string
  requestId?: string
  lineId?: number
  text?: string
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

  it('shows the edited badge while the active row carries an override (TSK0030)', async () => {
    await initSource()
    await selectAndAnswer('{"greeting":"hi"}')
    expect(wrapper.find('[data-testid="detail-edited-badge"]').exists()).toBe(false)

    const editsStore = useEditsStore()
    const answerSetEdit = (isEdited: boolean) =>
      vi.waitFor(async () => {
        const ops = worker.posted.filter((m) => (m as PostedOp).type === 'setEdit') as PostedOp[]
        const op = ops.at(-1)
        if (!op?.requestId) throw new Error('setEdit not posted yet')
        worker.emit(success(op.requestId, { lineId: 1, isEdited, newGeneration: 2 }))
      })

    const pendingSet = editsStore.setEdit(1, '{"greeting":"edited"}')
    await answerSetEdit(true)
    await pendingSet
    await nextTick()
    expect(wrapper.find('[data-testid="detail-edited-badge"]').exists()).toBe(true)

    const pendingReset = editsStore.resetEdit(1)
    await answerSetEdit(false)
    await pendingReset
    await nextTick()
    expect(wrapper.find('[data-testid="detail-edited-badge"]').exists()).toBe(false)
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

describe('DetailPanel inline tree editing (TSK0031)', () => {
  let pinia: Pinia
  let worker: FakeWorker
  let wrapper: VueWrapper<InstanceType<typeof DetailPanel>>
  let selectionStore: ReturnType<typeof useSelectionStore>
  let detailStore: ReturnType<typeof useDetailStore>
  let editsStore: ReturnType<typeof useEditsStore>

  const getLineOps = (): PostedOp[] =>
    worker.posted.filter((m) => (m as PostedOp).type === 'getLine') as PostedOp[]
  const setEditOps = (): PostedOp[] =>
    worker.posted.filter((m) => (m as PostedOp).type === 'setEdit') as PostedOp[]

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
    await vi.waitFor(() => expect(detailStore.status).toBe('ready'))
    await nextTick()
  }

  async function clickToken(keyName: string, depth: number) {
    await wrapper.find(`[data-testid="json-edit-${keyName}-${depth}"]`).trigger('click')
    await nextTick()
  }

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    resetJsonlEngineForTests()
    worker = new FakeWorker()
    useJsonlEngine({ workerFactory: () => worker as unknown as Worker })
    selectionStore = useSelectionStore()
    detailStore = useDetailStore()
    editsStore = useEditsStore()
    wrapper = mount(DetailPanel, { global: { plugins: [pinia] } })
  })

  afterEach(() => {
    wrapper.unmount()
    document.body.innerHTML = ''
  })

  it('clicking a primitive token opens a seeded editor; Enter commits the whole document', async () => {
    await initSource()
    await selectAndAnswer('{"greeting":"hi","n":1}')

    await clickToken('greeting', 1)
    const input = wrapper.find('[data-testid="json-edit-input"]')
    expect(input.exists()).toBe(true)
    // Seeded with the current raw token.
    expect((input.element as HTMLInputElement).value).toBe('"hi"')

    await input.setValue('2')
    await input.trigger('keydown.enter')

    await vi.waitFor(() => expect(setEditOps().length).toBe(1))
    // ONE setEdit with the WHOLE re-serialized document.
    expect(setEditOps()[0]!.text).toBe('{"greeting":2,"n":1}')
    worker.emit(success(setEditOps()[0]!.requestId!, { lineId: 1, isEdited: true, newGeneration: 2, filteredIndex: 0 }))
    await vi.waitFor(() => expect(getLineOps().length).toBe(2))
    worker.emit(success(getLineOps()[1]!.requestId!, { lineId: 1, text: '{"greeting":2,"n":1}', isEdited: true }))
    await vi.waitFor(() => expect(detailStore.text).toBe('{"greeting":2,"n":1}'))
    await nextTick()

    // The editor is gone, the token shows the new value, the badge is on.
    expect(wrapper.find('[data-testid="json-edit-input"]').exists()).toBe(false)
    expect(wrapper.find(`[data-testid="json-edit-greeting-1"]`).text()).toBe('2')
    expect(wrapper.find('[data-testid="detail-edited-badge"]').exists()).toBe(true)
    expect(editsStore.isEdited(1)).toBe(true)
  })

  it('an array element is editable (numeric path segment)', async () => {
    await initSource()
    await selectAndAnswer('{"items":["a","b"]}')

    // Element 1 of "items": keyName '1', depth 2 (root=0, items=1, entry=2).
    await clickToken('1', 2)
    const input = wrapper.find('[data-testid="json-edit-input"]')
    expect(input.exists()).toBe(true)
    expect((input.element as HTMLInputElement).value).toBe('"b"')

    await input.setValue('"c"')
    await input.trigger('keydown.enter')
    await vi.waitFor(() => expect(setEditOps().length).toBe(1))
    expect(setEditOps()[0]!.text).toBe('{"items":["a","c"]}')
    worker.emit(success(setEditOps()[0]!.requestId!, { lineId: 1, isEdited: true, newGeneration: 2, filteredIndex: 0 }))
    await vi.waitFor(() => expect(getLineOps().length).toBe(2))
    worker.emit(success(getLineOps()[1]!.requestId!, { lineId: 1, text: '{"items":["a","c"]}', isEdited: true }))
    await vi.waitFor(() => expect(detailStore.text).toBe('{"items":["a","c"]}'))
  })

  it('a JSON null value seeds the editor with the token `null`', async () => {
    await initSource()
    await selectAndAnswer('{"n":null}')

    await clickToken('n', 1)
    const input = wrapper.find('[data-testid="json-edit-input"]')
    expect(input.exists()).toBe(true)
    expect((input.element as HTMLInputElement).value).toBe('null')

    await input.trigger('keydown.esc')
    await nextTick()
    expect(setEditOps().length).toBe(0)
    expect(detailStore.text).toBe('{"n":null}')
  })

  it('Escape cancels the edit: no RPC, token restored', async () => {
    await initSource()
    await selectAndAnswer('{"greeting":"hi"}')

    await clickToken('greeting', 1)
    const input = wrapper.find('[data-testid="json-edit-input"]')
    expect(input.exists()).toBe(true)
    await input.setValue('nope')
    await input.trigger('keydown.esc')
    await nextTick()

    expect(wrapper.find('[data-testid="json-edit-input"]').exists()).toBe(false)
    expect(setEditOps().length).toBe(0)
    expect(wrapper.find(`[data-testid="json-edit-greeting-1"]`).text()).toBe('"hi"')
    expect(detailStore.text).toBe('{"greeting":"hi"}')
  })

  it('an unquoted draft is saved as a string (coercion fallback)', async () => {
    await initSource()
    await selectAndAnswer('{"greeting":"hi"}')

    await clickToken('greeting', 1)
    const input = wrapper.find('[data-testid="json-edit-input"]')
    await input.setValue('hello world')
    await input.trigger('keydown.enter')

    await vi.waitFor(() => expect(setEditOps().length).toBe(1))
    expect(setEditOps()[0]!.text).toBe('{"greeting":"hello world"}')
    worker.emit(success(setEditOps()[0]!.requestId!, { lineId: 1, isEdited: true, newGeneration: 2, filteredIndex: 0 }))
    await vi.waitFor(() => expect(getLineOps().length).toBe(2))
    worker.emit(success(getLineOps()[1]!.requestId!, { lineId: 1, text: '{"greeting":"hello world"}', isEdited: true }))
    await vi.waitFor(() => expect(detailStore.text).toBe('{"greeting":"hello world"}'))
  })

  it('a collapsed container is editable via its summary; the whole container is replaced', async () => {
    // 60 items => starts collapsed (DOM guard); the summary carries the
    // json-count-* testid (the expanded bracket carries json-edit-*).
    const doc = JSON.stringify({ a: 1, list: Array.from({ length: 60 }, (_, i) => i) })
    await initSource()
    await selectAndAnswer(doc)

    await wrapper.find('[data-testid="json-count-list-1"]').trigger('click')
    await nextTick()
    const input = wrapper.find('[data-testid="json-edit-input"]')
    expect(input.exists()).toBe(true)
    expect((input.element as HTMLInputElement).value).toBe(JSON.stringify(Array.from({ length: 60 }, (_, i) => i)))

    await input.setValue('[1]')
    await input.trigger('keydown.enter')

    await vi.waitFor(() => expect(setEditOps().length).toBe(1))
    expect(setEditOps()[0]!.text).toBe('{"a":1,"list":[1]}')
    worker.emit(success(setEditOps()[0]!.requestId!, { lineId: 1, isEdited: true, newGeneration: 2, filteredIndex: 0 }))
    await vi.waitFor(() => expect(getLineOps().length).toBe(2))
    worker.emit(success(getLineOps()[1]!.requestId!, { lineId: 1, text: '{"a":1,"list":[1]}', isEdited: true }))
    await vi.waitFor(() => expect(detailStore.text).toBe('{"a":1,"list":[1]}'))
  })

  it('Reset is disabled until the row is edited, then restores the original text', async () => {
    await initSource()
    await selectAndAnswer('{"a":1}')

    const resetBtn = wrapper.find('[data-testid="detail-reset-btn"]')
    expect(resetBtn.exists()).toBe(true)
    expect((resetBtn.element as HTMLButtonElement).disabled).toBe(true)

    // Make an edit so the row becomes "edited".
    await clickToken('a', 1)
    const input = wrapper.find('[data-testid="json-edit-input"]')
    await input.setValue('2')
    await input.trigger('keydown.enter')
    await vi.waitFor(() => expect(setEditOps().length).toBe(1))
    worker.emit(success(setEditOps()[0]!.requestId!, { lineId: 1, isEdited: true, newGeneration: 2, filteredIndex: 0 }))
    await vi.waitFor(() => expect(getLineOps().length).toBe(2))
    worker.emit(success(getLineOps()[1]!.requestId!, { lineId: 1, text: '{"a":2}', isEdited: true }))
    await vi.waitFor(() => expect(editsStore.isEdited(1)).toBe(true))
    await vi.waitFor(() => expect(detailStore.text).toBe('{"a":2}'))
    await nextTick()
    expect((resetBtn.element as HTMLButtonElement).disabled).toBe(false)

    await resetBtn.trigger('click')
    await vi.waitFor(() => expect(setEditOps().length).toBe(2))
    // Reset = setEdit WITHOUT text.
    expect(setEditOps()[1]!.text).toBeUndefined()
    worker.emit(success(setEditOps()[1]!.requestId!, { lineId: 1, isEdited: false, newGeneration: 3, filteredIndex: 0 }))
    await vi.waitFor(() => expect(getLineOps().length).toBe(3))
    worker.emit(success(getLineOps()[2]!.requestId!, { lineId: 1, text: '{"a":1}', isEdited: false }))
    await vi.waitFor(() => expect(detailStore.text).toBe('{"a":1}'))
    await vi.waitFor(() => expect(editsStore.isEdited(1)).toBe(false))
    await nextTick()

    expect(editsStore.isEdited(1)).toBe(false)
    expect(wrapper.find('[data-testid="detail-edited-badge"]').exists()).toBe(false)
    expect((resetBtn.element as HTMLButtonElement).disabled).toBe(true)
  })

  it('switching rows mid-edit cancels the session (no cross-row draft)', async () => {
    await initSource()
    await selectAndAnswer('{"a":1}')
    await clickToken('a', 1)
    const input = wrapper.find('[data-testid="json-edit-input"]')
    expect(input.exists()).toBe(true)
    await input.setValue('77')

    // Leave the row (e.g. click another list row).
    selectionStore.activate(2, 1)
    await vi.waitFor(() => expect(getLineOps().length).toBe(2))
    worker.emit(success(getLineOps()[1]!.requestId!, { lineId: 2, text: '{"b":2}', isEdited: false }))
    await vi.waitFor(() => expect(detailStore.status).toBe('ready'))
    await nextTick()

    expect(setEditOps().length).toBe(0)
    expect(wrapper.find('[data-testid="json-edit-input"]').exists()).toBe(false)
  })
})
