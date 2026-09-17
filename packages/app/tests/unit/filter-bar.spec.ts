/**
 * Filter bar (TSK0028): explicit-run filtering UI.
 *
 * - Typing NEVER filters: no filter RPC until Enter or the run button.
 * - Enter / run click post a `filter` RPC with the chosen kind.
 * - An empty query on run, or the × button, posts `clearFilter` (reset to
 *   the unfiltered view) — never a filter RPC.
 * - While running: progress + cancel are shown; cancel posts a `cancel`
 *   for the running operation.
 * - A compile failure (FILTER_FAILED) keeps the previous result and shows
 *   ONE actionable toast with the error message.
 * - Row errors (invalid JSON / jq runtime) are summarized ONCE: a single
 *   info toast with the count + first error, plus a persistent marker.
 * - A partial result (indexing live) is labeled.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import FilterBar from '~/components/explorer/FilterBar.vue'
import { useFilterStore } from '~/stores/filter'
import { useToastStore } from '~/stores/toasts'
import { useJsonlEngine, resetJsonlEngineForTests } from '~/composables/useJsonlEngine'
import { FakeWorker, success, failure } from '../helpers/fakeWorker'

interface PostedOp {
  type: string
  requestId?: string
  operationId?: string
  kind?: string
  query?: string
}

describe('filter bar (TSK0028)', () => {
  let pinia: Pinia
  let worker: FakeWorker
  let wrapper: VueWrapper

  function mountBar() {
    return mount(FilterBar, {
      global: { plugins: [pinia] },
    })
  }

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    resetJsonlEngineForTests()
    worker = new FakeWorker()
    useJsonlEngine({ workerFactory: () => worker as unknown as Worker })
  })

  function answerLast(value: unknown): void {
    const last = worker.posted.at(-1) as { requestId?: string }
    worker.emit(success(last.requestId!, value))
  }

  function failLast(code: string, message: string): void {
    const last = worker.posted.at(-1) as { requestId?: string }
    worker.emit(failure(last.requestId!, code, message))
  }

  function filterRpcs(): PostedOp[] {
    return worker.posted.filter((m) => (m as PostedOp).type === 'filter') as PostedOp[]
  }

  function clearRpcs(): PostedOp[] {
    return worker.posted.filter((m) => (m as PostedOp).type === 'clearFilter') as PostedOp[]
  }

  it('typing never filters: no RPC until an explicit run', async () => {
    wrapper = mountBar()
    const input = wrapper.find('[data-testid="filter-input"]')
    await input.setValue('hello')
    await input.setValue('hello world')
    await flushPromises()
    expect(filterRpcs()).toHaveLength(0)
    expect(clearRpcs()).toHaveLength(0)
    wrapper.unmount()
  })

  it('Enter in the input runs a text filter with the typed query', async () => {
    wrapper = mountBar()
    const input = wrapper.find('[data-testid="filter-input"]')
    await input.setValue('hello')
    const pending = input.trigger('keyup.enter')
    await flushPromises()

    const rpcs = filterRpcs()
    expect(rpcs).toHaveLength(1)
    expect(rpcs[0]!.kind).toBe('text')
    expect(rpcs[0]!.query).toBe('hello')

    answerLast({ matchedRows: 2, totalRows: 10, generation: 1, partial: false })
    await pending
    await flushPromises()
    expect(wrapper.find('[data-testid="filter-result"]').text()).toContain('2 of 10 rows')
    wrapper.unmount()
  })

  it('the mode toggle picks jq; the run button runs the draft', async () => {
    wrapper = mountBar()
    await wrapper.find('[data-testid="filter-kind-jq"]').trigger('click')
    const input = wrapper.find('[data-testid="filter-input"]')
    await input.setValue('.status == "error"')
    const pending = wrapper.find('[data-testid="filter-run"]').trigger('click')
    await flushPromises()

    const rpcs = filterRpcs()
    expect(rpcs).toHaveLength(1)
    expect(rpcs[0]!.kind).toBe('jq')
    expect(rpcs[0]!.query).toBe('.status == "error"')

    answerLast({ matchedRows: 1, totalRows: 10, generation: 1, partial: false })
    await pending
    await flushPromises()
    wrapper.unmount()
  })

  it('changing the mode while typing does not run a filter', async () => {
    wrapper = mountBar()
    const input = wrapper.find('[data-testid="filter-input"]')
    await input.setValue('hello')
    await wrapper.find('[data-testid="filter-kind-jq"]').trigger('click')
    await wrapper.find('[data-testid="filter-kind-text"]').trigger('click')
    await flushPromises()
    expect(filterRpcs()).toHaveLength(0)
    wrapper.unmount()
  })

  it('an empty query on run clears the filter (no filter RPC)', async () => {
    wrapper = mountBar()
    // Establish an active filter first.
    const input = wrapper.find('[data-testid="filter-input"]')
    await input.setValue('hello')
    const run1 = input.trigger('keyup.enter')
    await flushPromises()
    answerLast({ matchedRows: 2, totalRows: 10, generation: 1, partial: false })
    await run1
    await flushPromises()
    expect(filterRpcs()).toHaveLength(1)

    // Empty the draft and run: this must post clearFilter, not a filter.
    await input.setValue('')
    const run2 = input.trigger('keyup.enter')
    await flushPromises()
    expect(filterRpcs()).toHaveLength(1)
    expect(clearRpcs()).toHaveLength(1)
    answerLast({ matchedRows: 10, totalRows: 10, generation: 2, partial: false })
    await run2
    await flushPromises()
    expect(wrapper.find('[data-testid="filter-result"]').text()).toContain('10 of 10 rows')
    wrapper.unmount()
  })

  it('the clear button posts clearFilter and empties the draft', async () => {
    wrapper = mountBar()
    const input = wrapper.find('[data-testid="filter-input"]')
    await input.setValue('hello')
    const run1 = input.trigger('keyup.enter')
    await flushPromises()
    answerLast({ matchedRows: 2, totalRows: 10, generation: 1, partial: false })
    await run1
    await flushPromises()

    const pending = wrapper.find('[data-testid="filter-clear"]').trigger('click')
    await flushPromises()
    expect(clearRpcs()).toHaveLength(1)
    answerLast({ matchedRows: 10, totalRows: 10, generation: 2, partial: false })
    await pending
    await flushPromises()
    expect((input.element as HTMLInputElement).value).toBe('')
    wrapper.unmount()
  })

  it('while running: progress + cancel show; cancel posts the operation id', async () => {
    wrapper = mountBar()
    const input = wrapper.find('[data-testid="filter-input"]')
    await input.setValue('hello')
    const pending = input.trigger('keyup.enter')
    await flushPromises()

    const rpc = filterRpcs()[0]!
    expect(wrapper.find('[data-testid="filter-progress"]').exists()).toBe(true)
    const cancelBtn = wrapper.find('[data-testid="filter-cancel"]')
    expect(cancelBtn.exists()).toBe(true)

    await cancelBtn.trigger('click')
    await flushPromises()
    const cancels = worker.posted.filter((m) => (m as PostedOp).type === 'cancel') as PostedOp[]
    expect(cancels).toHaveLength(1)
    expect(cancels[0]!.operationId).toBe(rpc.operationId)

    // Answer the FILTER rpc (the cancel rpc is the newer posted message).
    worker.emit(failure(rpc.requestId!, 'FILTER_CANCELLED', 'Filter cancelled'))
    await pending
    await flushPromises()
    expect(wrapper.find('[data-testid="filter-progress"]').exists()).toBe(false)
    expect(useFilterStore().status).toBe('idle')
    wrapper.unmount()
  })

  it('a compile failure keeps the previous result and shows ONE actionable toast', async () => {
    wrapper = mountBar()
    const input = wrapper.find('[data-testid="filter-input"]')
    await input.setValue('hello')
    const run1 = input.trigger('keyup.enter')
    await flushPromises()
    answerLast({ matchedRows: 2, totalRows: 10, generation: 1, partial: false })
    await run1
    await flushPromises()

    // A jq program that does not parse: the worker rejects with the syntax
    // error; the previous (text) result must survive.
    await wrapper.find('[data-testid="filter-kind-jq"]').trigger('click')
    await input.setValue('.a..')
    const run2 = input.trigger('keyup.enter')
    await flushPromises()
    failLast('FILTER_FAILED', 'jq: 1 syntax error (at <stdin>:1, at <top-level/>)')
    await run2 // run() swallows the failure internally (toast + state)
    await flushPromises()

    // Previous result kept: the bar still reports the text filter's view.
    expect(wrapper.find('[data-testid="filter-result"]').text()).toContain('2 of 10 rows')
    // One actionable toast with the message…
    const toasts = useToastStore().toasts
    expect(toasts).toHaveLength(1)
    expect(toasts[0]!.message).toContain('syntax error')
    expect(toasts[0]!.type).toBe('error')
    // …and the persistent inline state.
    expect(wrapper.find('[data-testid="filter-error"]').text()).toContain('syntax error')
    wrapper.unmount()
  })

  it('row errors are summarized once: one info toast + persistent marker', async () => {
    wrapper = mountBar()
    const input = wrapper.find('[data-testid="filter-input"]')
    await input.setValue('.n')
    const pending = wrapper.find('[data-testid="filter-kind-jq"]').trigger('click').then(() =>
      wrapper.find('[data-testid="filter-run"]').trigger('click'),
    )
    await flushPromises()

    answerLast({
      matchedRows: 3,
      totalRows: 5,
      generation: 1,
      partial: false,
      errorCount: 2,
      errorSummary: 'jq: error (at <stdin>:2): Cannot index number with string',
    })
    await pending
    await flushPromises()

    const toasts = useToastStore().toasts
    expect(toasts).toHaveLength(1) // ONE summary, never one toast per row
    expect(toasts[0]!.type).toBe('info')
    expect(toasts[0]!.message).toContain('2 rows skipped')
    expect(toasts[0]!.message).toContain('Cannot index number with string')
    expect(wrapper.find('[data-testid="filter-skipped"]').text()).toContain('2 skipped')
    expect(wrapper.find('[data-testid="filter-error"]').exists()).toBe(false) // not a failure
    wrapper.unmount()
  })

  it('a partial result (indexing live) is labeled and not a failure', async () => {
    wrapper = mountBar()
    const input = wrapper.find('[data-testid="filter-input"]')
    await input.setValue('n')
    const pending = input.trigger('keyup.enter')
    await flushPromises()

    answerLast({ matchedRows: 0, totalRows: 0, generation: 1, partial: true })
    await pending
    await flushPromises()

    expect(wrapper.find('[data-testid="filter-partial"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="filter-error"]').exists()).toBe(false)
    expect(useFilterStore().status).toBe('idle')
    wrapper.unmount()
  })
})
