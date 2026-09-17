/**
 * Detail loader store (TSK0024): on-demand full text, stale-load
 * cancellation on rapid selection, invalid-JSON handling, the
 * large-row parse threshold (raw by default + confirm), and
 * presentation-only Format/Compact (never an edit).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { useJsonlEngine, resetJsonlEngineForTests } from '~/composables/useJsonlEngine'
import { useDetailStore } from '~/stores/detail'
import { useSelectionStore } from '~/stores/selection'
import { useToastStore } from '~/stores/toasts'
import { FakeWorker, success, failure } from '../helpers/fakeWorker'

interface PostedOp {
  type: string
  requestId?: string
  lineId?: number
}

const LARGE_TEXT = JSON.stringify({ data: 'x'.repeat(1200 * 1024) }) // > 1 MiB

describe('detail loader store (TSK0024)', () => {
  let pinia: Pinia
  let worker: FakeWorker
  let detailStore: ReturnType<typeof useDetailStore>
  let selectionStore: ReturnType<typeof useSelectionStore>

  const getLineOps = (): PostedOp[] =>
    worker.posted.filter((m) => (m as PostedOp).type === 'getLine') as PostedOp[]

  async function initSource(): Promise<void> {
    const pending = useJsonlEngine().open('file', new File(['a\n'], 't.jsonl'))
    await vi.waitFor(() => {
      expect(worker.posted.some((m) => (m as PostedOp).type === 'initFile')).toBe(true)
    })
    const op = worker.posted.find((m) => (m as PostedOp).type === 'initFile') as PostedOp
    worker.emit(success(op.requestId!, { name: 't.jsonl', size: 2, type: 'file' }))
    await pending
  }

  function answerLine(op: PostedOp, text: string): void {
    worker.emit(success(op.requestId!, { lineId: op.lineId, text, isEdited: false }))
  }

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    resetJsonlEngineForTests()
    worker = new FakeWorker()
    useJsonlEngine({ workerFactory: () => worker as unknown as Worker })
    selectionStore = useSelectionStore()
    detailStore = useDetailStore()
  })

  it('loads the active row full text on demand (getLine)', async () => {
    await initSource()
    expect(detailStore.status).toBe('idle')

    selectionStore.activate(3, 2)
    await vi.waitFor(() => expect(getLineOps().length).toBe(1))
    expect(getLineOps()[0]!.lineId).toBe(3)
    answerLine(getLineOps()[0]!, '{"hello":"world"}')
    await vi.waitFor(() => expect(detailStore.status).toBe('ready'))
    expect(detailStore.lineId).toBe(3)
    expect(detailStore.text).toBe('{"hello":"world"}')
    expect(detailStore.parsed?.ok).toBe(true)
  })

  it('ignores a stale getLine answer after rapid selection', async () => {
    await initSource()

    selectionStore.activate(1, 0)
    await vi.waitFor(() => expect(getLineOps().length).toBe(1))
    const op1 = getLineOps()[0]!

    // The user moves on BEFORE the first answer lands.
    selectionStore.activate(2, 1)
    await vi.waitFor(() => expect(getLineOps().length).toBe(2))
    const op2 = getLineOps()[1]!

    // The STALE answer must not render row 1 (let its continuation run).
    answerLine(op1, '{"row":1}')
    await new Promise((r) => setTimeout(r, 20))
    expect(detailStore.text).not.toBe('{"row":1}')

    // The current answer applies.
    answerLine(op2, '{"row":2}')
    await vi.waitFor(() => expect(detailStore.text).toBe('{"row":2}'))
    expect(detailStore.lineId).toBe(2)
  })

  it('flags invalid JSON (raw mode + toast) without failing the load', async () => {
    await initSource()
    const toastStore = useToastStore()

    selectionStore.activate(1, 0)
    await vi.waitFor(() => expect(getLineOps().length).toBe(1))
    answerLine(getLineOps()[0]!, 'not json at all')
    await vi.waitFor(() => expect(detailStore.status).toBe('ready'))
    expect(detailStore.parsed?.ok).toBe(false)
    expect(detailStore.parsed?.error).toBeTruthy()
    expect(toastStore.toasts.some((t) => t.title === 'Invalid JSON')).toBe(true)
  })

  it('defaults rows above the parse threshold to raw until confirmed', async () => {
    await initSource()

    selectionStore.activate(1, 0)
    await vi.waitFor(() => expect(getLineOps().length).toBe(1))
    answerLine(getLineOps()[0]!, LARGE_TEXT)
    await vi.waitFor(() => expect(detailStore.status).toBe('ready'))

    // Above the 1 MiB threshold: raw mode, NO parsed tree yet.
    expect(detailStore.isLarge).toBe(true)
    expect(detailStore.needsConfirm).toBe(true)
    expect(detailStore.parsed).toBeNull()

    // Confirmation parses (and the tree becomes available).
    detailStore.confirmTreeView()
    await vi.waitFor(() => expect(detailStore.parsed?.ok).toBe(true))
    expect(detailStore.needsConfirm).toBe(false)
  })

  it('parses normal rows without confirmation', async () => {
    await initSource()
    selectionStore.activate(1, 0)
    await vi.waitFor(() => expect(getLineOps().length).toBe(1))
    answerLine(getLineOps()[0]!, '{"a":1}')
    await vi.waitFor(() => expect(detailStore.status).toBe('ready'))
    expect(detailStore.isLarge).toBe(false)
    expect(detailStore.needsConfirm).toBe(false)
    expect(detailStore.parsed?.ok).toBe(true)
  })

  it('Format/Compact switch presentation only — no setEdit is ever posted', async () => {
    await initSource()
    selectionStore.activate(1, 0)
    await vi.waitFor(() => expect(getLineOps().length).toBe(1))
    answerLine(getLineOps()[0]!, '{"a":1}')
    await vi.waitFor(() => expect(detailStore.status).toBe('ready'))

    detailStore.setViewMode('compact')
    expect(detailStore.viewMode).toBe('compact')
    detailStore.setViewMode('format')
    expect(detailStore.viewMode).toBe('format')
    expect(detailStore.text).toBe('{"a":1}') // untouched

    const ops = worker.posted.map((m) => (m as PostedOp).type)
    expect(ops).not.toContain('setEdit')
  })

  it('surfaces a typed load failure (status error, message)', async () => {
    await initSource()
    selectionStore.activate(1, 0)
    await vi.waitFor(() => expect(getLineOps().length).toBe(1))
    worker.emit(failure(getLineOps()[0]!.requestId!, 'internal', 'Disk read failed'))
    await vi.waitFor(() => expect(detailStore.status).toBe('error'))
    expect(detailStore.loadError).toContain('Disk read failed')
  })

  it('resets (idle) when the selection is cleared — source replacement', async () => {
    await initSource()
    selectionStore.activate(1, 0)
    await vi.waitFor(() => expect(getLineOps().length).toBe(1))
    answerLine(getLineOps()[0]!, '{"a":1}')
    await vi.waitFor(() => expect(detailStore.status).toBe('ready'))

    // What fileStore.resetDerivedState() does to the selection first.
    selectionStore.resetSelection()
    await vi.waitFor(() => expect(detailStore.status).toBe('idle'))
    expect(detailStore.text).toBeNull()
    expect(detailStore.lineId).toBeNull()
  })
})
