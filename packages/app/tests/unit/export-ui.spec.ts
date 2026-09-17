/**
 * Export UI (TSK0035): the header button dispatches to the right
 * destination, the progress strip shows filename/progress/cancel, the
 * blob-confirmation modal gates over-threshold downloads, and mutation
 * affordances are disabled while an export runs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { routeLocationKey, routerKey, type RouteLocationNormalizedLoaded } from 'vue-router'
import ExplorerPage from '~/pages/explorer.vue'
import ExportStatus from '~/components/explorer/ExportStatus.vue'
import ExportConfirmModal from '~/components/explorer/ExportConfirmModal.vue'
import ProgressBar from '~/components/ui/ProgressBar.vue'
import JsonNode from '~/components/explorer/JsonNode.vue'
import { useFileStore } from '~/stores/file'
import { useExporterStore } from '~/stores/exporter'
import { useJsonlEngine, resetJsonlEngineForTests } from '~/composables/useJsonlEngine'
import { FakeWorker, success } from '../helpers/fakeWorker'

let pinia: Pinia
let worker: FakeWorker

function makeRoute(): RouteLocationNormalizedLoaded {
  return { query: {} } as unknown as RouteLocationNormalizedLoaded
}

function mountExplorer() {
  return mount(ExplorerPage, {
    global: {
      plugins: [pinia],
      provide: {
        [routerKey]: { push: () => Promise.resolve() },
        [routeLocationKey]: makeRoute(),
      },
      components: { ProgressBar },
      stubs: { 'nuxt-link': true },
    },
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
})

function loadFile(name = 'a.jsonl'): void {
  const fileStore = useFileStore()
  const pending = fileStore.loadFile(new File(['{"a":1}\n'], name, { type: 'application/jsonl' }))
  const init = worker.posted.find((m) => (m as { type?: string }).type === 'initFile') as { requestId?: string }
  worker.emit(success(init.requestId!, { name, size: 9, type: 'file' }))
  void pending
}

function lastOfType(type: string): { requestId?: string; [k: string]: unknown } | undefined {
  return [...worker.posted].reverse().find((m) => (m as { type?: string }).type === type) as
    | { requestId?: string; [k: string]: unknown }
    | undefined
}

function answer(type: string, value: unknown): void {
  const msg = lastOfType(type)
  if (!msg?.requestId) throw new Error(`no posted ${type}`)
  worker.emit(success(msg.requestId, value))
}

async function exportButton(): Promise<import('@vue/test-utils').VueWrapper> {
  const wrapper = mountExplorer()
  loadFile()
  await flushPromises()
  await vi.waitFor(() => expect(wrapper.get('[data-testid="export-button"]').attributes('disabled')).toBeUndefined())
  return wrapper
}

describe('export button (TSK0035)', () => {
  it('is disabled without a file and enabled once one is loaded', async () => {
    const wrapper = mountExplorer()
    const button = wrapper.get('[data-testid="export-button"]')
    expect(button.attributes('disabled')).toBeDefined()
    loadFile()
    await flushPromises()
    await vi.waitFor(() => expect(button.attributes('disabled')).toBeUndefined())
  })

  it('dispatches to the Blob fallback when FSA is unavailable', async () => {
    const wrapper = await exportButton()
    wrapper.get('[data-testid="export-button"]').trigger('click')
    await vi.waitFor(() => expect(worker.posted.some((m) => (m as { type?: string }).type === 'exportStart')).toBe(true))
  })

  it('opens the FSA picker when the API is available and pumps to the writable', async () => {
    const picker = vi.fn(
      async (_opts?: { suggestedName?: string; types?: unknown[] }) => ({
        createWritable: async () => ({ write: async () => {}, close: async () => {}, abort: async () => {} }),
      }),
    )
    vi.stubGlobal('showSaveFilePicker', picker)
    const wrapper = await exportButton()

    wrapper.get('[data-testid="export-button"]').trigger('click')
    await vi.waitFor(() => expect(worker.posted.some((m) => (m as { type?: string }).type === 'exportStart')).toBe(true))
    answer('exportStart', { token: 'tok', estimatedBytes: 9, totalRows: 1, generation: 1, partial: false })
    await vi.waitFor(() => expect(worker.posted.some((m) => (m as { type?: string }).type === 'exportNext')).toBe(true))
    answer('exportNext', { data: new TextEncoder().encode('{"a":1}\n'), done: true, rowsExported: 1 })
    await vi.waitFor(() => expect(worker.posted.some((m) => (m as { type?: string }).type === 'exportAck')).toBe(true))
    answer('exportAck', { acknowledged: true })
    await flushPromises()

    expect(picker).toHaveBeenCalledTimes(1)
    expect(picker.mock.calls[0]?.[0]?.suggestedName).toBe('a.jsonl')
  })
})

describe('export progress strip (TSK0035)', () => {
  it('shows filename/progress and cancel posts exportCancel (run ends cancelled)', async () => {
    loadFile()
    // The real UI only offers Export once the file is loaded (canStart).
    await vi.waitFor(() => expect(useFileStore().hasFile).toBe(true))
    const exporter = useExporterStore()
    const run = exporter.prepareBlob()

    await vi.waitFor(() => expect(worker.posted.some((m) => (m as { type?: string }).type === 'exportStart')).toBe(true))
    answer('exportStart', { token: 'tok', estimatedBytes: 4, totalRows: 2, generation: 1, partial: false })
    await vi.waitFor(() => expect(worker.posted.some((m) => (m as { type?: string }).type === 'exportNext')).toBe(true))
    answer('exportNext', { data: new TextEncoder().encode('a\n'), done: false, rowsExported: 1 })
    await vi.waitFor(() => expect(worker.posted.filter((m) => (m as { type?: string }).type === 'exportAck').length).toBe(1))
    answer('exportAck', { acknowledged: true })
    // next#2 is in flight: the strip is visible and cancel is available.
    const wrapper = mount(ExportStatus, {
      global: { plugins: [pinia], components: { ProgressBar } },
    })
    expect(wrapper.get('[data-testid="export-status-name"]').text()).toContain('a.jsonl')
    expect(wrapper.get('[data-testid="export-status-progress"]').text()).toContain('1 / 2')

    wrapper.get('[data-testid="export-cancel-btn"]').trigger('click')
    await vi.waitFor(() => expect(worker.posted.some((m) => (m as { type?: string }).type === 'exportCancel')).toBe(true))
    answer('exportCancel', { cancelled: true })
    // The real worker fails the in-flight next with the dead token.
    const next2 = lastOfType('exportNext')
    worker.emit({
      ns: 'jsonl-explorer',
      v: 1,
      requestId: next2!.requestId,
      ok: false,
      error: { code: 'EXPORT_TOKEN_INVALID', message: 'Invalid or expired export token' },
    })
    await run

    expect(exporter.status).toBe('idle')
    expect(exporter.progress).toBeNull()
  })
})

// The modal teleports to document.body — query there, not the wrapper.
function bodyEl(testId: string): Element | null {
  return document.body.querySelector(`[data-testid="${testId}"]`)
}

describe('blob confirmation modal (TSK0035)', () => {
  it('renders nothing without a pending confirmation', () => {
    const wrapper = mount(ExportConfirmModal, { global: { plugins: [pinia] } })
    expect(bodyEl('export-confirm-title')).toBeNull()
    wrapper.unmount()
  })

  it('shows the estimate and confirms via a fresh exportStart', async () => {
    loadFile()
    await vi.waitFor(() => expect(useFileStore().hasFile).toBe(true))
    const exporter = useExporterStore()
    ;(exporter as unknown as { blobConfirm: unknown }).blobConfirm = {
      estimatedBytes: 600 * 1024 * 1024,
      totalRows: 10,
      fileName: 'a.jsonl',
    }

    const wrapper = mount(ExportConfirmModal, { global: { plugins: [pinia] } })
    expect(bodyEl('export-confirm-title')?.textContent).toContain('Confirm large download')
    expect(bodyEl('export-confirm-estimate')?.textContent).toContain('600')

    bodyEl('export-confirm-ok')!.dispatchEvent(new Event('click'))
    await flushPromises()
    expect(worker.posted.some((m) => (m as { type?: string }).type === 'exportStart')).toBe(true)
    expect(exporter.blobConfirm).toBeNull()
    wrapper.unmount()
  })

  it('dismisses without starting anything', async () => {
    loadFile()
    const exporter = useExporterStore()
    ;(exporter as unknown as { blobConfirm: unknown }).blobConfirm = {
      estimatedBytes: 600 * 1024 * 1024,
      totalRows: 10,
      fileName: 'a.jsonl',
    }
    const wrapper = mount(ExportConfirmModal, { global: { plugins: [pinia] } })

    bodyEl('export-confirm-dismiss')!.dispatchEvent(new Event('click'))
    await flushPromises()
    expect(exporter.blobConfirm).toBeNull()
    expect(worker.posted.some((m) => (m as { type?: string }).type === 'exportStart')).toBe(false)
    wrapper.unmount()
  })
})

describe('mutation gating (TSK0035)', () => {
  it('disables tree edit affordances while an export runs', async () => {
    const exporter = useExporterStore()
    const before = mount(JsonNode, {
      props: { value: { x: 1 } },
      global: { plugins: [pinia] },
    })
    expect(before.get('[data-testid="json-edit-x-1"]').attributes('disabled')).toBeUndefined()

    ;(exporter as unknown as { status: string }).status = 'running'
    await flushPromises()
    const wrapper = mount(JsonNode, {
      props: { value: { x: 1 } },
      global: { plugins: [pinia] },
    })
    expect(wrapper.get('[data-testid="json-edit-x-1"]').attributes('disabled')).toBeDefined()
  })
})
