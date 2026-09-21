/**
 * UrlOpenModal component-integration tests.
 *
 * Real Pinia stores + real engine composable (fake worker) + stub router.
 * The modal content is teleported to `document.body`, so all DOM access
 * goes through body-scoped queries (VTU `find` does not reach teleports).
 *
 * The security-critical assertions verify that header values that look
 * like credentials never appear in toast text, router state, or
 * serialized store state — only in the worker-bound init request.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { nextTick } from 'vue'
import { routerKey } from 'vue-router'
import UrlOpenModal from '~/components/landing/UrlOpenModal.vue'
import { useJsonlEngine, resetJsonlEngineForTests } from '~/composables/useJsonlEngine'
import { useFileStore } from '~/stores/file'
import { useToastStore } from '~/stores/toasts'
import { FakeWorker, success, failure } from '../helpers/fakeWorker'

const SECRET = 'sk-super-secret-value'

/** Shape of the posted initUrl RPC (subset of the protocol request). */
interface PostedInit {
  type: string
  requestId: string
  url: string
  headers?: Record<string, string>
}

/** Body-scoped DOM access (the modal is teleported to body). */
function urlInput(): HTMLInputElement {
  return document.body.querySelector('input[type="url"]')!
}

function openButton(): HTMLButtonElement {
  return document.body.querySelector('button.btn-primary')!
}

function cancelButton(): HTMLButtonElement {
  const buttons = Array.from(document.body.querySelectorAll('button'))
  return buttons.find((b) => b.textContent?.trim() === 'Cancel')!
}

function addHeaderButton(): HTMLButtonElement {
  return document.body.querySelector('button[aria-label="Add header"]')!
}

/** Row r: name at 1+2r, value at 2+2r (input 0 is the URL field). */
function rowInputs(row: number): [HTMLInputElement, HTMLInputElement] {
  const inputs = Array.from(document.body.querySelectorAll('input'))
  return [
    inputs[1 + row * 2] as HTMLInputElement,
    inputs[2 + row * 2] as HTMLInputElement,
  ]
}

async function setValue(input: HTMLInputElement, value: string): Promise<void> {
  input.value = value
  await input.dispatchEvent(new Event('input'))
}

async function setUrl(value: string): Promise<void> {
  await setValue(urlInput(), value)
}

async function setHeader(row: number, name: string, value: string): Promise<void> {
  const [nameInput, valueInput] = rowInputs(row)
  await setValue(nameInput, name)
  await setValue(valueInput, value)
}

describe('UrlOpenModal', () => {
  let pinia: Pinia
  let worker: FakeWorker
  let pushed: string[]
  let wrapper: VueWrapper

  function mountModal(props: Record<string, unknown> = {}) {
    wrapper = mount(UrlOpenModal, {
      props: { open: true, ...props },
      global: {
        plugins: [pinia],
        provide: {
          [routerKey]: { push: (to: string) => { pushed.push(to); return Promise.resolve() } },
        },
      },
    })
    return wrapper
  }

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    resetJsonlEngineForTests()
    worker = new FakeWorker()
    useJsonlEngine({ workerFactory: () => worker as unknown as Worker })
    pushed = []
  })

  afterEach(() => {
    wrapper?.unmount()
    document.body.innerHTML = ''
  })

  it('sends the normalized URL and headers to the worker, then navigates', async () => {
    mountModal()
    await nextTick()

    await setUrl('  https://Example.com:443/data.jsonl?x=1  ')
    await setHeader(0, ' Authorization ', `Bearer ${SECRET}`)
    expect(openButton().disabled).toBe(false)

    openButton().click()
    await vi.waitFor(() => expect(worker.posted.length).toBe(1))
    const request = worker.posted[0] as PostedInit
    expect(request.type).toBe('initUrl')
    // Normalized: trimmed, lowercase host, default port stripped, query kept.
    expect(request.url).toBe('https://example.com/data.jsonl?x=1')
    expect(request.headers).toEqual({ Authorization: `Bearer ${SECRET}` })

    worker.emit(
      success(request.requestId as string, { name: 'data.jsonl', size: 128, type: 'url' }),
    )
    await flushPromises()

    expect(pushed).toEqual(['/explorer'])
    expect(wrapper.emitted('update:open')?.[0]).toEqual([false])
    const fileStore = useFileStore()
    expect(fileStore.hasFile).toBe(true)
    expect(fileStore.fileName).toBe('data.jsonl')
    expect(fileStore.metadata?.url).toBe('https://example.com/data.jsonl?x=1')
  })

  it.each([
    ['ftp://example.com/a.jsonl', 'Only HTTP and HTTPS'],
    ['https://user:pass@example.com/a.jsonl', 'embedded credentials'],
    ['https://example.com/a.jsonl#frag', 'fragments'],
    ['not a url', 'Invalid URL format'],
  ])('blocks %s with an actionable message', async (input, expected) => {
    mountModal()
    await nextTick()

    await setUrl(input)
    const errorText = document.body.querySelector('p[role="alert"]')!.textContent ?? ''
    expect(errorText).toContain(expected)
    expect(openButton().disabled).toBe(true)

    openButton().click()
    await nextTick()
    expect(worker.posted.length).toBe(0)
    expect(pushed).toEqual([])
  })

  it('blocks duplicate, forbidden, and CR/LF-injecting headers with row errors', async () => {
    mountModal()
    await nextTick()

    await setHeader(0, 'X-Api-Key', 'a')
    addHeaderButton().click()
    await nextTick()
    await setHeader(1, 'x-api-key', 'b')
    addHeaderButton().click()
    await nextTick()
    await setHeader(2, 'Host', 'evil')
    addHeaderButton().click()
    await nextTick()
    // (CR/LF injection is covered at the decideHeaderRow unit level:
    // happy-dom strips line breaks from input values, so it cannot be
    // exercised through the DOM here.)
    await setUrl('https://example.com/a.jsonl')

    const text = document.body.textContent ?? ''
    expect(text).toContain('Duplicate header: x-api-key')
    expect(text).toContain('forbidden by the browser')
    expect(openButton().disabled).toBe(true)

    openButton().click()
    await nextTick()
    expect(worker.posted.length).toBe(0)
  })

  it('warns and masks credential-like header values', async () => {
    mountModal()
    await nextTick()

    expect(document.body.textContent).not.toContain('Credential notice')
    await setHeader(0, 'Authorization', `Bearer ${SECRET}`)

    expect(document.body.textContent).toContain('Credential notice')
    expect(document.body.textContent).toContain('kept in memory only')
    // The value field is masked for credential-like rows.
    expect(rowInputs(0)[1].type).toBe('password')

    // Non-credential rows stay visible.
    addHeaderButton().click()
    await nextTick()
    await setHeader(1, 'X-Custom', 'plain')
    expect(rowInputs(1)[1].type).toBe('text')
  })

  it('keeps secrets out of toasts, router state, and store state on failure', async () => {
    mountModal()
    await nextTick()

    await setUrl('https://example.com/secret.jsonl')
    await setHeader(0, 'Authorization', `Bearer ${SECRET}`)
    openButton().click()
    await vi.waitFor(() => expect(worker.posted.length).toBe(1))

    const request = worker.posted[0] as PostedInit
    // The header value DOES travel to the worker (it is needed for the
    // fetch) — that is the only place it may appear.
    expect(JSON.stringify(request)).toContain(SECRET)

    worker.emit(
      failure(
        request.requestId as string,
        'URL_CORS_DENIED',
        'Could not fetch https://example.com/secret.jsonl: the server may not ' +
          'allow cross-origin access (CORS) or the network request failed',
      ),
    )
    await flushPromises()

    const toastStore = useToastStore()
    const errorToast = toastStore.toasts.find((t) => t.type === 'error')
    expect(errorToast).toBeTruthy()
    expect(errorToast?.message).not.toContain(SECRET)
    expect(JSON.stringify(toastStore.toasts)).not.toContain(SECRET)

    // Router state: no navigation happened (stayed on landing), and the
    // pushed paths never carried the secret.
    expect(pushed).toEqual([])

    // Serialized store state: metadata + errors must not echo the value.
    const fileStore = useFileStore(pinia)
    expect(JSON.stringify(fileStore.$state)).not.toContain(SECRET)

    // Recovery in place: the modal stays open with the entered URL so the
    // user can retry (form is preserved, not reset).
    expect(document.body.querySelector('.modal-box')).toBeTruthy()
    expect(urlInput().value).toBe('https://example.com/secret.jsonl')
  })

  it('shows download and index progress during the load', async () => {
    mountModal()
    await nextTick()

    await setUrl('https://example.com/data.jsonl')
    openButton().click()
    await vi.waitFor(() => expect(worker.posted.length).toBe(1))
    const request = worker.posted[0] as PostedInit & { operationId: string }

    worker.emit({
      ns: 'jsonl-explorer',
      v: 1,
      type: 'urlProgress',
      operationId: request.operationId,
      receivedBytes: 512,
      totalBytes: 2048,
    })
    await nextTick()
    let text = document.body.textContent ?? ''
    expect(text).toContain('Downloading data.jsonl')
    expect(text).toContain('25%')

    worker.emit({
      ns: 'jsonl-explorer',
      v: 1,
      type: 'indexProgress',
      operationId: request.operationId,
      progress: 10,
      committedRows: 12,
      committedBytes: 256,
      rowsProcessed: 12,
      totalBytes: 2048,
    })
    await nextTick()
    text = document.body.textContent ?? ''
    // Both phases are visible at once.
    expect(text).toContain('Downloading data.jsonl')
    expect(text).toContain('Indexing')
    expect(text).toContain('12 rows')

    // Complete the load: the panel goes away.
    worker.emit(
      success(request.requestId as string, { name: 'data.jsonl', size: 2048, type: 'url' }),
    )
    await flushPromises()
    text = document.body.textContent ?? ''
    expect(text).not.toContain('Downloading')
    expect(pushed).toEqual(['/explorer'])
  })

  it('cancels the in-flight load and keeps the form for a retry', async () => {
    mountModal()
    await nextTick()

    await setUrl('https://example.com/data.jsonl')
    openButton().click()
    await vi.waitFor(() => expect(worker.posted.length).toBe(1))
    const request = worker.posted[0] as PostedInit & { operationId: string }

    const cancel = document.body.querySelector('button[data-testid="loading-cancel"]') as HTMLButtonElement
    cancel.click()
    await vi.waitFor(() =>
      expect(worker.posted.some((m) => (m as { type?: string }).type === 'cancel')).toBe(true),
    )
    const cancelMsg = worker.posted.find((m) => (m as { type?: string }).type === 'cancel') as {
      requestId: string
      operationId: string
    }
    // Operation-scoped: the cancel carries the init's operation id.
    expect(cancelMsg.operationId).toBe(request.operationId)

    worker.emit(success(cancelMsg.requestId, {}))
    worker.emit(failure(request.requestId as string, 'CANCELLED', 'Cancelled'))
    await flushPromises()

    // Not an error: an info toast, no navigation, form preserved.
    const toastStore = useToastStore()
    expect(toastStore.toasts.some((t) => t.type === 'info' && t.message === 'Load cancelled')).toBe(true)
    expect(toastStore.toasts.some((t) => t.type === 'error')).toBe(false)
    expect(pushed).toEqual([])
    expect(document.body.querySelector('.modal-box')).toBeTruthy()
    expect(urlInput().value).toBe('https://example.com/data.jsonl')
  })

  it('prefills a recovered URL on first open only', async () => {
    const recovered = 'https://recovered.example.com/data.jsonl'
    mountModal({ initialUrl: recovered })
    await nextTick()

    expect(urlInput().value).toBe(recovered)

    // Close (cancels) and reopen: the form resets and does not re-prefill.
    // (The emit('update:open', false) is asserted below; the test drives
    // the prop itself, standing in for the parent's v-model binding.)
    cancelButton().click()
    await nextTick()
    expect(wrapper.emitted('update:open')?.[0]).toEqual([false])
    await wrapper.setProps({ open: false })
    await nextTick()
    expect(document.body.querySelector('.modal-box')).toBeNull()

    await wrapper.setProps({ open: true })
    await nextTick()
    expect(urlInput().value).toBe('')
  })
})
