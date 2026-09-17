import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { routerKey } from 'vue-router'
import FileDropZone from '~/components/landing/FileDropZone.vue'
import { useToastStore } from '~/stores/toasts'
import { useFileStore } from '~/stores/file'
import { useJsonlEngine, resetJsonlEngineForTests } from '~/composables/useJsonlEngine'
import { AutoWorker, failure } from '../helpers/fakeWorker'

/**
 * Component integration: the drop zone is mounted with the real stores,
 * the real engine composable (fake worker injected), and a stub router —
 * so picker/drop flows run end-to-end down to the RPC boundary.
 */

let pinia: Pinia
let push: ReturnType<typeof vi.fn>
let workers: AutoWorker[]
let injected: AutoWorker | null
let clickSpy: MockInstance

/**
 * Mounts the zone and flushes the post-render queue: template refs are
 * assigned in a post-render effect, so interactions only work afterwards.
 */
async function mountZone(): Promise<VueWrapper> {
  const wrapper = mount(FileDropZone, {
    global: {
      plugins: [pinia],
      provide: { [routerKey]: { push } },
    },
  })
  await nextTick()
  return wrapper
}

function setPickedFiles(wrapper: VueWrapper, files: File[]): void {
  const input = wrapper.find('input[type="file"]')
  Object.defineProperty(input.element, 'files', { value: files, configurable: true })
}

function toastsOfType(type: 'info' | 'success' | 'warning' | 'error') {
  return useToastStore()
    .toasts.filter((t) => t.type === type)
    .map((t) => t.message)
}

beforeEach(() => {
  resetJsonlEngineForTests()
  workers = []
  injected = null
  pinia = createPinia()
  setActivePinia(pinia)
  push = vi.fn().mockResolvedValue(undefined)
  // First call wires the fake worker factory into the engine singleton.
  useJsonlEngine({
    workerFactory: () => {
      const worker = injected ?? new AutoWorker()
      injected = null
      workers.push(worker)
      return worker as unknown as Worker
    },
  })
  clickSpy = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})
})

afterEach(() => {
  clickSpy.mockRestore()
})

describe('picker flow', () => {
  it('opens a valid file through the worker and navigates only after success', async () => {
    const wrapper = await mountZone()
    setPickedFiles(wrapper, [new File(['{"a":1}\n'], 'data.jsonl')])

    await wrapper.find('input[type="file"]').trigger('change')
    await flushPromises()

    expect(push).toHaveBeenCalledWith('/explorer')
    const fileStore = useFileStore()
    expect(fileStore.hasFile).toBe(true)
    expect(fileStore.fileName).toBe('data.jsonl')
  })

  it('does not navigate when the worker rejects the load (typed error toast)', async () => {
    const worker = new AutoWorker({ gate: ['initFile'] })
    injected = worker
    const wrapper = await mountZone()
    setPickedFiles(wrapper, [new File(['{"a":1}\n'], 'broken.jsonl')])

    await wrapper.find('input[type="file"]').trigger('change')
    await flushPromises()
    expect(push).not.toHaveBeenCalled()

    const initMessage = worker.posted.find((m) => (m as { type?: string }).type === 'initFile') as {
      requestId: string
    }
    worker.emit(failure(initMessage.requestId, 'SOURCE_INVALID', 'File could not be read'))
    await flushPromises()

    expect(push).not.toHaveBeenCalled()
    expect(toastsOfType('error')).toEqual(['File could not be read'])
    expect(useFileStore().hasFile).toBe(false)
  })

  it('warns on multiple files and opens the first one', async () => {
    const wrapper = await mountZone()
    setPickedFiles(wrapper, [new File(['a\n'], 'first.jsonl'), new File(['b\n'], 'second.jsonl')])

    await wrapper.find('input[type="file"]').trigger('change')
    await flushPromises()

    expect(push).toHaveBeenCalled()
    expect(useFileStore().fileName).toBe('first.jsonl')
    expect(toastsOfType('warning').some((m) => /first one/i.test(m))).toBe(true)
  })

  it('warns on unusual extensions but still opens', async () => {
    const wrapper = await mountZone()
    setPickedFiles(wrapper, [new File(['x\n'], 'weird.xyz')])

    await wrapper.find('input[type="file"]').trigger('change')
    await flushPromises()

    expect(push).toHaveBeenCalled()
    expect(useFileStore().fileName).toBe('weird.xyz')
    expect(toastsOfType('warning').some((m) => /\.xyz/.test(m))).toBe(true)
  })
})

describe('edge cases', () => {
  it('rejects zero-byte files with a warning and no navigation', async () => {
    const wrapper = await mountZone()
    setPickedFiles(wrapper, [new File([], 'empty.jsonl')])

    await wrapper.find('input[type="file"]').trigger('change')
    await flushPromises()

    expect(push).not.toHaveBeenCalled()
    expect(workers).toHaveLength(0) // no worker ever spawned
    expect(toastsOfType('warning').some((m) => /0 bytes/i.test(m))).toBe(true)
    expect(useFileStore().hasFile).toBe(false)
  })

  it('keyboard: Enter/Space on the zone opens the picker', async () => {
    const wrapper = await mountZone()
    await wrapper.trigger('keydown.enter')
    expect(clickSpy).toHaveBeenCalledTimes(1)
    await wrapper.trigger('keydown.space')
    expect(clickSpy).toHaveBeenCalledTimes(2)
  })

  it('drag hover state toggles on dragover/dragleave', async () => {
    const wrapper = await mountZone()
    // `bg-primary/10` marks the active drag state (the base classes only
    // carry `hover:border-primary/50`).
    expect((wrapper.element as HTMLElement).className).not.toContain('bg-primary/10')

    await wrapper.trigger('dragover', { dataTransfer: { files: [], items: [] } })
    expect((wrapper.element as HTMLElement).className).toContain('bg-primary/10')
    await wrapper.trigger('dragleave', { relatedTarget: document.body, dataTransfer: { files: [], items: [] } })
    expect((wrapper.element as HTMLElement).className).not.toContain('bg-primary/10')
  })
})

describe('drop flow', () => {
  it('opens a dropped file through the worker and navigates', async () => {
    const wrapper = await mountZone()
    await wrapper.trigger('drop', {
      dataTransfer: {
        files: [new File(['{"a":1}\n'], 'dropped.jsonl')],
        items: [{ kind: 'file', webkitGetAsEntry: () => ({ isDirectory: false, isFile: true }) }],
      },
    })
    await flushPromises()

    expect(push).toHaveBeenCalledWith('/explorer')
    expect(useFileStore().fileName).toBe('dropped.jsonl')
  })

  it('rejects directory drops with a warning and no navigation', async () => {
    const wrapper = await mountZone()
    await wrapper.trigger('drop', {
      dataTransfer: {
        files: [],
        items: [{ kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true, isFile: false }) }],
      },
    })
    await flushPromises()

    expect(push).not.toHaveBeenCalled()
    expect(workers).toHaveLength(0)
    expect(toastsOfType('warning').some((m) => /directories/i.test(m))).toBe(true)
  })

  it('rejects non-file drops (plain text/links) with a warning', async () => {
    const wrapper = await mountZone()
    await wrapper.trigger('drop', {
      dataTransfer: { files: [], items: [{ kind: 'string' }] },
    })
    await flushPromises()

    expect(push).not.toHaveBeenCalled()
    expect(workers).toHaveLength(0)
    expect(toastsOfType('warning').some((m) => /only file drops/i.test(m))).toBe(true)
  })

  it('drop of multiple files warns and opens the first', async () => {
    const wrapper = await mountZone()
    await wrapper.trigger('drop', {
      dataTransfer: {
        files: [new File(['a\n'], 'd1.jsonl'), new File(['b\n'], 'd2.jsonl')],
        items: [
          { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: false, isFile: true }) },
          { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: false, isFile: true }) },
        ],
      },
    })
    await flushPromises()

    expect(push).toHaveBeenCalled()
    expect(useFileStore().fileName).toBe('d1.jsonl')
    expect(toastsOfType('warning').some((m) => /first one/i.test(m))).toBe(true)
  })
})
