/**
 * StatusBar (TSK0023): total/filtered counts from worker snapshots,
 * partial-index marker, and one-line pipeline state (indexing with
 * percent, paused, failed, filtering).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import StatusBar from '~/components/explorer/StatusBar.vue'
import { useJsonlEngine, resetJsonlEngineForTests } from '~/composables/useJsonlEngine'
import { useFilterStore } from '~/stores/filter'
import { useRowStore } from '~/stores/rows'
import { FakeWorker, success, failure } from '../helpers/fakeWorker'

interface PostedOp {
  type: string
  requestId?: string
  operationId?: string
}

describe('StatusBar (TSK0023)', () => {
  let pinia: Pinia
  let worker: FakeWorker
  let wrapper: VueWrapper<InstanceType<typeof StatusBar>>

  const text = (testId: string): string => {
    const el = wrapper.find(`[data-testid="${testId}"]`)
    return el.exists() ? el.text() : ''
  }

  const exists = (testId: string): boolean => wrapper.find(`[data-testid="${testId}"]`).exists()

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    resetJsonlEngineForTests()
    worker = new FakeWorker()
    useJsonlEngine({ workerFactory: () => worker as unknown as Worker })
    wrapper = mount(StatusBar, { global: { plugins: [pinia] } })
  })

  async function initSource(): Promise<void> {
    const pending = useJsonlEngine().open('file', new File(['a\n'], 't.jsonl'))
    await vi.waitFor(() => {
      expect(worker.posted.some((m) => (m as PostedOp).type === 'initFile')).toBe(true)
    })
    const op = worker.posted.find((m) => (m as PostedOp).type === 'initFile') as PostedOp
    worker.emit(success(op.requestId!, { name: 't.jsonl', size: 2, type: 'file' }))
    await pending
  }

  async function postedIndexOp(): Promise<PostedOp> {
    await vi.waitFor(() => {
      expect(worker.posted.some((m) => (m as PostedOp).type === 'index')).toBe(true)
    })
    return worker.posted.find((m) => (m as PostedOp).type === 'index') as PostedOp
  }

  it('shows zero counts and no state text before anything is loaded', () => {
    expect(text('total-count')).toBe('0')
    expect(text('filtered-count')).toBe('0')
    expect(exists('state-text')).toBe(false)
    expect(exists('partial-marker')).toBe(false)
  })

  it('shows worker-snapshot counts and the partial marker while indexing', async () => {
    await initSource()

    // Index started, not committed yet: state running -> partial marker.
    void useJsonlEngine().startIndex()
    await nextTick()
    expect(exists('partial-marker')).toBe(true)
    expect(text('state-text')).toBe('Indexing…')

    // A progress event carries the percent.
    const op = await postedIndexOp()
    worker.emit({
      ns: 'jsonl-explorer',
      v: 1,
      type: 'indexProgress',
      operationId: op.operationId!,
      committedRows: 42,
      committedBytes: 420,
      totalBytes: 1000,
      progress: 42,
    })
    await nextTick()
    expect(text('state-text')).toBe('Indexing… 42%')

    // The commit updates the total from the worker snapshot (not locally).
    worker.emit({
      ns: 'jsonl-explorer',
      v: 1,
      type: 'indexComplete',
      operationId: op.operationId!,
      totalRows: 1_000_000,
      totalBytes: 100_000_000,
      durationMs: 10,
      generation: 1,
    })
    worker.emit(success(op.requestId!, { totalRows: 1_000_000, totalBytes: 100_000_000 }))
    await vi.waitFor(() => expect(text('total-count')).toBe('1,000,000'))
    expect(exists('partial-marker')).toBe(false)
    expect(exists('state-text')).toBe(false)
  })

  it('shows a paused state after cancellation', async () => {
    await initSource()
    void useJsonlEngine().startIndex()
    await nextTick()
    const op = await postedIndexOp()
    worker.emit(failure(op.requestId!, 'INDEXING_CANCELLED', 'cancelled'))
    await vi.waitFor(() => expect(text('state-text')).toBe('Indexing paused'))
  })

  it('shows a failed state when indexing errors', async () => {
    await initSource()
    void useJsonlEngine().startIndex()
    await nextTick()
    const op = await postedIndexOp()
    worker.emit(failure(op.requestId!, 'internal', 'disk full'))
    await vi.waitFor(() => expect(text('state-text')).toBe('Indexing failed'))
  })

  it('shows filtering progress while a filter runs (highest priority)', async () => {
    await initSource()
    const rowStore = useRowStore()
    rowStore.totalFiltered = 5

    const filterStore = useFilterStore()
    filterStore.status = 'running'
    filterStore.progress = { scannedRows: 1200, matchedRows: 34, totalRows: 5000 }
    await nextTick()
    expect(text('state-text')).toBe('Filtering… 1,200 scanned, 34 matched')
    expect(text('filtered-count')).toBe('5')
  })
})
