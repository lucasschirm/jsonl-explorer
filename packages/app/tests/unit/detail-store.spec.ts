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
import { useEditsStore } from '~/stores/edits'
import { useSelectionStore } from '~/stores/selection'
import { useToastStore } from '~/stores/toasts'
import { FakeWorker, success, failure } from '../helpers/fakeWorker'

interface PostedOp {
  type: string
  requestId?: string
  lineId?: number
  text?: string
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

  it('invalid-JSON toast is non-duplicating (per row, per context)', async () => {
    await initSource()
    const toastStore = useToastStore()

    // First invalid row: one toast.
    selectionStore.activate(1, 0)
    await vi.waitFor(() => expect(getLineOps().length).toBe(1))
    answerLine(getLineOps()[0]!, 'bad one')
    await vi.waitFor(() => expect(detailStore.status).toBe('ready'))
    expect(toastStore.toasts.filter((t) => t.title === 'Invalid JSON').length).toBe(1)

    // Leave and come back to the SAME row: no duplicate toast.
    selectionStore.activate(2, 1)
    await vi.waitFor(() => expect(getLineOps().length).toBe(2))
    answerLine(getLineOps()[1]!, '{"fine":true}')
    await vi.waitFor(() => expect(detailStore.status).toBe('ready'))
    selectionStore.activate(1, 0)
    await vi.waitFor(() => expect(getLineOps().length).toBe(3))
    answerLine(getLineOps()[2]!, 'bad one')
    await vi.waitFor(() => expect(detailStore.status).toBe('ready'))
    expect(toastStore.toasts.filter((t) => t.title === 'Invalid JSON').length).toBe(1)

    // A DIFFERENT invalid row toasts again.
    selectionStore.activate(3, 2)
    await vi.waitFor(() => expect(getLineOps().length).toBe(4))
    answerLine(getLineOps()[3]!, 'bad three')
    await vi.waitFor(() => expect(detailStore.status).toBe('ready'))
    expect(toastStore.toasts.filter((t) => t.title === 'Invalid JSON').length).toBe(2)
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

describe('detail edit session (TSK0031)', () => {
  let pinia: Pinia
  let worker: FakeWorker
  let detailStore: ReturnType<typeof useDetailStore>
  let editsStore: ReturnType<typeof useEditsStore>
  let selectionStore: ReturnType<typeof useSelectionStore>
  let toastStore: ReturnType<typeof useToastStore>

  const getLineOps = (): PostedOp[] =>
    worker.posted.filter((m) => (m as PostedOp).type === 'getLine') as PostedOp[]
  const setEditOps = (): PostedOp[] =>
    worker.posted.filter((m) => (m as PostedOp).type === 'setEdit') as PostedOp[]

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

  /**
   * A commit reloads the row before it resolves: answer the reload's
   * getLine (with the edited text), then let the commit finish.
   */
  async function settleCommit(commit: Promise<void>, expectedText: string, getLinesBefore: number): Promise<void> {
    await vi.waitFor(() => expect(getLineOps().length).toBe(getLinesBefore + 1))
    const reload = getLineOps().slice(-1)[0]!
    worker.emit(success(reload.requestId!, { lineId: 1, text: expectedText, isEdited: true }))
    await commit
    await vi.waitFor(() => expect(detailStore.text).toBe(expectedText))
  }

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    resetJsonlEngineForTests()
    worker = new FakeWorker()
    useJsonlEngine({ workerFactory: () => worker as unknown as Worker })
    selectionStore = useSelectionStore()
    detailStore = useDetailStore()
    editsStore = useEditsStore()
    toastStore = useToastStore()
  })

  it('commits a primitive edit: coerce, re-serialize the document, mirror ONCE', async () => {
    await initSource()
    await openRow('{"a":1,"b":"x"}')

    detailStore.startEdit(['a'])
    expect(detailStore.isEditing).toBe(true)
    expect(detailStore.editingPath).toEqual(['a'])
    expect(detailStore.editDraft).toBe('1') // seeded with the current token
    detailStore.editDraft = '2'

    const commit = detailStore.commitEdit()
    await vi.waitFor(() => expect(setEditOps().length).toBe(1))
    expect(setEditOps()[0]!.lineId).toBe(1)
    // The WHOLE document, compact — not a fragment, not the old text.
    expect(setEditOps()[0]!.text).toBe('{"a":2,"b":"x"}')
    worker.emit(success(setEditOps()[0]!.requestId!, { lineId: 1, isEdited: true, newGeneration: 2, filteredIndex: 0 }))
    await settleCommit(commit, '{"a":2,"b":"x"}', 1)

    // The session is closed and the edits store mirrors the accepted edit.
    expect(detailStore.isEditing).toBe(false)
    expect(editsStore.isEdited(1)).toBe(true)
    expect(editsStore.get(1)).toBe('{"a":2,"b":"x"}')
    expect(detailStore.parsed?.ok).toBe(true)
  })

  it('coerces with JSON.parse first, falling back to string', async () => {
    await initSource()
    await openRow('{"a":1}')
    detailStore.startEdit(['a'])
    detailStore.editDraft = 'hi'
    const c1 = detailStore.commitEdit()
    await vi.waitFor(() => expect(setEditOps().length).toBe(1))
    expect(setEditOps()[0]!.text).toBe('{"a":"hi"}') // invalid JSON -> string
    worker.emit(success(setEditOps()[0]!.requestId!, { lineId: 1, isEdited: true, newGeneration: 2, filteredIndex: 0 }))
    await settleCommit(c1, '{"a":"hi"}', 1)

    detailStore.startEdit(['a'])
    expect(detailStore.editDraft).toBe('"hi"') // seeded from the NEW value
    detailStore.editDraft = 'null'
    const c2 = detailStore.commitEdit()
    await vi.waitFor(() => expect(setEditOps().length).toBe(2))
    expect(setEditOps()[1]!.text).toBe('{"a":null}') // valid JSON -> null
    worker.emit(success(setEditOps()[1]!.requestId!, { lineId: 1, isEdited: true, newGeneration: 3, filteredIndex: 0 }))
    await settleCommit(c2, '{"a":null}', 2)
  })

  it('Escape cancels: no RPC, draft cleared, one editor at a time', async () => {
    await initSource()
    await openRow('{"a":1,"b":2}')
    detailStore.startEdit(['a'])
    detailStore.editDraft = '999'
    detailStore.cancelEdit()
    expect(detailStore.isEditing).toBe(false)
    expect(detailStore.editDraft).toBe('')
    expect(setEditOps().length).toBe(0)

    // A second session on another node works fine after a cancel.
    detailStore.startEdit(['b'])
    expect(detailStore.editingPath).toEqual(['b'])
    detailStore.cancelEdit()
    expect(setEditOps().length).toBe(0)
  })

  it('a double commit (Enter then blur) posts exactly ONE setEdit', async () => {
    await initSource()
    await openRow('{"a":1}')
    detailStore.startEdit(['a'])
    detailStore.editDraft = '7'
    const c1 = detailStore.commitEdit() // Enter
    const c2 = detailStore.commitEdit() // the unmount blur right after
    await vi.waitFor(() => expect(setEditOps().length).toBe(1))
    worker.emit(success(setEditOps()[0]!.requestId!, { lineId: 1, isEdited: true, newGeneration: 2, filteredIndex: 0 }))
    await settleCommit(c1, '{"a":7}', 1)
    await c2
    expect(setEditOps().length).toBe(1)
  })

  it('a stale path (row changed while editing) is rejected with one toast, no RPC', async () => {
    await initSource()
    await openRow('{"a":1}')
    detailStore.startEdit(['a'])
    detailStore.editDraft = '2'
    // The row's text changes underneath the session (external reload).
    detailStore.text = '{"z":9}'
    await detailStore.commitEdit()
    expect(setEditOps().length).toBe(0)
    expect(detailStore.isEditing).toBe(false)
    expect(
      toastStore.toasts.some((t) => t.title === 'Edit failed'),
    ).toBe(true)
  })

  it('a worker-rejected edit toasts and leaves the edits store untouched', async () => {
    await initSource()
    await openRow('{"a":1}')
    detailStore.startEdit(['a'])
    detailStore.editDraft = '2'
    const commit = detailStore.commitEdit()
    await vi.waitFor(() => expect(setEditOps().length).toBe(1))
    worker.emit(failure(setEditOps()[0]!.requestId!, 'EDIT_TOO_LARGE', 'too big'))
    await commit
    expect(detailStore.isEditing).toBe(false)
    expect(editsStore.isEdited(1)).toBe(false)
    expect(toastStore.toasts.some((t) => t.title === 'Edit failed')).toBe(true)
    // The detail still shows the ORIGINAL text (nothing changed).
    expect(detailStore.text).toBe('{"a":1}')
  })

  it('resetLine removes the override and reloads the original text', async () => {
    await initSource()
    await openRow('{"a":1}')
    detailStore.startEdit(['a'])
    detailStore.editDraft = '2'
    const c = detailStore.commitEdit()
    await vi.waitFor(() => expect(setEditOps().length).toBe(1))
    worker.emit(success(setEditOps()[0]!.requestId!, { lineId: 1, isEdited: true, newGeneration: 2, filteredIndex: 0 }))
    await settleCommit(c, '{"a":2}', 1)
    expect(editsStore.isEdited(1)).toBe(true)

    const reset = detailStore.resetLine()
    await vi.waitFor(() => expect(setEditOps().length).toBe(2))
    // Reset = setEdit WITHOUT text.
    expect(setEditOps()[1]!.text).toBeUndefined()
    worker.emit(success(setEditOps()[1]!.requestId!, { lineId: 1, isEdited: false, newGeneration: 3, filteredIndex: 0 }))
    // The reset also reloads (original text) before resolving.
    await vi.waitFor(() => expect(getLineOps().length).toBe(3))
    worker.emit(success(getLineOps()[2]!.requestId!, { lineId: 1, text: '{"a":1}', isEdited: false }))
    await reset
    expect(editsStore.isEdited(1)).toBe(false)
    expect(detailStore.text).toBe('{"a":1}')
  })

  it('startEdit is a no-op on invalid-JSON rows (no tree, no session)', async () => {
    await initSource()
    await openRow('not json at all')
    detailStore.startEdit(['a'])
    expect(detailStore.isEditing).toBe(false)
    detailStore.startEdit([])
    expect(detailStore.isEditing).toBe(false)
    expect(setEditOps().length).toBe(0)
  })

  it('a selection change while editing cancels the session (no cross-row drafts)', async () => {
    await initSource()
    await openRow('{"a":1}')
    detailStore.startEdit(['a'])
    detailStore.editDraft = '77'
    selectionStore.activate(2, 1)
    await vi.waitFor(() => expect(getLineOps().length).toBe(2))
    expect(detailStore.isEditing).toBe(false)
    worker.emit(success(getLineOps()[1]!.requestId!, { lineId: 2, text: '{"b":2}', isEdited: false }))
    await vi.waitFor(() => expect(detailStore.status).toBe('ready'))
    expect(setEditOps().length).toBe(0)
  })
})
