/**
 * Edits store (TSK0030): the main-thread mirror of the worker's
 * authoritative edit map.
 *
 * - setEdit validates (CR/LF, byte budget) BEFORE touching the worker and
 *   only mirrors the override locally after the worker accepted it.
 * - A worker rejection leaves the local map untouched.
 * - Byte accounting is UTF-8 (multi-codepoint rows cost real bytes).
 * - resetEdit removes the override; resetEdits drops the whole map.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useFileStore } from '~/stores/file'
import { useEditsStore, EditValidationError, EditBudgetError } from '~/stores/edits'
import { useJsonlEngine, resetJsonlEngineForTests } from '~/composables/useJsonlEngine'
import { EngineRpcError } from '~/engine/workerClient'
import { ENGINE_DEFAULTS } from '~/engine/config/adr'
import { FakeWorker, failure, success } from '../helpers/fakeWorker'

let workers: FakeWorker[]
let injected: FakeWorker | null = null

function injectWorker(worker: FakeWorker): void {
  injected = worker
}

beforeEach(() => {
  setActivePinia(createPinia())
  resetJsonlEngineForTests()
  workers = []
  injected = null
  useJsonlEngine({
    workerFactory: () => {
      const worker = injected ?? new FakeWorker()
      injected = null
      workers.push(worker)
      return worker as unknown as Worker
    },
  })
})

async function openFile(worker: FakeWorker = new FakeWorker()): Promise<void> {
  if (injected === null) injectWorker(worker)
  const fileStore = useFileStore()
  const pending = fileStore.loadFile(new File(['a\n'], 'a.jsonl'))
  answerLast(worker, { name: 'a.jsonl', size: 11, type: 'file' })
  await pending
}

function answerLast(worker: FakeWorker, value: unknown): void {
  const last = worker.posted.at(-1) as { requestId?: string }
  worker.emit(success(last.requestId!, value))
}

function failLast(worker: FakeWorker, code: string, message: string): void {
  const last = worker.posted.at(-1) as { requestId?: string }
  worker.emit(failure(last.requestId!, code, message))
}

describe('edits store: worker mirroring (TSK0030)', () => {
  it('setEdit posts the RPC and mirrors the override only after success', async () => {
    const worker = new FakeWorker()
    await openFile(worker)
    const edits = useEditsStore()

    const pending = edits.setEdit(3, '{"v":"edited"}')
    const rpc = worker.posted.at(-1) as { type?: string; lineId?: number; text?: string }
    expect(rpc.type).toBe('setEdit')
    expect(rpc.lineId).toBe(3)
    expect(rpc.text).toBe('{"v":"edited"}')

    answerLast(worker, { lineId: 3, isEdited: true, newGeneration: 2, filteredIndex: 1 })
    await pending

    expect(edits.isEdited(3)).toBe(true)
    expect(edits.get(3)).toBe('{"v":"edited"}')
    expect(edits.version).toBeGreaterThan(0)
  })

  it('a worker rejection leaves the local map untouched', async () => {
    const worker = new FakeWorker()
    await openFile(worker)
    const edits = useEditsStore()

    const pending = edits.setEdit(3, 'whatever')
    failLast(worker, 'EDIT_FAILED', 'boom')
    await expect(pending).rejects.toThrow(EngineRpcError)

    expect(edits.isEdited(3)).toBe(false)
    expect(edits.get(3)).toBeUndefined()
    expect(edits.usedBytes).toBe(0)
  })

  it('resetEdit posts a reset (no text) and removes the override', async () => {
    const worker = new FakeWorker()
    await openFile(worker)
    const edits = useEditsStore()

    const set = edits.setEdit(1, 'override-text')
    answerLast(worker, { lineId: 1, isEdited: true, newGeneration: 1 })
    await set
    expect(edits.isEdited(1)).toBe(true)

    const reset = edits.resetEdit(1)
    const rpc = worker.posted.at(-1) as { type?: string; lineId?: number; text?: undefined }
    expect(rpc.type).toBe('setEdit')
    expect(rpc.lineId).toBe(1)
    expect(rpc.text).toBeUndefined()
    answerLast(worker, { lineId: 1, isEdited: false, newGeneration: 2 })
    await reset

    expect(edits.isEdited(1)).toBe(false)
    expect(edits.get(1)).toBeUndefined()
    expect(edits.usedBytes).toBe(0)
  })

  it('resetEdits drops the whole map (new source)', async () => {
    const worker = new FakeWorker()
    await openFile(worker)
    const edits = useEditsStore()

    const a = edits.setEdit(1, 'aaa')
    answerLast(worker, { lineId: 1, isEdited: true, newGeneration: 1 })
    await a
    const b = edits.setEdit(2, 'bb')
    answerLast(worker, { lineId: 2, isEdited: true, newGeneration: 2 })
    await b
    expect(edits.usedBytes).toBeGreaterThan(0)

    edits.resetEdits()

    expect(edits.isEdited(1)).toBe(false)
    expect(edits.isEdited(2)).toBe(false)
    expect(edits.usedBytes).toBe(0)
  })
})

describe('edits store: validation (TSK0030)', () => {
  it('rejects CR/LF before posting anything', async () => {
    const worker = new FakeWorker()
    await openFile(worker)
    const edits = useEditsStore()

    await expect(edits.setEdit(1, 'line1\nline2')).rejects.toThrow(EditValidationError)
    await expect(edits.setEdit(1, 'line1\rline2')).rejects.toThrow(EditValidationError)
    await expect(edits.setEdit(1, 'crlf\r\nhere')).rejects.toThrow(EditValidationError)
    // Nothing reached the worker: only the initFile from openFile.
    const rpcs = worker.posted.map((m) => (m as { type?: string }).type)
    expect(rpcs.filter((t) => t === 'setEdit')).toHaveLength(0)
  })

  it('rejects overrides over the byte budget (and wouldExceedBudget agrees)', async () => {
    const worker = new FakeWorker()
    await openFile(worker)
    const edits = useEditsStore()

    const tooBig = 'x'.repeat(ENGINE_DEFAULTS.editMaxBytes + 1)
    expect(edits.wouldExceedBudget(1, tooBig)).toBe(true)
    await expect(edits.setEdit(1, tooBig)).rejects.toThrow(EditBudgetError)
    expect(edits.isEdited(1)).toBe(false)

    const atLimit = 'x'.repeat(ENGINE_DEFAULTS.editMaxBytes)
    expect(edits.wouldExceedBudget(1, atLimit)).toBe(false)
  })

  it('accounts bytes in UTF-8, not character count', async () => {
    const worker = new FakeWorker()
    await openFile(worker)
    const edits = useEditsStore()

    // é is 2 UTF-8 bytes; the accounting must see 2, not 1.
    const pending = edits.setEdit(1, 'éé')
    answerLast(worker, { lineId: 1, isEdited: true, newGeneration: 1 })
    await pending
    expect(edits.usedBytes).toBe(4)
  })
})
