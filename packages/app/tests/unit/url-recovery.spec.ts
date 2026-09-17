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
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { nextTick } from 'vue'
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

function makeRoute(query: Record<string, string>): RouteLocationNormalizedLoaded {
  return { query } as unknown as RouteLocationNormalizedLoaded
}

function routerStub(pushed: string[]) {
  return { push: (to: string) => { pushed.push(to); return Promise.resolve() } }
}

describe('URL startup recovery', () => {
  let pinia: Pinia
  let worker: FakeWorker
  let pushed: string[]

  function mountExplorer(query: Record<string, string>) {
    return mount(ExplorerPage, {
      global: {
        plugins: [pinia],
        provide: {
          [routerKey]: routerStub(pushed),
          [routeLocationKey]: makeRoute(query),
        },
        stubs: { 'nuxt-link': true },
      },
    })
  }

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    resetJsonlEngineForTests()
    useUrlRecovery().clearRecoveredUrl()
    worker = new FakeWorker()
    useJsonlEngine({ workerFactory: () => worker as unknown as Worker })
    pushed = []
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
    const toastStore = useToastStore()
    const errorToast = toastStore.toasts.find((t) => t.type === 'error')
    expect(errorToast?.message).toContain('embedded credentials')
    expect(useUrlRecovery().consumeRecoveredUrl()).toBeNull()
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

  it('opens the URL modal prefilled on the landing page after a failure', async () => {
    // Simulate the explorer bootstrap failure handoff.
    useUrlRecovery().setRecoveredUrl('https://recovered.example.com/data.jsonl')

    const wrapper: VueWrapper = mount(IndexPage, {
      global: {
        plugins: [pinia],
        provide: { [routerKey]: routerStub(pushed) },
        stubs: { 'nuxt-link': true },
      },
    })
    await nextTick()

    // The modal (teleported to body) is open with the URL prefilled.
    const urlField = document.body.querySelector('input[type="url"]') as HTMLInputElement
    expect(urlField).toBeTruthy()
    expect(urlField.value).toBe('https://recovered.example.com/data.jsonl')

    // The handoff was consumed exactly once.
    expect(useUrlRecovery().consumeRecoveredUrl()).toBeNull()

    // The recovered URL never entered router state.
    expect(pushed).toEqual([])
    wrapper.unmount()
    document.body.innerHTML = ''
  })

  it('does not open the modal on a normal landing visit', async () => {
    const wrapper = mount(IndexPage, {
      global: {
        plugins: [pinia],
        provide: { [routerKey]: routerStub(pushed) },
        stubs: { 'nuxt-link': true },
      },
    })
    await nextTick()

    expect(document.body.querySelector('input[type="url"]')).toBeNull()
    wrapper.unmount()
    document.body.innerHTML = ''
  })
})
