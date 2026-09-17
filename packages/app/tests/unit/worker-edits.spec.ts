/**
 * Edit storage + worker mirroring (TSK0030), end-to-end through the real
 * in-process worker:
 * - an edit updates list previews, detail text, and isEdited flags;
 * - setEdit re-evaluates the row against the ACTIVE filter (text and jq)
 *   and atomically bumps the generation (membership in AND out, counts,
 *   per-row error accounting);
 * - CR/LF overrides are rejected (one source row stays one output row);
 * - out-of-range line ids and over-budget edits fail with typed codes;
 * - a reset removes the override and restores source behavior;
 * - full rescans (new filters) consult the overrides too;
 * - replacing the source clears the edit map (line ids are per-source).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

interface Envelope {
  type?: string
  requestId?: string
  ok?: boolean
  value?: unknown
  error?: { code?: string; message?: string }
}

interface RowsValue {
  rows: { lineId: number; displayIndex: number; text: string; isEdited: boolean; byteLength: number }[]
  generation: number
  totalFiltered: number
}

interface EditEvent {
  lineId: number
  isEdited: boolean
  matchedRows: number
  totalRows: number
  errorCount?: number
  errorSummary?: string
  generation: number
  partial: boolean
}

interface SetEditValue {
  lineId: number
  isEdited: boolean
  newGeneration: number
  /** Display index after the edit; ABSENT when the row is out of the view. */
  filteredIndex?: number
}

let postSpy: ReturnType<typeof vi.fn>

function posted(type: string): Envelope[] {
  return postSpy.mock.calls
    .map((c) => c[0] as Envelope)
    .filter((m) => m && m.type === type)
}

function post(data: unknown): void | Promise<void> {
  const g = globalThis as unknown as { onmessage?: (e: MessageEvent) => void | Promise<void> }
  return g.onmessage?.({ data } as unknown as MessageEvent)
}

async function waitForResponse(requestId: string): Promise<Envelope> {
  await vi.waitFor(
    () => {
      const responses = postSpy.mock.calls
        .map((c) => c[0] as Envelope)
        .filter((m) => m && m.requestId === requestId && m.ok !== undefined)
      expect(responses.length).toBeGreaterThan(0)
    },
    { timeout: 20000 },
  )
  return postSpy.mock.calls
    .map((c) => c[0] as Envelope)
    .filter((m) => m && m.requestId === requestId && m.ok !== undefined)
    .at(-1)!
}

let seq = 0
function requestId(): string {
  seq += 1
  return `r-${seq}`
}

beforeEach(() => {
  vi.resetModules()
  postSpy = vi.fn()
  vi.stubGlobal('postMessage', postSpy)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function initMemory(name: string, payload: string): Promise<void> {
  await import('../../workers/jsonl.worker.js')
  const id = requestId()
  post({ requestId: id, operationId: 'op-init', type: 'initMemory', name, payload })
  // Await the init response: the worker's handler is async (it disposes the
  // previous source first), and a following RPC must not interleave with
  // that reset.
  const res = await waitForResponse(id)
  expect(res.ok).toBe(true)
}

async function indexNow(): Promise<void> {
  const id = requestId()
  post({ requestId: id, operationId: 'op-index', type: 'index' })
  const index = await waitForResponse(id)
  expect(index.ok).toBe(true)
  await vi.waitFor(() => expect(posted('indexComplete').length).toBeGreaterThan(0))
}

async function filter(kind: 'text' | 'jq', query: string): Promise<{ matchedRows: number; generation?: number }> {
  const id = requestId()
  post({ requestId: id, operationId: 'op-filter', type: 'filter', kind, query })
  const res = await waitForResponse(id)
  expect(res.ok).toBe(true)
  return res.value as { matchedRows: number; generation?: number }
}

async function setEdit(lineId: number, text?: string): Promise<Envelope> {
  const id = requestId()
  post({ requestId: id, type: 'setEdit', lineId, text })
  return await waitForResponse(id)
}

async function getRows(start = 0, count = 100000): Promise<RowsValue> {
  const id = requestId()
  post({ requestId: id, operationId: 'op-rows', type: 'getRows', start, count, generation: 0 })
  const res = await waitForResponse(id)
  expect(res.ok).toBe(true)
  return res.value as RowsValue
}

async function getLine(lineId: number): Promise<{ lineId: number; text: string; isEdited: boolean }> {
  const id = requestId()
  post({ requestId: id, type: 'getLine', lineId })
  const res = await waitForResponse(id)
  expect(res.ok).toBe(true)
  return res.value as { lineId: number; text: string; isEdited: boolean }
}

describe('edits: worker mirroring (TSK0030)', () => {
  it('an edit updates list preview, detail text, and isEdited; siblings are untouched', async () => {
    await initMemory('edit.jsonl', '{"a":1}\n{"b":2}\n{"c":3}\n')
    await indexNow()

    const res = await setEdit(2, '{"b":"edited"}')
    expect(res.ok).toBe(true)
    expect(res.value).toMatchObject({ lineId: 2, isEdited: true, filteredIndex: 1 })
    const newGeneration = (res.value as { newGeneration: number }).newGeneration
    expect(newGeneration).toBeGreaterThan(1)

    // The editComplete event converges main-thread views on the new gen.
    await vi.waitFor(() => expect(posted('editComplete').length).toBe(1))
    const event = posted('editComplete')[0] as unknown as EditEvent
    expect(event.lineId).toBe(2)
    expect(event.isEdited).toBe(true)
    expect(event.generation).toBe(newGeneration)
    expect(event.matchedRows).toBe(3) // identity view: all rows
    expect(event.totalRows).toBe(3)

    const window = await getRows()
    expect(window.generation).toBe(newGeneration)
    const edited = window.rows.find((r) => r.lineId === 2)!
    expect(edited.text).toBe('{"b":"edited"}')
    expect(edited.isEdited).toBe(true)
    expect(edited.byteLength).toBe('{"b":"edited"}'.length + 1)
    for (const other of window.rows.filter((r) => r.lineId !== 2)) {
      expect(other.isEdited).toBe(false)
    }

    const detail = await getLine(2)
    expect(detail).toEqual({ lineId: 2, text: '{"b":"edited"}', isEdited: true })

    // A reset restores the source row everywhere.
    const reset = await setEdit(2)
    expect(reset.ok).toBe(true)
    expect(reset.value).toMatchObject({ lineId: 2, isEdited: false, filteredIndex: 1 })
    const detail2 = await getLine(2)
    expect(detail2).toEqual({ lineId: 2, text: '{"b":2}', isEdited: false })
    const window2 = await getRows()
    expect(window2.rows.find((r) => r.lineId === 2)!.isEdited).toBe(false)
  })

  it('an edit flips membership in BOTH directions under an active text filter', async () => {
    const rows = ['{"tag":"x"}', '{"tag":"y"}', '{"tag":"x"}', '{"tag":"y"}', '{"tag":"x"}', '{"tag":"y"}']
    await initMemory('member.jsonl', rows.map((r) => r + '\n').join(''))
    await indexNow()

    const f = await filter('text', '"x"')
    expect(f.matchedRows).toBe(3)
    let window = await getRows()
    expect(window.rows.map((r) => r.lineId)).toEqual([1, 3, 5])

    // Edit row 2 (y) so it matches: it inserts at display position 1.
    const editIn = await setEdit(2, '{"tag":"x","n":99}')
    expect(editIn.ok).toBe(true)
    expect(editIn.value).toMatchObject({ isEdited: true, filteredIndex: 1 })
    window = await getRows()
    expect(window.rows.map((r) => r.lineId)).toEqual([1, 2, 3, 5])
    expect(window.rows.map((r) => r.displayIndex)).toEqual([0, 1, 2, 3])
    expect(window.rows[1]!.isEdited).toBe(true)
    const inEvent = posted('editComplete').at(-1)! as unknown as EditEvent
    expect(inEvent.matchedRows).toBe(4)

    // Reset: the row drops back out (filteredIndex absent); the view is
    // exactly the pre-edit one.
    const editOut = await setEdit(2)
    expect(editOut.ok).toBe(true)
    expect(editOut.value).toMatchObject({ isEdited: false })
    expect((editOut.value as SetEditValue).filteredIndex).toBeUndefined()
    window = await getRows()
    expect(window.rows.map((r) => r.lineId)).toEqual([1, 3, 5])
    const outEvent = posted('editComplete').at(-1)! as unknown as EditEvent
    expect(outEvent.matchedRows).toBe(3)
  })

  it('an edit to a non-matching row leaves the view unchanged (filteredIndex null)', async () => {
    await initMemory('stay.jsonl', '{"a":1}\n{"b":2}\n')
    await indexNow()
    const f = await filter('text', '"a"')
    expect(f.matchedRows).toBe(1)

    const res = await setEdit(2, '{"b":"still no a"}')
    expect(res.ok).toBe(true)
    expect(res.value).toMatchObject({ isEdited: true })
    expect((res.value as SetEditValue).filteredIndex).toBeUndefined()
    const window = await getRows()
    expect(window.rows.map((r) => r.lineId)).toEqual([1])
  })

  it('rejects CR/LF overrides: nothing is stored, no generation bump', async () => {
    await initMemory('crlf.jsonl', '{"a":1}\n')
    await indexNow()
    const genBefore = posted('indexComplete').length

    const lf = await setEdit(1, 'a\nb')
    expect(lf.ok).toBe(false)
    expect(lf.error?.code).toBe('EDIT_CRLF_NOT_ALLOWED')
    const cr = await setEdit(1, 'a\rb')
    expect(cr.ok).toBe(false)
    expect(cr.error?.code).toBe('EDIT_CRLF_NOT_ALLOWED')
    const crlf = await setEdit(1, 'a\r\nb')
    expect(crlf.ok).toBe(false)
    expect(crlf.error?.code).toBe('EDIT_CRLF_NOT_ALLOWED')

    expect(posted('editComplete')).toHaveLength(0)
    const detail = await getLine(1)
    expect(detail.isEdited).toBe(false)
    expect(detail.text).toBe('{"a":1}')
    expect(posted('indexComplete')).toHaveLength(genBefore)
  })

  it('rejects out-of-range line ids and over-budget edits with typed codes', async () => {
    await initMemory('range.jsonl', '{"a":1}\n{"b":2}\n')
    await indexNow()

    const zero = await setEdit(0, 'x')
    expect(zero.ok).toBe(false)
    expect(zero.error?.code).toBe('INVALID_LINE_ID')
    const beyond = await setEdit(3, 'x')
    expect(beyond.ok).toBe(false)
    expect(beyond.error?.code).toBe('INVALID_LINE_ID')

    const huge = 'x'.repeat(1024 * 1024 + 1)
    const tooBig = await setEdit(1, huge)
    expect(tooBig.ok).toBe(false)
    expect(tooBig.error?.code).toBe('EDIT_TOO_LARGE')
    expect(posted('editComplete')).toHaveLength(0)
  })

  it('a jq filter re-evaluates the row: invalid->valid fixes the error count, valid->invalid adds one', async () => {
    await initMemory('jqedit.jsonl', '{"n":1}\nbroken\n{"n":2}\n')
    await indexNow()

    const f = await filter('jq', '.n')
    expect(f.matchedRows).toBe(2)
    expect((f as { errorCount?: number }).errorCount).toBe(1)

    // Fix the broken row: it becomes valid JSON matching .n -> enters the
    // view at position 1, the error count drops to zero.
    const fix = await setEdit(2, '{"n":3}')
    expect(fix.ok).toBe(true)
    expect(fix.value).toMatchObject({ isEdited: true, filteredIndex: 1 })
    const fixEvent = posted('editComplete').at(-1)! as unknown as EditEvent
    expect(fixEvent.matchedRows).toBe(3)
    expect(fixEvent.errorCount).toBe(0)

    const window = await getRows()
    expect(window.rows.map((r) => r.lineId)).toEqual([1, 2, 3])

    // Break a matching row: it errors (no match) and leaves the view; the
    // error count is back to one with a summary.
    const breakRow = await setEdit(1, 'no longer json')
    expect(breakRow.ok).toBe(true)
    expect(breakRow.value).toMatchObject({ isEdited: true })
    expect((breakRow.value as SetEditValue).filteredIndex).toBeUndefined()
    const breakEvent = posted('editComplete').at(-1)! as unknown as EditEvent
    expect(breakEvent.matchedRows).toBe(2)
    expect(breakEvent.errorCount).toBe(1)
    expect(typeof breakEvent.errorSummary).toBe('string')
  })

  it('a full rescan (new filter) consults the overrides, not the source bytes', async () => {
    const rows = ['{"tag":"x"}', '{"tag":"y"}']
    await initMemory('rescan.jsonl', rows.map((r) => r + '\n').join(''))
    await indexNow()

    const edit = await setEdit(2, '{"tag":"x"}')
    expect(edit.ok).toBe(true)

    // The rescan reads the override for row 2: BOTH rows match now.
    const f = await filter('text', '"x"')
    expect(f.matchedRows).toBe(2)
    const window = await getRows()
    expect(window.rows.map((r) => r.lineId)).toEqual([1, 2])
    expect(window.rows[1]!.text).toBe('{"tag":"x"}')
    expect(window.rows[1]!.isEdited).toBe(true)
  })

  it('export streams override bytes instead of source bytes (TSK0030)', async () => {
    await initMemory('export.jsonl', '{"a":1}\n{"a":2}\n{"a":3}\n')
    await indexNow()
    await setEdit(2, '{"a":2,"edited":true}')

    const startId = requestId()
    post({ requestId: startId, type: 'exportStart', generation: 1 })
    const start = await waitForResponse(startId)
    expect(start.ok).toBe(true)
    const startValue = start.value as { token: string; totalRows: number }
    expect(startValue.totalRows).toBe(3)
    const token = startValue.token

    const lines: string[] = []
    let done = false
    for (let guard = 0; !done && guard < 10; guard++) {
      const nextId = requestId()
      post({ requestId: nextId, type: 'exportNext', token })
      const res = await waitForResponse(nextId)
      expect(res.ok).toBe(true)
      const chunk = res.value as { data: Uint8Array; done: boolean; rowsExported: number }
      lines.push(new TextDecoder().decode(chunk.data))
      done = chunk.done
    }
    expect(done).toBe(true)
    expect(lines.map((l) => l.replace(/\n$/, ''))).toEqual([
      '{"a":1}',
      '{"a":2,"edited":true}', // the override, not the source bytes
      '{"a":3}',
    ])

    const ackId = requestId()
    post({ requestId: ackId, type: 'exportAck', token })
    expect((await waitForResponse(ackId)).ok).toBe(true)
  })

  it('replacing the source clears the edit map (line ids are per-source)', async () => {
    await initMemory('first.jsonl', '{"a":1}\n{"b":2}\n')
    await indexNow()
    const edit = await setEdit(1, '{"a":"edited"}')
    expect(edit.ok).toBe(true)

    await initMemory('second.jsonl', '{"z":9}\n')
    await indexNow()

    const detail = await getLine(1)
    expect(detail.isEdited).toBe(false)
    expect(detail.text).toBe('{"z":9}')
    const window = await getRows()
    expect(window.rows).toHaveLength(1)
    expect(window.rows[0]!.isEdited).toBe(false)
  })
})
