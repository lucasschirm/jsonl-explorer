/**
 * Explorer shell (TSK0020): the "Upload another file" action fully
 * disposes the engine (worker terminated after the dispose RPC, spool
 * cleaned worker-side) and returns to landing; the header stays small
 * and fixed while panels scroll independently; the split layout keeps a
 * documented 1024px minimum viewport.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { routeLocationKey, routerKey, type RouteLocationNormalizedLoaded } from 'vue-router'
import ExplorerPage from '~/pages/explorer.vue'
import { useFileStore } from '~/stores/file'
import { useJsonlEngine, resetJsonlEngineForTests } from '~/composables/useJsonlEngine'
import { FakeWorker, success } from '../helpers/fakeWorker'

interface PostedOp {
  type: string
  requestId?: string
}

function makeRoute(query: Record<string, string>): RouteLocationNormalizedLoaded {
  return { query } as unknown as RouteLocationNormalizedLoaded
}

function routerStub(pushed: string[]) {
  return { push: (to: string) => { pushed.push(to); return Promise.resolve() } }
}

describe('explorer shell (TSK0020)', () => {
  let pinia: Pinia
  let worker: FakeWorker
  let pushed: string[]

  function mountExplorer() {
    return mount(ExplorerPage, {
      global: {
        plugins: [pinia],
        provide: {
          [routerKey]: routerStub(pushed),
          [routeLocationKey]: makeRoute({}),
        },
        stubs: { 'nuxt-link': true },
      },
    })
  }

  /** Load a file end-to-end through the store (engine open + metadata). */
  async function loadFile(name: string) {
    const fileStore = useFileStore()
    const file = new File(['{"a":1}\n'], name, { type: 'application/jsonl' })
    const pending = fileStore.loadFile(file)
    await vi.waitFor(() =>
      expect(worker.posted.some((m) => (m as PostedOp).type === 'initFile')).toBe(true),
    )
    const init = worker.posted.find((m) => (m as PostedOp).type === 'initFile') as PostedOp
    worker.emit(success(init.requestId!, { name, size: 9, type: 'file' }))
    await pending
  }

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    resetJsonlEngineForTests()
    worker = new FakeWorker()
    useJsonlEngine({ workerFactory: () => worker as unknown as Worker })
    pushed = []
  })

  it('"Upload another file" disposes worker + storage and returns to landing', async () => {
    await loadFile('a.jsonl')
    const wrapper = mountExplorer()
    await flushPromises()
    // Initialized navigation: no redirect.
    expect(pushed).toEqual([])

    const upload = wrapper.find('[data-testid="upload-another"]')
    expect(upload.exists()).toBe(true)
    await upload.trigger('click')
    // The navigation happens after the dispose grace period (worker-side
    // spool cleanup first), so wait for it instead of assuming it is sync.
    await vi.waitFor(() => expect(pushed).toEqual(['/']))
    // …with the engine fully disposed: the worker-side dispose RPC (spool
    // cleanup) was posted and the worker terminated — no warm worker left.
    const disposeRpcs = worker.posted.filter((m) => (m as PostedOp).type === 'dispose')
    expect(disposeRpcs.length).toBe(1)
    expect(worker.terminated).toBe(1)
    expect(useFileStore().hasFile).toBe(false)
    wrapper.unmount()
  })

  it('the header is small (48px) and fixed; main scrolls inside it', () => {
    const wrapper = mountExplorer()
    const header = wrapper.find('header')
    expect(header.exists()).toBe(true)
    expect(header.classes()).toContain('h-12')
    const main = wrapper.find('main')
    expect(main.classes()).toContain('overflow-hidden')
    expect(main.classes()).toContain('flex-1')
    wrapper.unmount()
  })

  it('the split layout keeps the 1024px minimum viewport (no panel stacking)', () => {
    const wrapper = mountExplorer()
    const root = wrapper.find('div')
    expect(root.classes()).toContain('min-w-[1024px]')
    // The left panel is fixed width, the right one flexes — never stacked.
    const asides = wrapper.findAll('aside')
    expect(asides.length).toBe(2)
    expect(asides[0]!.classes()).toContain('w-96')
    expect(asides[1]!.classes()).toContain('flex-1')
    wrapper.unmount()
  })
})
