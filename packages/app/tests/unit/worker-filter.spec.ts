/**
 * Worker-level literal text filtering (TSK0026):
 * - filter responses carry the post-scan generation and a `partial` flag;
 * - getRows serves exactly the matched rows (stable source lineIds);
 * - a filter over a not-yet-indexed source is partial and the worker
 *   automatically reruns the latest query at indexComplete, announcing
 *   the final result with a filterComplete event;
 * - cancel keeps the previous view (typed FILTER_CANCELLED);
 * - a newer filter supersedes the in-flight one (stale operation).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

interface Envelope {
  type?: string
  requestId?: string
  ok?: boolean
  value?: unknown
  error?: { code?: string; message?: string }
  operationId?: string
  matchedRows?: number
  totalRows?: number
  generation?: number
  partial?: boolean
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
    { timeout: 15000 },
  )
  return postSpy.mock.calls
    .map((c) => c[0] as Envelope)
    .filter((m) => m && m.requestId === requestId && m.ok !== undefined)
    .at(-1)!
}

async function waitForEvent(type: string): Promise<Envelope> {
  await vi.waitFor(
    () => {
      expect(posted(type).length).toBeGreaterThan(0)
    },
    { timeout: 15000 },
  )
  return posted(type).at(-1)!
}

beforeEach(() => {
  vi.resetModules()
  postSpy = vi.fn()
  vi.stubGlobal('postMessage', postSpy)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function initFileAndIndex(name: string, content: string): Promise<void> {
  await import('../../workers/jsonl.worker.js')
  post({
    requestId: 'r-init',
    operationId: 'op-init',
    type: 'initFile',
    file: new File([content], name, { type: 'application/x-ndjson' }),
  })
  const init = await waitForResponse('r-init')
  expect(init.ok).toBe(true)

  post({ requestId: 'r-index', operationId: 'op-index', type: 'index' })
  await vi.waitFor(() => expect(posted('indexComplete').length).toBeGreaterThan(0))
  const index = await waitForResponse('r-index')
  expect(index.ok).toBe(true)
}

async function initMemoryOnly(name: string, payload: string): Promise<void> {
  await import('../../workers/jsonl.worker.js')
  post({ requestId: 'r-init', operationId: 'op-init', type: 'initMemory', name, payload })
  const init = await waitForResponse('r-init')
  expect(init.ok).toBe(true)
}

async function indexNow(): Promise<void> {
  post({ requestId: 'r-index', operationId: 'op-index', type: 'index' })
  const index = await waitForResponse('r-index')
  expect(index.ok).toBe(true)
  await vi.waitFor(() => expect(posted('indexComplete').length).toBeGreaterThan(0))
}

async function postFilter(requestId: string, operationId: string, kind: 'text' | 'jq', query: string): Promise<void> {
  post({ requestId, operationId, type: 'filter', kind, query })
}

let rowsSeq = 0

async function getRowsValue(generation: number, count = 1000): Promise<{
  rows: { lineId: number; displayIndex: number }[]
  totalFiltered: number
}> {
  rowsSeq += 1
  const requestId = `r-rows-${rowsSeq}`
  post({ requestId, operationId: 'op-rows', type: 'getRows', start: 0, count, generation })
  const res = await waitForResponse(requestId)
  expect(res.ok).toBe(true)
  return res.value as { rows: { lineId: number; displayIndex: number }[]; totalFiltered: number }
}

describe('jsonl.worker text filter (TSK0026)', () => {
  const ROWS = ['{"a":"hello world"}', '{"b":"no match here"}', '{"c":"hello again"}', '', '{"e":"Hello"}']

  it('filter matches agree with per-row includes; getRows serves the matched lineIds', async () => {
    const content = ROWS.map((r) => r + '\n').join('')
    await initFileAndIndex('filter.jsonl', content)

    await postFilter('r-f1', 'op-f1', 'text', 'hello')
    const res = await waitForResponse('r-f1')
    expect(res.ok).toBe(true)
    const value = res.value as { matchedRows: number; totalRows: number; generation: number; partial: boolean }
    expect(value.matchedRows).toBe(2)
    expect(value.totalRows).toBe(5)
    expect(value.partial).toBe(false)
    expect(value.generation).toBe(2) // index commit (1) + filter commit (2)

    const rows = await getRowsValue(value.generation)
    expect(rows.totalFiltered).toBe(2)
    expect(rows.rows.map((r) => r.lineId)).toEqual([1, 3]) // 1-based source lineIds
    expect(rows.rows.map((r) => r.displayIndex)).toEqual([0, 1])
  })

  it('a zero-match filter is still a filtered (empty) view', async () => {
    const content = ROWS.map((r) => r + '\n').join('')
    await initFileAndIndex('zerof.jsonl', content)

    await postFilter('r-f1', 'op-f1', 'text', 'zzz-absent')
    const res = await waitForResponse('r-f1')
    expect(res.ok).toBe(true)
    const value = res.value as { matchedRows: number; generation: number; partial: boolean }
    expect(value.matchedRows).toBe(0)
    expect(value.partial).toBe(false)

    const rows = await getRowsValue(value.generation)
    expect(rows.totalFiltered).toBe(0)
    expect(rows.rows).toHaveLength(0)

    // A new query replaces the view: rows containing 'a' are 1, 2, 3.
    await postFilter('r-f2', 'op-f2', 'text', 'a')
    const res2 = await waitForResponse('r-f2')
    const value2 = res2.value as { matchedRows: number; generation: number }
    expect(value2.matchedRows).toBe(3)
    const rows2 = await getRowsValue(value2.generation)
    expect(rows2.totalFiltered).toBe(3)
    expect(rows2.rows.map((r) => r.lineId)).toEqual([1, 2, 3])
  })

  it('is case-sensitive (literal text, not a case-insensitive search)', async () => {
    const content = ROWS.map((r) => r + '\n').join('')
    await initFileAndIndex('casef.jsonl', content)

    await postFilter('r-f1', 'op-f1', 'text', 'hello')
    const res = await waitForResponse('r-f1')
    const lower = res.value as { matchedRows: number }
    expect(lower.matchedRows).toBe(2)

    await postFilter('r-f2', 'op-f2', 'text', 'HELLO')
    const res2 = await waitForResponse('r-f2')
    const upper = res2.value as { matchedRows: number }
    expect(upper.matchedRows).toBe(0)
  })

  it('filters during indexing: partial result, automatic final rerun at indexComplete', async () => {
    const payload = Array.from({ length: 1000 }, (_, i) => `{"n":${i}}\n`).join('')
    await initMemoryOnly('stream.jsonl', payload)

    // No index yet: zero committed rows -> empty PARTIAL view.
    await postFilter('r-f1', 'op-f1', 'text', '"n":42')
    const partialRes = await waitForResponse('r-f1')
    expect(partialRes.ok).toBe(true)
    const partial = partialRes.value as { matchedRows: number; totalRows: number; partial: boolean; generation: number }
    expect(partial.partial).toBe(true)
    expect(partial.matchedRows).toBe(0)
    expect(partial.totalRows).toBe(0)
    expect(partial.generation).toBe(1)

    // Indexing completes: the worker reruns the latest query automatically.
    await indexNow()
    const complete = await waitForEvent('filterComplete')
    expect(complete.operationId).toMatch(/^filter-rerun-/)
    expect(complete.matchedRows).toBe(11) // n=42 and n=420..429
    expect(complete.totalRows).toBe(1000)
    expect(complete.partial).toBe(false)
    expect(complete.generation).toBe(3) // filter (1) + index (2) + rerun (3)

    // The view now serves the final matched rows.
    const rows = await getRowsValue(complete.generation!)
    expect(rows.totalFiltered).toBe(11)
    expect(rows.rows.map((r) => r.lineId)).toEqual([43, 421, 422, 423, 424, 425, 426, 427, 428, 429, 430])
  })

  it('cancel keeps the previous view and answers FILTER_CANCELLED', async () => {
    const payload = Array.from({ length: 20000 }, (_, i) => (i % 2 === 0 ? '{"t":"x"}\n' : '{"t":"y"}\n')).join('')
    await initMemoryOnly('big.jsonl', payload)
    await indexNow()

    await postFilter('r-f1', 'op-f1', 'text', 'x')
    post({ requestId: 'r-cancel', operationId: 'op-f1', type: 'cancel' })
    const res = await waitForResponse('r-f1')
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe('FILTER_CANCELLED')

    // The unfiltered identity view is untouched.
    const rows = await getRowsValue(1)
    expect(rows.totalFiltered).toBe(20000)
    expect(rows.rows[0]!.lineId).toBe(1)
  })

  it('a newer filter supersedes the in-flight one (stale operation)', async () => {
    const payload = Array.from({ length: 30000 }, (_, i) => (i % 2 === 0 ? '{"t":"x"}\n' : '{"t":"y"}\n')).join('')
    await initMemoryOnly('restart.jsonl', payload)
    await indexNow()

    await postFilter('r-f1', 'op-f1', 'text', 'x')
    await postFilter('r-f2', 'op-f2', 'text', 'zzz-absent')
    const staleRes = await waitForResponse('r-f1')
    const freshRes = await waitForResponse('r-f2')

    // The superseded scan is reported as cancelled, not as a result.
    expect(staleRes.ok).toBe(false)
    expect(staleRes.error?.code).toBe('FILTER_CANCELLED')
    expect(freshRes.ok).toBe(true)
    const fresh = freshRes.value as { matchedRows: number; generation: number; partial: boolean }
    expect(fresh.matchedRows).toBe(0)
    expect(fresh.partial).toBe(false)

    // The published view is the fresh (empty) result.
    const rows = await getRowsValue(fresh.generation)
    expect(rows.totalFiltered).toBe(0)
    expect(rows.rows).toHaveLength(0)
  })
})
