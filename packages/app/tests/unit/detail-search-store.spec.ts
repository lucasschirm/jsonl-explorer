/**
 * Local document search store (TSK0033):
 * - text mode is fully local (matches/computed, next/prev wrap-around,
 *   navigation resets when the query or document changes) and NEVER posts
 *   an RPC;
 * - jq mode posts one runJq per user run with a SNAPSHOT of the document;
 *   stale answers (row switch or document change in flight) are ignored
 *   silently; failures set the error state and post exactly one toast;
 * - results clear on selection change and on document reload (edit).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useJsonlEngine, resetJsonlEngineForTests } from '~/composables/useJsonlEngine'
import { useDetailStore } from '~/stores/detail'
import { useDetailSearchStore } from '~/stores/detailSearch'
import { useSelectionStore } from '~/stores/selection'
import { useToastStore } from '~/stores/toasts'
import { FakeWorker, success, failure } from '../helpers/fakeWorker'

interface PostedOp {
  type?: string
  requestId?: string
  lineId?: number
  program?: string
  text?: string
}

describe('detailSearch store', () => {
  let worker: FakeWorker
  let detailStore: ReturnType<typeof useDetailStore>
  let searchStore: ReturnType<typeof useDetailSearchStore>
  let selectionStore: ReturnType<typeof useSelectionStore>
  let toastStore: ReturnType<typeof useToastStore>

  const getLineOps = (): PostedOp[] =>
    worker.posted.filter((m) => (m as PostedOp).type === 'getLine') as PostedOp[]
  const runJqOps = (): PostedOp[] =>
    worker.posted.filter((m) => (m as PostedOp).type === 'runJq') as PostedOp[]

  async function initSource(): Promise<void> {
    const pending = useJsonlEngine().open('file', new File(['a\n'], 't.jsonl'))
    await vi.waitFor(() => {
      expect(worker.posted.some((m) => (m as PostedOp).type === 'initFile')).toBe(true)
    })
    const op = worker.posted.find((m) => (m as PostedOp).type === 'initFile') as PostedOp
    worker.emit(success(op.requestId!, { name: 't.jsonl', size: 2, type: 'file' }))
    await pending
  }

  async function openRow(text: string): Promise<void> {
    selectionStore.activate(1, 0)
    await vi.waitFor(() => expect(getLineOps().length).toBe(1))
    worker.emit(success(getLineOps()[0]!.requestId!, { lineId: 1, text, isEdited: false }))
    await vi.waitFor(() => expect(detailStore.status).toBe('ready'))
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    resetJsonlEngineForTests()
    worker = new FakeWorker()
    useJsonlEngine({ workerFactory: () => worker as unknown as Worker })
    selectionStore = useSelectionStore()
    detailStore = useDetailStore()
    searchStore = useDetailSearchStore()
    toastStore = useToastStore()
  })

  // ---- text mode -----------------------------------------------------------
  it('computes matches locally and never posts an RPC', async () => {
    await initSource()
    await openRow('{"name":"alpha","tags":["x","xy"]}')

    searchStore.query = 'alpha'
    await vi.waitFor(() => expect(searchStore.matches.length).toBe(1))
    expect(searchStore.matches[0]).toEqual({ path: ['name'], kind: 'value' })
    // Text search is purely local: no search RPC of any kind was posted
    // (init/index/getLine are the ambient load, not search):
    expect(runJqOps().length).toBe(0)
    expect(
      worker.posted.some((m) => (m as PostedOp).type === 'filter' || (m as PostedOp).type === 'runJq'),
    ).toBe(false)
  })

  it('next/prev wrap around and reset on query change', async () => {
    await initSource()
    await openRow('{"a":"x","b":"x","c":"x"}')
    searchStore.query = 'x'
    await vi.waitFor(() => expect(searchStore.matches.length).toBe(3))

    expect(searchStore.currentIndex).toBe(-1)
    searchStore.prev() // from -1: wraps to the LAST match
    expect(searchStore.currentIndex).toBe(2)
    expect(searchStore.currentMatch?.path).toEqual(['c'])
    searchStore.next()
    expect(searchStore.currentIndex).toBe(0) // wraps to the first
    searchStore.next()
    expect(searchStore.currentIndex).toBe(1)

    searchStore.query = 'y' // query change resets the pointer
    await vi.waitFor(() => expect(searchStore.currentIndex).toBe(-1))
    expect(searchStore.matches.length).toBe(0)
  })

  it('matchKeys/expandKeys drive tree highlighting', async () => {
    await initSource()
    await openRow('{"outer":{"inner":"hit"}}')
    searchStore.query = 'hit'
    await vi.waitFor(() => expect(searchStore.matches.length).toBe(1))

    searchStore.next()
    expect(searchStore.currentKey).toBe(JSON.stringify(['outer', 'inner']))
    expect(searchStore.matchKeys.has(JSON.stringify(['outer', 'inner']))).toBe(true)
    // The ancestor that must be auto-expanded:
    expect(searchStore.expandKeys.has(JSON.stringify(['outer']))).toBe(true)
    expect(searchStore.expandKeys.has(JSON.stringify(['outer', 'inner']))).toBe(false)
  })

  it('invalid rows have no matches (no tree to search)', async () => {
    await initSource()
    await openRow('not json at all')
    searchStore.query = 'not'
    await vi.waitFor(() => expect(detailStore.parsed?.ok).toBe(false))
    expect(searchStore.matches.length).toBe(0)
  })

  // ---- jq mode ---------------------------------------------------------------
  it('runJq posts one RPC with a SNAPSHOT of the document text', async () => {
    await initSource()
    await openRow('{"items":[{"id":1},{"id":2}]}')
    searchStore.mode = 'jq'
    searchStore.query = '.items[].id'

    const run = searchStore.runJq()
    await vi.waitFor(() => expect(runJqOps().length).toBe(1))
    expect(runJqOps()[0]!.lineId).toBe(1)
    expect(runJqOps()[0]!.program).toBe('.items[].id')
    expect(runJqOps()[0]!.text).toBe('{"items":[{"id":1},{"id":2}]}')
    expect(searchStore.jqState).toBe('running')

    worker.emit(success(runJqOps()[0]!.requestId!, { lineId: 1, outputs: [1, 2] }))
    await run
    expect(searchStore.jqState).toBe('done')
    expect(searchStore.jqOutputs).toEqual([1, 2])
    expect(searchStore.jqPaneOpen).toBe(true)
  })

  it('an empty (no-output) run renders the no-output state', async () => {
    await initSource()
    await openRow('{"a":1}')
    searchStore.mode = 'jq'
    searchStore.query = '.missing'
    const run = searchStore.runJq()
    await vi.waitFor(() => expect(runJqOps().length).toBe(1))
    worker.emit(success(runJqOps()[0]!.requestId!, { lineId: 1, outputs: [] }))
    await run
    expect(searchStore.jqState).toBe('done')
    expect(searchStore.jqOutputs).toEqual([])
  })

  it('a stale answer (row switched in flight) is ignored silently', async () => {
    await initSource()
    await openRow('{"a":1}')
    searchStore.mode = 'jq'
    searchStore.query = '.a'
    const run = searchStore.runJq()
    await vi.waitFor(() => expect(runJqOps().length).toBe(1))

    // The user leaves the row while the RPC is in flight.
    selectionStore.activate(2, 1)
    await vi.waitFor(() => expect(getLineOps().length).toBe(2))
    // The worker finally answers for row 1 — stale: ignored.
    worker.emit(success(runJqOps()[0]!.requestId!, { lineId: 1, outputs: [99] }))
    await run

    expect(searchStore.jqState).toBe('idle') // cleared by the selection change
    expect(searchStore.jqOutputs).toEqual([])
    expect(toastStore.toasts).toEqual([]) // stale ≠ error: no toast
    // The new row's load must still settle:
    worker.emit(success(getLineOps()[1]!.requestId!, { lineId: 2, text: '{"b":2}', isEdited: false }))
    await vi.waitFor(() => expect(detailStore.status).toBe('ready'))
    expect(detailStore.text).toBe('{"b":2}')
  })

  it('a superseded run loses to the newer one (execution sequence)', async () => {
    await initSource()
    await openRow('{"a":1}')
    searchStore.mode = 'jq'
    searchStore.query = '.a'
    const run = searchStore.runJq()
    await vi.waitFor(() => expect(runJqOps().length).toBe(1))

    // The user re-runs before the first answer lands: the newer run
    // owns the pane; the first answer is stale when it finally arrives.
    searchStore.query = '.a | tonumber'
    const run2 = searchStore.runJq()
    await vi.waitFor(() => expect(runJqOps().length).toBe(2))
    worker.emit(success(runJqOps()[1]!.requestId!, { lineId: 1, outputs: [1] }))
    await run2
    expect(searchStore.jqOutputs).toEqual([1])

    worker.emit(success(runJqOps()[0]!.requestId!, { lineId: 1, outputs: [99] }))
    await run
    expect(searchStore.jqOutputs).toEqual([1]) // the stale answer lost
  })

  it('a compile error sets the error state and posts ONE toast', async () => {
    await initSource()
    await openRow('{"a":1}')
    searchStore.mode = 'jq'
    searchStore.query = '.a |'
    const run = searchStore.runJq()
    await vi.waitFor(() => expect(runJqOps().length).toBe(1))
    worker.emit(
      failure(runJqOps()[0]!.requestId!, 'JQ_COMPILE_FAILED', 'The jq program does not parse: jq: error: syntax error'),
    )
    await run
    expect(searchStore.jqState).toBe('error')
    expect(searchStore.jqError).toContain('does not parse')
    expect(toastStore.toasts.filter((t) => t.title === 'jq search failed').length).toBe(1)
    expect(searchStore.jqPaneOpen).toBe(false)
  })

  it('a runtime error sets the error state and posts ONE toast', async () => {
    await initSource()
    await openRow('{"a":1}')
    searchStore.mode = 'jq'
    searchStore.query = '.a.b.c'
    const run = searchStore.runJq()
    await vi.waitFor(() => expect(runJqOps().length).toBe(1))
    worker.emit(failure(runJqOps()[0]!.requestId!, 'JQ_RUNTIME_ERROR', 'jq failed on this document: Cannot index number with "b"'))
    await run
    expect(searchStore.jqState).toBe('error')
    expect(searchStore.jqError).toContain('Cannot index number')
    expect(toastStore.toasts.filter((t) => t.title === 'jq search failed').length).toBe(1)
  })

  it('results clear when the document reloads (an edit changed it)', async () => {
    await initSource()
    await openRow('{"a":1}')
    searchStore.mode = 'jq'
    searchStore.query = '.a'
    const run = searchStore.runJq()
    await vi.waitFor(() => expect(runJqOps().length).toBe(1))
    worker.emit(success(runJqOps()[0]!.requestId!, { lineId: 1, outputs: [1] }))
    await run
    expect(searchStore.jqState).toBe('done')

    // An edit reloads the row with new text: jq results must clear.
    // (Simulating the reload: the detail store's text ref is what the
    // watcher observes — a real edit goes through the same path.)
    detailStore.text = '{"a":2}'
    await vi.waitFor(() => expect(searchStore.jqState).toBe('idle'))
    expect(searchStore.jqOutputs).toEqual([])
    expect(searchStore.jqPaneOpen).toBe(false)
  })

  it('runJq is a no-op without a program or without a tree row', async () => {
    await initSource()
    await openRow('{"a":1}')
    searchStore.mode = 'jq'
    await searchStore.runJq() // empty query
    expect(runJqOps().length).toBe(0)

    searchStore.query = '.a'
    // Switch to an invalid row: no parsed tree → no run.
    selectionStore.activate(2, 1)
    await vi.waitFor(() => expect(getLineOps().length).toBe(2))
    worker.emit(success(getLineOps()[1]!.requestId!, { lineId: 2, text: 'nope', isEdited: false }))
    await vi.waitFor(() => expect(detailStore.status).toBe('ready'))
    await searchStore.runJq()
    expect(runJqOps().length).toBe(0)
  })
})
