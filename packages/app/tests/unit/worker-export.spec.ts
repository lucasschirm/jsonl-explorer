/**
 * Worker-level export snapshots and backpressure (TSK0034):
 * - exportStart captures membership + generation at one generation and
 *  rejects a stale generation (typed STALE_GENERATION);
 * - exportNext/ack pump BOUNDED chunks (≤ exportChunkMaxBytes of complete
 *  rows, one oversized row allowed alone) and STOP until acknowledged —
 *  a next before the ack is a typed EXPORT_NOT_ACKED, so a slow consumer
 *  can never queue more than one chunk;
 * - content applies edit overrides and ends every exported row with
 *  exactly one LF (blanks survive as bare LFs);
 * - edits are LOCKED while any export is in flight (EXPORT_IN_PROGRESS)
 *  and unlock when the export is done/acked or cancelled;
 * - cancel/restart never mixes chunks from different exports (tokens are
 *  isolated; unknown tokens are typed EXPORT_TOKEN_INVALID).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

interface Envelope {
  type?: string
  requestId?: string
  ok?: boolean
  value?: {
    token?: string
    estimatedBytes?: number
    totalRows?: number
    generation?: number
    partial?: boolean
    data?: Uint8Array
    done?: boolean
    rowsExported?: number
    acknowledged?: boolean
    cancelled?: boolean
  }
  error?: { code?: string; message?: string }
}

let postSpy: ReturnType<typeof vi.fn>
let seq = 0

function requestId(): string {
  return `r-${++seq}`
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
  seq = 0
  postSpy = vi.fn()
  vi.stubGlobal('postMessage', postSpy)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function initMemory(name: string, payload: string): Promise<void> {
  await import('../../workers/jsonl.worker.js')
  post({ requestId: 'r-init', operationId: 'op-init', type: 'initMemory', name, payload })
  const res = await waitForResponse('r-init')
  expect(res.ok).toBe(true)
}

async function indexNow(): Promise<void> {
  post({ requestId: 'r-index', operationId: 'op-index', type: 'index' })
  const index = await waitForResponse('r-index')
  expect(index.ok).toBe(true)
  await vi.waitFor(
    () => {
      const done = postSpy.mock.calls.map((c) => c[0] as Envelope).find((m) => m?.type === 'indexComplete')
      expect(done).toBeTruthy()
    },
    { timeout: 20000 },
  )
}

async function exportStart(generation: number): Promise<Envelope> {
  const id = requestId()
  post({ requestId: id, type: 'exportStart', generation })
  return await waitForResponse(id)
}

async function exportNext(token: string): Promise<Envelope> {
  const id = requestId()
  post({ requestId: id, type: 'exportNext', token })
  return await waitForResponse(id)
}

async function exportAck(token: string): Promise<Envelope> {
  const id = requestId()
  post({ requestId: id, type: 'exportAck', token })
  return await waitForResponse(id)
}

async function exportCancel(token: string): Promise<Envelope> {
  const id = requestId()
  post({ requestId: id, type: 'exportCancel', token })
  return await waitForResponse(id)
}

async function setEdit(lineId: number, text?: string): Promise<Envelope> {
  const id = requestId()
  post({ requestId: id, type: 'setEdit', lineId, ...(text !== undefined ? { text } : {}) })
  return await waitForResponse(id)
}

async function textFilter(query: string): Promise<{ matchedRows: number; generation: number }> {
  const id = requestId()
  post({ requestId: id, operationId: 'op-filter', type: 'filter', kind: 'text', query })
  const res = await waitForResponse(id)
  expect(res.ok).toBe(true)
  return res.value as { matchedRows: number; generation: number }
}

/** Pump an export to completion (next → ack until the done chunk is acked). */
async function pumpToDone(token: string): Promise<{ text: string; rows: number }> {
  const decoder = new TextDecoder()
  let text = ''
  let rows = 0
  let guard = 100000
  while (guard-- > 0) {
    const res = await exportNext(token)
    expect(res.ok).toBe(true)
    const chunk = res.value!
    rows = chunk.rowsExported ?? 0
    if (chunk.data && chunk.data.byteLength > 0) text += decoder.decode(chunk.data)
    const ack = await exportAck(token)
    expect(ack.ok).toBe(true)
    if (chunk.done) break
  }
  return { text, rows }
}

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

describe('worker export (TSK0034)', () => {
  it('exports an unfiltered view row-for-row, each with exactly one LF (blanks survive)', async () => {
    const rows = ['{"a":1}', '', '{"b":"two"}', 'plain-text-row', '{"c":3}']
    const content = rows.map((r) => r + '\n').join('')
    await initMemory('exp.jsonl', content)
    await indexNow()

    const start = await exportStart(1) // 1 = index commit generation
    expect(start.ok).toBe(true)
    const s = start.value!
    expect(s.token).toBeTruthy()
    expect(s.totalRows).toBe(5)
    expect(s.generation).toBe(1)
    expect(s.partial).toBe(false)
    expect(s.estimatedBytes).toBe(content.length) // tiny view: sample IS the export

    const result = await pumpToDone(s.token!)
    expect(result.text).toBe(content)
    expect(result.rows).toBe(5)
  })

  it('exports the FILTERED view with edits applied, in stable source order', async () => {
    const rows = ['{"a":1}', '{"b":2}', '', '{"a":9}', '{"c":3}']
    const content = rows.map((r) => r + '\n').join('')
    await initMemory('exp.jsonl', content)
    await indexNow()

    const filter = await textFilter('"a"') // matches rows 1 and 4 only
    expect(filter.matchedRows).toBe(2)

    const edit = await setEdit(4, '{"a":42}')
    expect(edit.ok).toBe(true)
    const gen = (edit.value as { newGeneration: number }).newGeneration

    const start = await exportStart(gen)
    expect(start.ok).toBe(true)
    expect(start.value!.totalRows).toBe(2)

    const result = await pumpToDone(start.value!.token!)
    expect(result.text).toBe('{"a":1}\n{"a":42}\n')
    expect(result.rows).toBe(2)
  })

  it('splits output into bounded chunks; the concatenation is byte-exact', async () => {
    // 300 rows x 1002 bytes (1001 content + 1 LF) = 300,600 > the 256 KiB cap.
    const pad = 'x'.repeat(991)
    const row = `{"pad":"${pad}"}`
    expect(row.length + 1).toBe(1002)
    const content = Array.from({ length: 300 }, () => row).map((r) => r + '\n').join('')
    await initMemory('big.jsonl', content)
    await indexNow()

    const start = await exportStart(1)
    expect(start.ok).toBe(true)
    const token = start.value!.token!
    expect(start.value!.estimatedBytes).toBeGreaterThan(0)

    const decoder = new TextDecoder()
    let text = ''
    let chunks = 0
    let lastRows = 0
    let guard = 100
    while (guard-- > 0) {
      const res = await exportNext(token)
      expect(res.ok).toBe(true)
      const chunk = res.value!
      if (chunk.data!.byteLength > 0) {
        chunks += 1
        expect(chunk.data!.byteLength).toBeLessThanOrEqual(256 * 1024)
        // Every chunk ends on a row boundary (complete rows only).
        expect(decoder.decode(chunk.data!)).toMatch(/\n$/)
      }
      text += decoder.decode(chunk.data!)
      expect(chunk.rowsExported!).toBeGreaterThan(lastRows) // monotonic progress
      lastRows = chunk.rowsExported!
      const ack = await exportAck(token)
      expect(ack.ok).toBe(true)
      if (chunk.done) break
    }
    expect(chunks).toBe(2) // 261 rows fit in chunk 1; 39 remain
    expect(lastRows).toBe(300)
    expect(text).toBe(content)
  })

  it('stops until acknowledged: a next before the ack is a typed error (bounded queue)', async () => {
    const row = `{"pad":"${'x'.repeat(991)}"}`
    const content = Array.from({ length: 600 }, () => row).map((r) => r + '\n').join('')
    await initMemory('backpressure.jsonl', content)
    await indexNow()

    const start = await exportStart(1)
    const token = start.value!.token!

    const first = await exportNext(token)
    expect(first.ok).toBe(true)
    expect(first.value!.data!.byteLength).toBeGreaterThan(0)

    // NO ack yet: further nexts must be refused, not produced.
    for (let i = 0; i < 3; i++) {
      const early = await exportNext(token)
      expect(early.ok).toBe(false)
      expect(early.error!.code).toBe('EXPORT_NOT_ACKED')
    }

    // Ack re-arms the pump.
    const ack = await exportAck(token)
    expect(ack.ok).toBe(true)
    const second = await exportNext(token)
    expect(second.ok).toBe(true)
    expect(second.value!.rowsExported!).toBeGreaterThan(first.value!.rowsExported!)
  })

  it('emits a single row over the cap as its own chunk (rows are never split)', async () => {
    const big = `{"b":"${'y'.repeat(300 * 1024 - 9)}"}`
    expect(big.length + 1).toBe(300 * 1024) // 300 KiB row > 256 KiB cap
    const content = `{"s":1}\n${big}\n{"s":3}\n`
    await initMemory('oversize.jsonl', content)
    await indexNow()

    const start = await exportStart(1)
    const token = start.value!.token!

    const c1 = await exportNext(token)
    expect(c1.ok).toBe(true)
    expect(decode(c1.value!.data!)).toBe('{"s":1}\n')
    await exportAck(token)

    const c2 = await exportNext(token)
    expect(c2.ok).toBe(true)
    expect(c2.value!.data!.byteLength).toBe(300 * 1024) // over the cap, alone
    expect(decode(c2.value!.data!)).toBe(`${big}\n`)
    await exportAck(token)

    const c3 = await exportNext(token)
    expect(c3.ok).toBe(true)
    expect(c3.value!.done).toBe(true)
    expect(decode(c3.value!.data!)).toBe('{"s":3}\n')
    const ack = await exportAck(token)
    expect(ack.ok).toBe(true)
  })

  it('rejects a stale generation at start (typed), and accepts the current one', async () => {
    const content = '{"a":1}\n{"b":2}\n'
    await initMemory('stale.jsonl', content)
    await indexNow()
    const filter = await textFilter('a')
    expect(filter.generation).toBeGreaterThan(1)

    const stale = await exportStart(1) // pre-filter generation
    expect(stale.ok).toBe(false)
    expect(stale.error!.code).toBe('STALE_GENERATION')

    const fresh = await exportStart(filter.generation)
    expect(fresh.ok).toBe(true)
    await exportCancel(fresh.value!.token!)
  })

  it('locks edits while an export is in flight; cancel releases the lock', async () => {
    const content = '{"a":1}\n{"b":2}\n'
    await initMemory('lock.jsonl', content)
    await indexNow()

    const start = await exportStart(1)
    expect(start.ok).toBe(true)
    await exportNext(start.value!.token!) // one chunk in flight (unacked)

    const locked = await setEdit(1, '{"a":99}')
    expect(locked.ok).toBe(false)
    expect(locked.error!.code).toBe('EXPORT_IN_PROGRESS')

    const cancel = await exportCancel(start.value!.token!)
    expect(cancel.ok).toBe(true)
    expect(cancel.value!.cancelled).toBe(true)

    const unlocked = await setEdit(1, '{"a":99}')
    expect(unlocked.ok).toBe(true)
  })

  it('finishing the export (done + ack) releases the lock without a cancel', async () => {
    const content = '{"a":1}\n{"b":2}\n'
    await initMemory('finish.jsonl', content)
    await indexNow()

    const start = await exportStart(1)
    const token = start.value!.token!
    await pumpToDone(token)

    const edit = await setEdit(2, '{"b":22}')
    expect(edit.ok).toBe(true)
  })

  it('cancel/restart isolates exports: no chunk mixing, unknown tokens are typed', async () => {
    const row = `{"pad":"${'x'.repeat(991)}"}`
    const content = Array.from({ length: 400 }, () => row).map((r) => r + '\n').join('')
    await initMemory('iso.jsonl', content)
    await indexNow()

    const a = await exportStart(1)
    const tokenA = a.value!.token!
    const firstChunk = await exportNext(tokenA)
    expect(firstChunk.ok).toBe(true)
    expect(firstChunk.value!.done).toBe(false)
    const cancelA = await exportCancel(tokenA)
    expect(cancelA.ok).toBe(true)

    // A fresh export restarts from row 0 — B's bytes are B's, all of them.
    const b = await exportStart(1)
    const tokenB = b.value!.token!
    expect(tokenB).not.toBe(tokenA)
    const result = await pumpToDone(tokenB)
    expect(result.text).toBe(content)
    expect(result.rows).toBe(400)

    // The dead token A is rejected everywhere (typed, not silent).
    const nextA = await exportNext(tokenA)
    expect(nextA.ok).toBe(false)
    expect(nextA.error!.code).toBe('EXPORT_TOKEN_INVALID')
    const ackA = await exportAck(tokenA)
    expect(ackA.ok).toBe(false)
    expect(ackA.error!.code).toBe('EXPORT_TOKEN_INVALID')

    // Cancel is idempotent (user action, not a protocol violation).
    const cancelBAgain = await exportCancel(tokenB)
    expect(cancelBAgain.ok).toBe(true)
    expect(cancelBAgain.value!.cancelled).toBe(true)
  })

  it('refuses exportStart while a filter scan is in flight (mid-scan view)', async () => {
    const rows = Array.from({ length: 200 }, (_, i) => `{"i":${i},"pad":"${'z'.repeat(120)}"}`)
    const content = rows.map((r) => r + '\n').join('')
    await initMemory('inflight.jsonl', content)
    await indexNow()

    // Both posts run synchronously back-to-back: the filter scan has set
    // its in-flight flag but cannot complete before exportStart is seen
    // (the scan yields at its first read), so the refusal is deterministic.
    const filterId = requestId()
    post({ requestId: filterId, operationId: 'op-filter-x', type: 'filter', kind: 'text', query: '"i":1' })
    const startId = requestId()
    post({ requestId: startId, type: 'exportStart', generation: 1 })

    const start = await waitForResponse(startId)
    expect(start.ok).toBe(false)
    expect(start.error!.code).toBe('EXPORT_FILTER_IN_FLIGHT')

    // Once the scan settles, the same export is accepted.
    const filter = await waitForResponse(filterId)
    expect(filter.ok).toBe(true)
    const gen = (filter.value as { generation: number }).generation
    const ok = await exportStart(gen)
    expect(ok.ok).toBe(true)
    await exportCancel(ok.value!.token!)
  })

  it('exports a zero-row (empty) view as one empty done chunk', async () => {
    const content = '{"a":1}\n{"b":2}\n'
    await initMemory('empty.jsonl', content)
    await indexNow()
    const filter = await textFilter('zzz-no-such-text')
    expect(filter.matchedRows).toBe(0)

    const start = await exportStart(filter.generation)
    expect(start.ok).toBe(true)
    expect(start.value!.totalRows).toBe(0)
    const token = start.value!.token!

    const res = await exportNext(token)
    expect(res.ok).toBe(true)
    expect(res.value!.done).toBe(true)
    expect(res.value!.rowsExported).toBe(0)
    expect(res.value!.data!.byteLength).toBe(0)
    const ack = await exportAck(token)
    expect(ack.ok).toBe(true)
  })
})
