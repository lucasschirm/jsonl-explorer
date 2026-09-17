/**
 * DetailSearch UI (TSK0033): the in-detail search bar for the SELECTED
 * row — text mode (count + prev/next + tree highlight) and jq mode (Run
 * button, output pane with per-output/copy-all, error line). Mounted via
 * DetailPanel (the bar only exists when the tree is shown).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { nextTick } from 'vue'
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
  text?: string
}

describe('DetailSearch (TSK0033)', () => {
  let pinia: Pinia
  let worker: FakeWorker
  let wrapper: VueWrapper<InstanceType<typeof DetailPanel>>
  let selectionStore: ReturnType<typeof useSelectionStore>
  let clipboardMock: { writeText: ReturnType<typeof vi.fn> }

  const getLineOps = (): PostedOp[] =>
    worker.posted.filter((m) => (m as PostedOp).type === 'getLine') as PostedOp[]
  const runJqOps = (): PostedOp[] =>
    worker.posted.filter((m) => (m as PostedOp).type === 'runJq') as PostedOp[]

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
    // Wait on the STORE (not the DOM): invalid rows never render a tree.
    await vi.waitFor(() => expect(useDetailStore().status).toBe('ready'))
    await nextTick()
  }

  const searchInput = () => wrapper.find('[data-testid="detail-search-input"]')
  const countLabel = () => wrapper.find('[data-testid="detail-search-count"]')
  const jqPane = () => wrapper.find('[data-testid="detail-search-jq-pane"]')
  const jqError = () => wrapper.find('[data-testid="detail-search-jq-error"]')

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    resetJsonlEngineForTests()
    worker = new FakeWorker()
    useJsonlEngine({ workerFactory: () => worker as unknown as Worker })
    selectionStore = useSelectionStore()
    clipboardMock = { writeText: vi.fn().mockResolvedValue(undefined) }
    Object.defineProperty(navigator, 'clipboard', { value: clipboardMock, configurable: true })
    wrapper = mount(DetailPanel, { global: { plugins: [pinia] } })
  })

  afterEach(() => {
    wrapper.unmount()
    delete (navigator as { clipboard?: unknown }).clipboard
    document.body.innerHTML = ''
  })

  it('is hidden without a tree (no row, invalid rows)', async () => {
    expect(searchInput().exists()).toBe(false)
    await initSource()
    await selectAndAnswer('not json')
    expect(searchInput().exists()).toBe(false)
  })

  it('text mode: shows the count and highlights matches in the tree', async () => {
    await initSource()
    await selectAndAnswer('{"name":"alpha","other":"beta"}')
    expect(searchInput().exists()).toBe(true)

    await searchInput().setValue('alpha')
    await vi.waitFor(() => expect(countLabel().text()).toBe('1 result'))

    // The matching VALUE token is highlighted (bg-warning/30):
    const valueBtn = wrapper
      .findAll('button')
      .find((b) => b.text() === '"alpha"' && b.classes().includes('bg-warning/30'))
    expect(valueBtn).toBeTruthy()
  })

  it('text mode: a match inside a COLLAPSED container auto-expands it', async () => {
    await initSource()
    // "target" sits inside an object with >50 keys → collapsed by default;
    // the key span only exists in the DOM once the container opens.
    const outer: Record<string, string> = {}
    for (let i = 0; i < 60; i++) outer[`k${i}`] = 'v'
    outer['target'] = 'hit'
    await selectAndAnswer(JSON.stringify({ outer }))

    // The match is not (yet) rendered: the container is still collapsed.
    await searchInput().setValue('target')
    await vi.waitFor(() => expect(countLabel().text()).toBe('1 result'))
    expect(wrapper.findAll('span').some((s) => s.text().startsWith('target'))).toBe(false)

    // Navigating to the match auto-expands the collapsed container:
    await wrapper.find('[data-testid="detail-search-next"]').trigger('click')
    const keySpan = await vi.waitFor(() => {
      const span = wrapper
        .findAll('span')
        .find((s) => s.text().startsWith('target') && s.classes().includes('bg-warning/30'))
      expect(span).toBeTruthy()
      return span!
    })
    expect(keySpan.text()).toContain('target')
  })

  it('text mode: prev/next move the current highlight (bg-warning/60)', async () => {
    await initSource()
    await selectAndAnswer('{"a":"x","b":"x","c":"x"}')
    await searchInput().setValue('x')
    await vi.waitFor(() => expect(countLabel().text()).toBe('3 results'))

    const currentButtons = () =>
      wrapper.findAll('button').filter((b) => b.text() === '"x"' && b.classes().includes('bg-warning/60'))
    expect(currentButtons().length).toBe(0)

    await wrapper.find('[data-testid="detail-search-next"]').trigger('click')
    await vi.waitFor(() => expect(currentButtons().length).toBe(1)) // first match

    await wrapper.find('[data-testid="detail-search-next"]').trigger('click')
    await vi.waitFor(() => expect(currentButtons().length).toBe(1)) // second match

    // prev from the first wraps to the last:
    await wrapper.find('[data-testid="detail-search-next"]').trigger('click') // third
    await vi.waitFor(() => expect(currentButtons().length).toBe(1))
    await wrapper.find('[data-testid="detail-search-prev"]').trigger('click')
    await vi.waitFor(() => expect(countLabel().exists()).toBe(true))
  })

  it('jq mode: Run executes the program and lists every output', async () => {
    await initSource()
    await selectAndAnswer('{"items":[{"id":1},{"id":2}]}')
    await wrapper.find('[data-testid="detail-search-mode-jq"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.find('[data-testid="detail-search-run"]').exists()).toBe(true))

    await searchInput().setValue('.items[].id')
    await wrapper.find('[data-testid="detail-search-run"]').trigger('click')
    await vi.waitFor(() => expect(runJqOps().length).toBe(1))
    // The RPC carries a snapshot of the document:
    expect(runJqOps()[0]!.text).toBe('{"items":[{"id":1},{"id":2}]}')

    worker.emit(success(runJqOps()[0]!.requestId!, { lineId: 1, outputs: [1, 2] }))
    // The run settles on a microtask: wait for the DONE state's label.
    await vi.waitFor(() => expect(jqPane().text()).toContain('2 output(s)'))
    expect(wrapper.find('[data-testid="detail-search-jq-output-0"]').text()).toBe('1')
    expect(wrapper.find('[data-testid="detail-search-jq-output-1"]').text()).toBe('2')
  })

  it('jq mode: an empty run shows the no-output hint (not an error)', async () => {
    await initSource()
    await selectAndAnswer('{"a":1}')
    await wrapper.find('[data-testid="detail-search-mode-jq"]').trigger('click')
    await searchInput().setValue('empty')
    await wrapper.find('[data-testid="detail-search-run"]').trigger('click')
    await vi.waitFor(() => expect(runJqOps().length).toBe(1))
    worker.emit(success(runJqOps()[0]!.requestId!, { lineId: 1, outputs: [] }))
    await vi.waitFor(() => expect(wrapper.find('[data-testid="detail-search-jq-empty"]').exists()).toBe(true))
    expect(wrapper.find('[data-testid="detail-search-jq-empty"]').text()).toContain('No output')
    expect(jqError().exists()).toBe(false)
  })

  it('jq mode: a failed run shows the typed error line (no output pane)', async () => {
    await initSource()
    await selectAndAnswer('{"a":1}')
    await wrapper.find('[data-testid="detail-search-mode-jq"]').trigger('click')
    await searchInput().setValue('.a |')
    await wrapper.find('[data-testid="detail-search-run"]').trigger('click')
    await vi.waitFor(() => expect(runJqOps().length).toBe(1))
    worker.emit(
      failure(runJqOps()[0]!.requestId!, 'JQ_COMPILE_FAILED', 'The jq program does not parse: jq: error: syntax error'),
    )
    await vi.waitFor(() => expect(jqError().exists()).toBe(true))
    expect(jqError().text()).toContain('does not parse')
    // No outputs rendered; the pane header says the run failed:
    expect(wrapper.find('[data-testid="detail-search-jq-output-0"]').exists()).toBe(false)
    expect(jqPane().text()).toContain('run failed')
  })

  it('jq mode: copy-all writes every output (compact, newline-joined)', async () => {
    await initSource()
    await selectAndAnswer('{"a":1}')
    await wrapper.find('[data-testid="detail-search-mode-jq"]').trigger('click')
    await searchInput().setValue('.a, .a')
    await wrapper.find('[data-testid="detail-search-run"]').trigger('click')
    await vi.waitFor(() => expect(runJqOps().length).toBe(1))
    worker.emit(success(runJqOps()[0]!.requestId!, { lineId: 1, outputs: [1, 2] }))
    await vi.waitFor(() => expect(jqPane().text()).toContain('2 output(s)'))

    await wrapper.find('[data-testid="detail-search-jq-copy"]').trigger('click')
    await vi.waitFor(() => expect(clipboardMock.writeText).toHaveBeenCalledTimes(1))
    expect(clipboardMock.writeText).toHaveBeenCalledWith('1\n2')
  })

  it('mode toggle switches state and input purpose without losing results', async () => {
    await initSource()
    await selectAndAnswer('{"a":1}')
    await searchInput().setValue('a')
    await vi.waitFor(() => expect(countLabel().text()).toBe('1 result'))

    await wrapper.find('[data-testid="detail-search-mode-jq"]').trigger('click')
    await nextTick()
    expect(searchInput().attributes('placeholder')).toContain('jq program')

    await wrapper.find('[data-testid="detail-search-mode-text"]').trigger('click')
    await vi.waitFor(() => expect(countLabel().text()).toBe('1 result'))
  })
})
