/**
 * Worker row access (TSK0021): list previews are capped (first
 * PREVIEW_ROW_BYTES bytes) and single-line escaped; the full text is
 * served separately by getLine (unescaped, for JSON parsing);
 * unfiltered reads are identity (displayIndex + 1) with no materialized
 * match list; indexComplete carries the post-commit generation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

interface Envelope {
  type?: string
  requestId?: string
  ok?: boolean
  value?: unknown
  error?: { code?: string; message?: string }
  operationId?: string
  totalRows?: number
  generation?: number
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

/** Wait for a success envelope for a given requestId. */
async function waitForResponse(requestId: string): Promise<Envelope> {
  await vi.waitFor(() => {
    const responses = postSpy.mock.calls
      .map((c) => c[0] as Envelope)
      .filter((m) => m && m.requestId === requestId && (m.ok !== undefined))
    expect(responses.length).toBeGreaterThan(0)
  })
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
  // indexComplete (with generation) then the index response.
  await vi.waitFor(() => {
    expect(posted('indexComplete').length).toBeGreaterThan(0)
  })
  const index = await waitForResponse('r-index')
  expect(index.ok).toBe(true)
}

describe('jsonl.worker row access (TSK0021)', () => {
  const SMALL = '{"a":1}\n'
  const BIG_TEXT = 'x'.repeat(2000)
  const BIG = `{"payload":"${BIG_TEXT}"}\n`
  const TABBED = '{"note":"a\tb"}\n'

  it('indexComplete carries the post-commit generation', async () => {
    await initFileAndIndex('gen.jsonl', SMALL + BIG + TABBED)
    const events = posted('indexComplete')
    expect(events).toHaveLength(1)
    // First commit on a fresh worker: generation 1.
    expect(events[0]!.generation).toBe(1)
    expect(events[0]!.totalRows).toBe(3)
  })

  it('caps list previews at the byte budget and reports the full byteLength', async () => {
    await initFileAndIndex('cap.jsonl', SMALL + BIG + TABBED)

    post({
      requestId: 'r-rows',
      operationId: 'op-rows',
      type: 'getRows',
      start: 0,
      count: 10,
      generation: 1,
    })
    const res = await waitForResponse('r-rows')
    expect(res.ok).toBe(true)
    const value = res.value as {
      rows: {
        lineId: number
        displayIndex: number
        text: string
        isEdited: boolean
        byteLength: number
      }[]
      generation: number
      totalFiltered: number
    }
    // Unfiltered: identity mapping, no materialized match list.
    expect(value.totalFiltered).toBe(3)
    expect(value.generation).toBe(1)
    expect(value.rows.map((r) => r.lineId)).toEqual([1, 2, 3])
    expect(value.rows.map((r) => r.displayIndex)).toEqual([0, 1, 2])

    // Small row: full text, exact byteLength.
    expect(value.rows[0]!.text).toBe('{"a":1}')
    expect(value.rows[0]!.byteLength).toBe(SMALL.trimEnd().length)

    // Big row: preview capped at the 500-byte budget (well under the 2KB
    // original)…
    expect(value.rows[1]!.byteLength).toBe(BIG.trimEnd().length)
    expect(value.rows[1]!.text.length).toBeLessThanOrEqual(500)
    expect(value.rows[1]!.text.length).toBeLessThan(BIG_TEXT.length)
    // …but byteLength still reports the FULL row size.
  })

  it('escapes control characters in previews but not in getLine', async () => {
    await initFileAndIndex('tab.jsonl', SMALL + TABBED)

    post({
      requestId: 'r-rows',
      operationId: 'op-rows',
      type: 'getRows',
      start: 0,
      count: 10,
      generation: 1,
    })
    const res = await waitForResponse('r-rows')
    const rows = (res.value as { rows: { text: string }[] }).rows
    expect(rows[1]!.text).toBe('{"note":"a\\u0009b"}')

    // getLine returns the RAW text (the detail panel JSON-parses it).
    post({ requestId: 'r-line', operationId: 'op-line', type: 'getLine', lineId: 2 })
    const line = await waitForResponse('r-line')
    expect((line.value as { text: string }).text).toBe('{"note":"a\tb"}')
  })

  it('maps display indices through the filter after a filter completes', async () => {
    await initFileAndIndex('filt.jsonl', SMALL + BIG + TABBED)

    post({
      requestId: 'r-filter',
      operationId: 'op-filter',
      type: 'filter',
      kind: 'text',
      query: 'x',
    })
    const filter = await waitForResponse('r-filter')
    const filterValue = filter.value as { matchedRows: number; generation: number }
    expect(filterValue.matchedRows).toBe(1)
    const gen = filterValue.generation
    expect(gen).toBeGreaterThan(1)

    post({
      requestId: 'r-rows',
      operationId: 'op-rows',
      type: 'getRows',
      start: 0,
      count: 10,
      generation: gen,
    })
    const res = await waitForResponse('r-rows')
    const value = res.value as {
      rows: { lineId: number; displayIndex: number }[]
      totalFiltered: number
    }
    expect(value.totalFiltered).toBe(1)
    expect(value.rows).toHaveLength(1)
    expect(value.rows[0]!.displayIndex).toBe(0)
    expect(value.rows[0]!.lineId).toBe(2) // the 'x' row (1-based)
  })
})
