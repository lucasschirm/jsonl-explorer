/**
 * URL startup-recovery round trip (PLAN 4.1):
 *
 *   /explorer?url=... fails  ->  landing page opens the URL modal prefilled
 *   with the entered non-secret URL, held in memory only (useUrlRecovery).
 *
 * Covers: `?url=` scrubbing (no double-decode, no embedded credentials),
 * typed error toasts, recovery handoff, and that the recovered value never
 * appears in router state.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { routeLocationKey, routerKey, type RouteLocationNormalizedLoaded } from 'vue-router'
import ExplorerPage from '~/pages/explorer.vue'
import IndexPage from '~/pages/index.vue'
import { useJsonlEngine, resetJsonlEngineForTests } from '~/composables/useJsonlEngine'
import { useUrlRecovery } from '~/composables/useUrlRecovery'
import { useFileStore } from '~/stores/file'
import { useToastStore } from '~/stores/toasts'
import { FakeWorker, success, failure } from '../helpers/fakeWorker'

/** Shape of the posted initUrl RPC (subset of the protocol request). */
interface PostedInit {
  type: string
  requestId: string
  url: string
}

function makeRoute(
  query: Record<string, string>,
  path = '/explorer',
): RouteLocationNormalizedLoaded {
  return { query, path } as unknown as RouteLocationNormalizedLoaded
}

function routerStub(pushed: string[], replaced: string[]) {
  return {
    push: (to: string) => {
      pushed.push(to)
      return Promise.resolve()
    },
    replace: (to: string) => {
      replaced.push(to)
      return Promise.resolve()
    },
  }
}

describe('URL startup recovery', () => {
  let pinia: Pinia
  let worker: FakeWorker
  let pushed: string[]
  let replaced: string[]

  function mountExplorer(query: Record<string, string>) {
    return mount(ExplorerPage, {
      global: {
        plugins: [pinia],
        provide: {
          [routerKey]: routerStub(pushed, replaced),
          [routeLocationKey]: makeRoute(query),
        },
        stubs: { 'nuxt-link': true },
      },
    })
  }

  function mountLanding(query: Record<string, string>) {
    return mount(IndexPage, {
      global: {
        plugins: [pinia],
        provide: {
          [routerKey]: routerStub(pushed, replaced),
          [routeLocationKey]: makeRoute(query, '/'),
        },
        stubs: { 'nuxt-link': true },
      },
    })
  }

  /** The landing onMounted is async (bootstrap consume, then recovery
   *  prefill): give the microtask chain a few rounds. */
  async function settle(): Promise<void> {
    await flushPromises()
    await flushPromises()
  }

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    resetJsonlEngineForTests()
    useUrlRecovery().clearRecoveredUrl()
    worker = new FakeWorker()
    useJsonlEngine({ workerFactory: () => worker as unknown as Worker })
    pushed = []
    replaced = []
  })

  it('recovers the URL to memory when bootstrap loading fails', async () => {
    const wrapper = mountExplorer({ url: 'https://example.com/data.jsonl' })
    await vi.waitFor(() => expect(worker.posted.length).toBe(1))
    const request = worker.posted[0] as PostedInit
    expect(request.url).toBe('https://example.com/data.jsonl')

    worker.emit(
      failure(
        request.requestId as string,
        'URL_CORS_DENIED',
        'Could not fetch https://example.com/data.jsonl: the server may not ' +
          'allow cross-origin access (CORS) or the network request failed',
      ),
    )
    await flushPromises()

    // Typed message in the toast (worker already redacted the URL).
    const toastStore = useToastStore()
    const errorToast = toastStore.toasts.find((t) => t.type === 'error')
    expect(errorToast?.message).toContain('Could not fetch https://example.com/data.jsonl')

    // Back on landing, with the URL available for retry — memory only.
    expect(pushed).toEqual(['/'])
    // The query was scrubbed (router.replace) before the load started.
    expect(replaced).toEqual(['/explorer'])
    expect(useUrlRecovery().consumeRecoveredUrl()).toBe('https://example.com/data.jsonl')
    // Consumed: a second read is empty.
    expect(useUrlRecovery().consumeRecoveredUrl()).toBeNull()
    wrapper.unmount()
  })

  it('rejects a bootstrap URL with embedded credentials without touching the worker', async () => {
    const wrapper = mountExplorer({ url: 'https://user:pass@example.com/data.jsonl' })
    await flushPromises()

    expect(worker.posted.length).toBe(0)
    expect(pushed).toEqual(['/'])
    expect(replaced).toEqual([]) // invalid: no scrub needed, the push leaves the query
    const toastStore = useToastStore()
    const errorToast = toastStore.toasts.find((t) => t.type === 'error')
    expect(errorToast?.message).toContain('embedded credentials')
    expect(useUrlRecovery().consumeRecoveredUrl()).toBeNull()
    wrapper.unmount()
  })

  it('scrubs (router.replace) BEFORE the load request reaches the worker', async () => {
    const order: string[] = []
    const realPost = worker.postMessage.bind(worker)
    worker.postMessage = (message: unknown, transfer?: Transferable[]) => {
      order.push(`post:${(message as { type?: string }).type}`)
      return realPost(message, transfer)
    }

    const wrapper = mount(ExplorerPage, {
      global: {
        plugins: [pinia],
        provide: {
          [routerKey]: {
            push: (to: string) => {
              pushed.push(to)
              return Promise.resolve()
            },
            replace: (to: string) => {
              order.push(`replace:${to}`)
              return Promise.resolve()
            },
          },
          [routeLocationKey]: makeRoute({ url: 'https://example.com/data.jsonl' }),
        },
        stubs: { 'nuxt-link': true },
      },
    })
    await vi.waitFor(() => expect(order).toContain('post:initUrl'))

    // The scrub (replace to the same path without the query) happened
    // before any worker traffic: the signed URL never coexists with the
    // load in the address bar / router state.
    expect(order.indexOf('replace:/explorer')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('replace:/explorer')).toBeLessThan(order.indexOf('post:initUrl'))
    const init = worker.posted[0] as PostedInit
    worker.emit(success(init.requestId, { name: 'data.jsonl', size: 1, type: 'url' }))
    await flushPromises()
    expect(pushed).toEqual([]) // stays on /explorer with the file
    expect(useFileStore().hasFile).toBe(true)
    wrapper.unmount()
  })

  it('keeps a literal % in the bootstrap URL intact (no double-decode)', async () => {
    // route.query is already decoded once: this value contains a literal %.
    const wrapper = mountExplorer({ url: 'https://example.com/100%.jsonl' })
    await vi.waitFor(() => expect(worker.posted.length).toBe(1))
    const request = worker.posted[0] as PostedInit
    expect(request.url).toBe('https://example.com/100%.jsonl')
    worker.emit(
      success(request.requestId as string, { name: '100%.jsonl', size: 1, type: 'url' }),
    )
    await flushPromises()
    expect(pushed).toEqual([])
    expect(useFileStore().hasFile).toBe(true)
    wrapper.unmount()
  })

  it('redirects to landing when no bootstrap and no file exist', async () => {
    const wrapper = mountExplorer({})
    await flushPromises()

    expect(worker.posted.length).toBe(0)
    expect(pushed).toEqual(['/'])
    const toastStore = useToastStore()
    expect(toastStore.toasts.some((t) => t.type === 'info')).toBe(true)
    wrapper.unmount()
  })

  it('stays on /explorer when a file is already loaded (initialized navigation)', async () => {
    const fileStore = useFileStore()
    const pending = fileStore.loadFile(new File(['a\n'], 'a.jsonl'))
    await vi.waitFor(() => expect(worker.posted.length).toBe(1))
    const init = worker.posted[0] as PostedInit
    worker.emit(success(init.requestId as string, { name: 'a.jsonl', size: 2, type: 'file' }))
    await pending

    const wrapper = mountExplorer({})
    await flushPromises()

    // No redirect, no toast, no bootstrap: the guard passes on hasFile.
    expect(pushed).toEqual([])
    const toastStore = useToastStore()
    expect(toastStore.toasts.length).toBe(0)
    expect(wrapper.find('[data-testid="upload-another"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('opens the URL modal prefilled on the landing page after a failure', async () => {
    // Simulate the explorer bootstrap failure handoff.
    useUrlRecovery().setRecoveredUrl('https://recovered.example.com/data.jsonl')

    const wrapper = mountLanding({})
    await vi.waitFor(
      () => expect(document.body.querySelector('input[type="url"]')).toBeTruthy(),
    )

    // The modal (teleported to body) is open with the URL prefilled.
    const urlField = document.body.querySelector('input[type="url"]') as HTMLInputElement
    expect(urlField.value).toBe('https://recovered.example.com/data.jsonl')

    // The handoff was consumed exactly once.
    expect(useUrlRecovery().consumeRecoveredUrl()).toBeNull()

    // The recovered URL never entered router state.
    expect(pushed).toEqual([])
    wrapper.unmount()
    document.body.innerHTML = ''
  })

  it('does not open the modal on a normal landing visit', async () => {
    const wrapper = mountLanding({})
    await settle()

    expect(document.body.querySelector('input[type="url"]')).toBeNull()
    wrapper.unmount()
    document.body.innerHTML = ''
  })

  it('CLI capability URL on / (?url=): loads, scrubs, lands on /explorer', async () => {
    const wrapper = mountLanding({
      url: 'http://127.0.0.1:8123/capability-123/file.jsonl',
    })
    await vi.waitFor(() => expect(worker.posted.length).toBe(1))
    const init = worker.posted[0] as PostedInit
    expect(init.url).toBe('http://127.0.0.1:8123/capability-123/file.jsonl')
    worker.emit(success(init.requestId, { name: 'file.jsonl', size: 3, type: 'url' }))
    await flushPromises()

    // Scrubbed in place (no query in the router state), then navigated.
    expect(replaced).toEqual(['/'])
    expect(pushed).toEqual(['/explorer'])
    expect(useFileStore().hasFile).toBe(true)
    wrapper.unmount()
  })

  it('failed CLI capability URL: retry modal opens prefilled on landing', async () => {
    const wrapper = mountLanding({
      url: 'http://127.0.0.1:8123/capability-123/file.jsonl',
    })
    await vi.waitFor(() => expect(worker.posted.length).toBe(1))
    const init = worker.posted[0] as PostedInit
    worker.emit(failure(init.requestId, 'URL_NETWORK_ERROR', 'Could not reach the local CLI server'))
    await vi.waitFor(
      () => expect(document.body.querySelector('input[type="url"]')).toBeTruthy(),
    )

    // Already on landing (the replace kept us here; the failure push is a
    // no-op navigation to the same place) — and the retry modal is open
    // with the URL prefilled (memory only).
    expect(replaced).toEqual(['/'])
    const urlField = document.body.querySelector('input[type="url"]') as HTMLInputElement | null
    expect(urlField).toBeTruthy()
    expect(urlField?.value).toBe('http://127.0.0.1:8123/capability-123/file.jsonl')
    expect(useUrlRecovery().consumeRecoveredUrl()).toBeNull()
    wrapper.unmount()
    document.body.innerHTML = ''
  })
})
