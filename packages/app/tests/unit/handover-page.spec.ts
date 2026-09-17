/**
 * TSK0037 - explorer page handover wait state.
 *
 * - Standalone (no opener/parent): a no-file visit redirects to landing
 *   (the original guard behavior).
 * - Embedded (window.open / iframe): no redirect — the page waits for
 *   the host's `load` with the banner + a drop zone as manual fallback,
 *   and switches to the data view once the load lands.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { routeLocationKey, routerKey, type RouteLocationNormalizedLoaded } from 'vue-router'
import ExplorerPage from '~/pages/explorer.vue'
import { useJsonlEngine, resetJsonlEngineForTests } from '~/composables/useJsonlEngine'
import { FakeWorker, success } from '../helpers/fakeWorker'

interface PostedOp {
  type: string
  requestId?: string
}

function makeRoute(): RouteLocationNormalizedLoaded {
  return { query: {} } as unknown as RouteLocationNormalizedLoaded
}

describe('explorer handover wait state (TSK0037)', () => {
  let pinia: Pinia
  let worker: FakeWorker
  let pushed: string[]
  let host: Window

  function mountExplorer() {
    return mount(ExplorerPage, {
      global: {
        plugins: [pinia],
        provide: {
          [routerKey]: { push: (to: string) => (pushed.push(to), Promise.resolve()) },
          [routeLocationKey]: makeRoute(),
        },
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
    pushed = []
    host = { postMessage: vi.fn() } as unknown as Window
    Object.defineProperty(window, 'opener', { value: null, configurable: true })
  })

  afterEach(() => {
    Object.defineProperty(window, 'opener', { value: null, configurable: true })
  })

  it('redirects to landing when standalone (no host window)', async () => {
    const wrapper = mountExplorer()
    await flushPromises()
    await flushPromises()
    expect(pushed).toEqual(['/'])
    expect(wrapper.find('[data-testid="handover-waiting"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('embedded: waits for the host (banner + drop zone), no redirect', async () => {
    Object.defineProperty(window, 'opener', { value: host, configurable: true })
    const wrapper = mountExplorer()
    await flushPromises()
    await flushPromises()

    expect(pushed).toEqual([]) // no redirect
    expect(wrapper.find('[data-testid="handover-waiting"]').exists()).toBe(true)
    expect(wrapper.find('#file-input').exists()).toBe(true) // manual fallback
    // ready was announced to the host's exact origin.
    expect((host.postMessage as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toEqual({
      ns: 'jsonl-explorer',
      v: 1,
      type: 'ready',
    })
    wrapper.unmount()
  })

  it('embedded: switches to the data view once the host load lands', async () => {
    Object.defineProperty(window, 'opener', { value: host, configurable: true })
    const wrapper = mountExplorer()
    await flushPromises()
    await flushPromises()

    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          ns: 'jsonl-explorer',
          v: 1,
          type: 'load',
          name: 'host.jsonl',
          payload: '{"a":1}\n{"b":2}\n',
        },
        origin: location.origin,
        source: host,
      }),
    )
    await vi.waitFor(() =>
      expect(worker.posted.some((m) => (m as PostedOp).type === 'initMemory')).toBe(true),
    )
    const init = worker.posted.find((m) => (m as PostedOp).type === 'initMemory') as PostedOp
    worker.emit(success(init.requestId!, { name: 'host.jsonl', size: 16, type: 'handover' }))

    // Commit the background index so the row list has rows.
    await vi.waitFor(() =>
      expect(worker.posted.some((m) => (m as PostedOp).type === 'index')).toBe(true),
    )
    const index = worker.posted.find((m) => (m as PostedOp).type === 'index') as PostedOp & {
      operationId: string
    }
    worker.emit(success(index.requestId!, null))
    worker.emit({
      ns: 'jsonl-explorer',
      v: 1,
      type: 'indexComplete',
      operationId: index.operationId,
      totalRows: 2,
      totalBytes: 16,
      durationMs: 1,
      generation: 1,
    })
    await flushPromises()
    await flushPromises()

    // The wait state is gone; the data view is up.
    expect(wrapper.find('[data-testid="handover-waiting"]').exists()).toBe(false)
    expect(wrapper.find('#file-input').exists()).toBe(false)
    expect(wrapper.find('[data-testid="row-list-scroll"]').exists()).toBe(true)
    wrapper.unmount()
  })
})
