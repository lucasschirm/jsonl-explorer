/**
 * Explorer keyboard policy (TSK0036):
 * - Ctrl/Cmd+F focuses the filter input — unless an editable control has
 *   focus (native keys win) or a modal is open (the dialog owns the keys).
 * - Plain Enter on the row list moves focus to the active row's editor:
 *   the tree root value (bracket when expanded, summary when collapsed)
 *   or the raw editor for invalid rows. Never from a focused control.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { routeLocationKey, routerKey, type RouteLocationNormalizedLoaded } from 'vue-router'
import ExplorerPage from '~/pages/explorer.vue'
import { useFileStore } from '~/stores/file'
import { useSelectionStore } from '~/stores/selection'
import { useJsonlEngine, resetJsonlEngineForTests } from '~/composables/useJsonlEngine'
import { FakeWorker, success } from '../helpers/fakeWorker'

let pinia: Pinia
let worker: FakeWorker

interface PostedOp {
  type?: string
  requestId?: string
  [k: string]: unknown
}

function makeRoute(): RouteLocationNormalizedLoaded {
  return { query: {} } as unknown as RouteLocationNormalizedLoaded
}

// The keyboard policy lives on `document`/`window`, so the page must be
// ATTACHED to the document: focus and querySelector never see detached
// VTU wrappers.
const containers: HTMLElement[] = []

function mountExplorer() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  containers.push(container)
  return mount(ExplorerPage, {
    global: {
      plugins: [pinia],
      provide: {
        [routerKey]: { push: () => Promise.resolve() },
        [routeLocationKey]: makeRoute(),
      },
      stubs: { 'nuxt-link': true },
    },
    attachTo: container,
  })
}

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  resetJsonlEngineForTests()
  worker = new FakeWorker()
  useJsonlEngine({ workerFactory: () => worker as unknown as Worker })
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.querySelectorAll('[data-kb-test-modal]').forEach((el) => el.remove())
  containers.splice(0).forEach((el) => el.remove())
})

function lastPosted(type: string): PostedOp | undefined {
  return [...worker.posted].reverse().find((m) => (m as PostedOp).type === type) as PostedOp | undefined
}

/** initFile + index + indexComplete: the explorer shows an indexed file. */
async function loadIndexedFile(rows: string[]): Promise<void> {
  const payload = rows.map((r) => `${r}\n`).join('')
  const fileStore = useFileStore()
  const pending = fileStore.loadFile(new File([payload], 'kb.jsonl', { type: 'application/jsonl' }))

  await vi.waitFor(() => expect(lastPosted('initFile')).toBeDefined())
  worker.emit(success(lastPosted('initFile')!.requestId!, { name: 'kb.jsonl', size: payload.length, type: 'file' }))
  await vi.waitFor(() => expect(lastPosted('index')).toBeDefined())
  worker.emit(success(lastPosted('index')!.requestId!, { totalRows: rows.length, totalBytes: payload.length, durationMs: 1 }))
  worker.emit({
    ns: 'jsonl-explorer',
    v: 1,
    operationId: 'op-index',
    type: 'indexComplete',
    totalRows: rows.length,
    totalBytes: payload.length,
    durationMs: 1,
    generation: 1,
  })
  await vi.waitFor(() => expect(useFileStore().hasFile).toBe(true))
  void pending
}

/** A KeyboardEvent dispatched on `target` (bubbles to the window handler). */
function keydown(target: HTMLElement, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

async function scroller(wrapper: ReturnType<typeof mountExplorer>): Promise<HTMLElement> {
  await vi.waitFor(() => expect(wrapper.find('[data-testid="row-list-scroll"]').exists()).toBe(true))
  return wrapper.get<HTMLElement>('[data-testid="row-list-scroll"]').element
}

/** Activate `lineId` and answer its getLine, so the detail panel is ready. */
async function selectRow(lineId: number, text: string): Promise<void> {
  useSelectionStore().activate(lineId, lineId - 1)
  await vi.waitFor(() => expect(lastPosted('getLine')).toBeDefined())
  worker.emit(success(lastPosted('getLine')!.requestId!, { lineId, text, isEdited: false }))
}

describe('Ctrl/Cmd+F focus policy (TSK0036)', () => {
  it('focuses the filter input (and suppresses the browser find)', async () => {
    const wrapper = mountExplorer()
    await loadIndexedFile(['{"a":1}'])

    const event = keydown(document.body, { key: 'f', ctrlKey: true })
    await flushPromises()

    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(wrapper.get('[data-testid="filter-input"]').element)
    wrapper.unmount()
  })

  it('uses the same policy for Cmd+F (mac)', async () => {
    const wrapper = mountExplorer()
    await loadIndexedFile(['{"a":1}'])

    const event = keydown(document.body, { key: 'f', metaKey: true })
    await flushPromises()

    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(wrapper.get('[data-testid="filter-input"]').element)
    wrapper.unmount()
  })

  it('never overrides a focused input: the native key stays with the control', async () => {
    const wrapper = mountExplorer()
    await loadIndexedFile(['{"a":1}'])
    const input = wrapper.get<HTMLInputElement>('[data-testid="filter-input"]').element
    input.focus()

    const event = keydown(input, { key: 'f', ctrlKey: true })
    await flushPromises()

    expect(event.defaultPrevented).toBe(false) // the browser find is NOT suppressed
    expect(document.activeElement).toBe(input)
    wrapper.unmount()
  })

  it('does nothing while a modal is open (the dialog owns the keys)', async () => {
    const wrapper = mountExplorer()
    await loadIndexedFile(['{"a":1}'])
    const modal = document.createElement('div')
    modal.className = 'modal modal-open'
    modal.setAttribute('data-kb-test-modal', 'true')
    document.body.appendChild(modal)

    const event = keydown(document.body, { key: 'f', ctrlKey: true })
    await flushPromises()

    expect(event.defaultPrevented).toBe(false)
    expect(document.activeElement).not.toBe(wrapper.get('[data-testid="filter-input"]').element)
    wrapper.unmount()
  })
})

describe('Enter on the row list focuses the row editor (TSK0036)', () => {
  it('focuses the tree root edit affordance for a valid row', async () => {
    const wrapper = mountExplorer()
    await loadIndexedFile(['{"a":1}'])
    const list = await scroller(wrapper)
    await selectRow(1, '{"a":1}')
    await vi.waitFor(() =>
      expect(
        document.querySelector('[data-testid="json-edit-root-0"], [data-testid="json-count-root-0"]'),
      ).not.toBeNull(),
    )
    list.focus()

    const event = keydown(list, { key: 'Enter' })
    await flushPromises()

    expect(event.defaultPrevented).toBe(true)
    const editor = document.querySelector<HTMLElement>(
      '[data-testid="json-edit-root-0"], [data-testid="json-count-root-0"]',
    )
    expect(document.activeElement).toBe(editor)
    wrapper.unmount()
  })

  it('focuses the raw editor for an invalid row', async () => {
    const wrapper = mountExplorer()
    await loadIndexedFile(['not json at all'])
    const list = await scroller(wrapper)
    await selectRow(1, 'not json at all')
    await vi.waitFor(() => expect(document.querySelector('[data-testid="detail-raw-edit-btn"]')).not.toBeNull())
    list.focus()

    keydown(list, { key: 'Enter' })
    await flushPromises()

    expect(document.activeElement).toBe(document.querySelector('[data-testid="detail-raw-edit-btn"]'))
    wrapper.unmount()
  })

  it('is ignored while an input has focus (typed text is never hijacked)', async () => {
    const wrapper = mountExplorer()
    await loadIndexedFile(['{"a":1}'])
    const input = wrapper.get<HTMLInputElement>('[data-testid="filter-input"]').element
    input.focus()

    const event = keydown(input, { key: 'Enter' })
    await flushPromises()

    expect(document.activeElement).toBe(input)
    expect(document.querySelector('[data-testid="json-edit-root-0"], [data-testid="json-count-root-0"]')).toBeNull()
    wrapper.unmount()
  })

  it('does nothing when no row is active (no editor exists to focus)', async () => {
    const wrapper = mountExplorer()
    await loadIndexedFile(['{"a":1}'])
    const list = await scroller(wrapper)
    list.focus()

    const event = keydown(list, { key: 'Enter' })
    await flushPromises()

    // No editor rendered: the key is not consumed and focus stays on the list.
    expect(event.defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(list)
    wrapper.unmount()
  })
})
