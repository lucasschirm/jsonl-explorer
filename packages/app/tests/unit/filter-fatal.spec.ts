/**
 * Filter failure integration (TSK0029): a worker crash mid-filter must
 * fail loudly with a typed EngineFatalError (no silent hang, no half
 * applied state), flip the engine into the fatal UI state, and allow a
 * clean recovery (new worker, re-opened source, working filter).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { useJsonlEngine, resetJsonlEngineForTests } from '~/composables/useJsonlEngine'
import { useFilterStore } from '~/stores/filter'
import { EngineFatalError } from '~/engine/workerClient'
import { AutoWorker, type FakeWorker } from '../helpers/fakeWorker'

describe('worker failure during a filter (TSK0029)', () => {
  let pinia: Pinia
  let engineApi: ReturnType<typeof useJsonlEngine>
  let filterStore: ReturnType<typeof useFilterStore>
  const workers: FakeWorker[] = []

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    resetJsonlEngineForTests()
    workers.length = 0
    // First worker gates 'filter' (so a run can be "in flight"); the
    // recovered worker answers everything.
    engineApi = useJsonlEngine({
      workerFactory: () => {
        const worker = new AutoWorker(workers.length === 0 ? { gate: ['filter'] } : {})
        workers.push(worker)
        return worker as unknown as Worker
      },
    })
    filterStore = useFilterStore()
  })

  it('a mid-filter crash rejects typed, sets the fatal state, and recovers cleanly', async () => {
    const open = engineApi.open('file', new File(['a\n'], 'crash.jsonl'))
    await vi.waitFor(() => expect(workers[0]?.posted.length).toBeGreaterThan(0))
    await open

    // Start a filter; the first worker holds it (in flight).
    const running = filterStore.runFilter('x', 'text')
    await vi.waitFor(() => expect(workers[0]!.posted.length).toBeGreaterThan(1))
    expect(filterStore.status).toBe('running')

    // The worker dies.
    workers[0]!.fail()

    await expect(running).rejects.toBeInstanceOf(EngineFatalError)
    expect(engineApi.fatal.value).toBe(true)
    expect(engineApi.fatalMessage.value).toMatch(/crashed/i)
    // The store surfaced a typed error state (never silent).
    expect(filterStore.status).toBe('error')
    expect(filterStore.error).toMatch(/crashed|fatal/i)

    // The dead worker is terminated on recovery; a fresh worker is used.
    await engineApi.recoverFromFatal()
    expect(workers[0]!.terminated).toBe(1)
    expect(engineApi.fatal.value).toBe(false)

    // Re-open the source on the new worker, then filter again.
    await engineApi.open('file', new File(['a\n'], 'crash.jsonl'))
    expect(workers[1]).toBeDefined()

    const result = await filterStore.runFilter('y', 'text')
    expect(filterStore.status).toBe('idle')
    expect(result).toMatchObject({ matchedRows: 3, totalRows: 10 })
  })
})
