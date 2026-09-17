/**
 * Filter integration across worker generations (TSK0029):
 * - a new filter REPLACES the previous view (never refines it);
 * - zero matches -> clear -> re-filter keeps the engine reusable;
 * - text filtering never JSON.parses records (raw byte scan, R1);
 * - cancel then restart: the restarted query completes against the
 *   full source;
 * - a row window spanning a view change never mixes two mappings:
 *   it is either fully identity, fully the new filtered view, or a
 *   typed STALE_GENERATION error (the client retries).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

interface Envelope {
  type?: string
  requestId?: string
  ok?: boolean
  value?: unknown
  error?: { code?: string; message?: string }
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

interface FilterResultShape {
  matchedRows: number
  totalRows: number
  generation: number
  partial: boolean
  errorCount?: number
  errorSummary?: string
}

async function filter(kind: 'text' | 'jq', query: string, operationId = 'op-filter'): Promise<FilterResultShape> {
  const requestId = `r-filter-${Math.random().toString(36).slice(2, 8)}`
  post({ requestId, operationId, type: 'filter', kind, query })
  const res = await waitForResponse(requestId)
  expect(res.ok).toBe(true)
  return res.value as FilterResultShape
}

async function clearFilter(): Promise<FilterResultShape> {
  const requestId = `r-clear-${Math.random().toString(36).slice(2, 8)}`
  post({ requestId, operationId: 'op-clear', type: 'clearFilter' })
  const res = await waitForResponse(requestId)
  expect(res.ok).toBe(true)
  return res.value as FilterResultShape
}

async function getRows(generation: number, start = 0, count = 100000): Promise<Envelope> {
  const requestId = `r-rows-${Math.random().toString(36).slice(2, 8)}`
  post({ requestId, operationId: 'op-rows', type: 'getRows', start, count, generation })
  return await waitForResponse(requestId)
}

describe('filter integration: replace semantics and reuse (TSK0029)', () => {
  it('a new filter REPLACES the previous view, never refines it (stable source lineIds)', async () => {
    const rows: string[] = []
    for (let i = 0; i < 6; i += 1) {
      rows.push(i % 2 === 0 ? '{"tag":"x","n":1}' : '{"tag":"y","n":2}')
    }
    await initMemory('replace.jsonl', rows.map((r) => r + '\n').join(''))
    await indexNow()

    // View 1: the x rows.
    const f1 = await filter('text', '"x"')
    expect(f1.matchedRows).toBe(3)
    let window = (await getRows(f1.generation!)).value as { rows: { lineId: number; displayIndex: number }[] }
    expect(window.rows.map((r) => r.lineId)).toEqual([1, 3, 5])
    expect(window.rows.map((r) => r.displayIndex)).toEqual([0, 1, 2])

    // View 2: the y rows — replace, not an intersection with view 1.
    const f2 = await filter('text', '"y"')
    window = (await getRows(f2.generation!)).value as { rows: { lineId: number; displayIndex: number }[] }
    expect(window.rows.map((r) => r.lineId)).toEqual([2, 4, 6])
    expect(window.rows.map((r) => r.displayIndex)).toEqual([0, 1, 2])

    // View 3: re-running the FIRST query still yields view 1 exactly.
    const f3 = await filter('text', '"x"')
    window = (await getRows(f3.generation!)).value as { rows: { lineId: number; displayIndex: number }[] }
    expect(window.rows.map((r) => r.lineId)).toEqual([1, 3, 5])
  })

  it('zero matches -> clear -> re-filter keeps the engine reusable', async () => {
    const rows = ['{"tag":"x"}', '{"tag":"y"}', '{"tag":"x"}']
    await initMemory('zero.jsonl', rows.map((r) => r + '\n').join(''))
    await indexNow()

    const zero = await filter('text', 'nomatch-anywhere')
    expect(zero.matchedRows).toBe(0)
    let window = (await getRows(zero.generation!)).value as {
      rows: { lineId: number }[]
      totalFiltered: number
    }
    expect(window.totalFiltered).toBe(0)
    expect(window.rows).toEqual([])

    const cleared = await clearFilter()
    expect(cleared.matchedRows).toBe(3)
    expect(cleared.totalRows).toBe(3)
    window = (await getRows(cleared.generation!)).value as { rows: { lineId: number }[]; totalFiltered: number }
    expect(window.totalFiltered).toBe(3)
    expect(window.rows.map((r) => r.lineId)).toEqual([1, 2, 3])

    // The engine still filters correctly after a clear.
    const again = await filter('text', '"x"')
    window = (await getRows(again.generation!)).value as {
      rows: { lineId: number }[]
      totalFiltered: number
    }
    expect(window.rows.map((r) => r.lineId)).toEqual([1, 3])
  })
})

describe('filter integration: text scan stays raw (TSK0029)', () => {
  it('text filtering never JSON.parses records (malformed rows are matched as text)', async () => {
    const rows = [
      '{"a":"needle here"}',
      'this is not json but has the needle',
      '{"b":"nope"}',
      '{"broken": needle here,}',
    ]
    await initMemory('raw.jsonl', rows.map((r) => r + '\n').join(''))
    await indexNow()

    const parseSpy = vi.spyOn(JSON, 'parse')
    try {
      const res = await filter('text', 'needle')
      expect(res.matchedRows).toBe(3) // includes both malformed rows
      expect(parseSpy.mock.calls.length).toBe(0) // raw bytes: no parsing at all
    } finally {
      parseSpy.mockRestore()
    }
  })
})

describe('filter integration: cancel then restart (TSK0029)', () => {
  it('a cancelled filter can be restarted and completes against the full source', async () => {
    const rows: string[] = []
    const MATCHES = 25000
    for (let i = 0; i < 50000; i += 1) {
      rows.push(i < MATCHES ? '{"m":"match"}' : '{"m":"none"}')
    }
    await initMemory('restart.jsonl', rows.map((r) => r + '\n').join(''))
    await indexNow()

    // Start a filter over the full source, then cancel it immediately.
    post({ requestId: 'r-f-a', operationId: 'op-fa', type: 'filter', kind: 'text', query: '"match"' })
    post({ requestId: 'r-cancel-a', operationId: 'op-fa', type: 'cancel' })
    const cancelled = await waitForResponse('r-f-a')
    expect(cancelled.ok).toBe(false)
    expect(cancelled.error?.code).toBe('FILTER_CANCELLED')
    await waitForResponse('r-cancel-a')

    // Restart the SAME query: it completes with the full-source count.
    const restarted = await filter('text', '"match"', 'op-fb')
    expect(restarted.matchedRows).toBe(MATCHES)
    expect(restarted.totalRows).toBe(50000)

    const window = (await getRows(restarted.generation!)).value as {
      rows: { lineId: number; displayIndex: number }[]
      totalFiltered: number
    }
    expect(window.totalFiltered).toBe(MATCHES)
    expect(window.rows[0]?.lineId).toBe(1)
    expect(window.rows.at(-1)?.displayIndex).toBe(MATCHES - 1)
  })
})

describe('filter integration: row windows spanning a view change (TSK0029)', () => {
  it('a getRows that overlaps a filter commit never mixes two mappings', async () => {
    // 20k rows; exactly one row contains the needle.
    const rows: string[] = []
    const NEEDLE_ROW = 7
    for (let i = 0; i < 20000; i += 1) {
      rows.push(i === NEEDLE_ROW - 1 ? '{"tag":"only-needle"}' : '{"tag":"plain"}')
    }
    await initMemory('overlap.jsonl', rows.map((r) => r + '\n').join(''))
    await indexNow()

    // Post a full-window fetch, then (while it is in flight) a filter.
    // The two handlers interleave at every row read; the outcome must
    // be one of three consistent states, never a mixed window.
    const rowsPromise = getRows(1, 0, 20000)
    post({ requestId: 'r-f-overlap', operationId: 'op-fc', type: 'filter', kind: 'text', query: 'only-needle' })
    const filterRes = await waitForResponse('r-f-overlap')
    expect(filterRes.ok).toBe(true)
    expect((filterRes.value as FilterResultShape).matchedRows).toBe(1)

    const rowsRes = await rowsPromise
    const rowsValue = rowsRes.value as {
      rows: { lineId: number; displayIndex: number }[]
      generation: number
      totalFiltered: number
    }
    if (rowsRes.ok === true) {
      if (rowsValue.generation === 1) {
        // Fully the old (identity) view.
        expect(rowsValue.totalFiltered).toBe(20000)
        expect(rowsValue.rows.length).toBe(20000)
        expect(rowsValue.rows[0]?.lineId).toBe(1)
        expect(rowsValue.rows.at(-1)?.lineId).toBe(20000)
      } else {
        // Fully the new (filtered) view: exactly the one needle row.
        expect(rowsValue.totalFiltered).toBe(1)
        expect(rowsValue.rows).toHaveLength(1)
        expect(rowsValue.rows[0]?.lineId).toBe(NEEDLE_ROW)
        expect(rowsValue.rows[0]?.displayIndex).toBe(0)
      }
    } else {
      // The mixed window was refused: typed, retryable.
      expect(rowsRes.error?.code).toBe('STALE_GENERATION')
    }
  })
})
