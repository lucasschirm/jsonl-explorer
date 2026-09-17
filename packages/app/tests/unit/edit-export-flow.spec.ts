/**
 * Edit -> filter -> row -> export pipeline (TSK0036): the FULL worker
 * stack (memory source, index, edit overrides, filter view, export
 * snapshot + backpressure) driven end to end, with the export output
 * compared BYTE-FOR-BYTE against the expected fixture.
 *
 * Covers: edited rows exported as their override; invalid (raw) rows
 * exported verbatim; a single row LARGER than the 256 KiB chunk cap
 * emitted alone (never split); the reset path; the edit lock during an
 * in-flight export; and the stale-generation race (retry with the
 * worker-reported generation).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

interface Envelope {
  type?: string
  requestId?: string
  ok?: boolean
  value?: unknown
  error?: { code?: string; message?: string; details?: Record<string, unknown> }
}

let postSpy: ReturnType<typeof vi.fn>

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

let rpcSeq = 0
function rpcId(): string {
  rpcSeq += 1
  return `r-${rpcSeq}`
}

beforeEach(() => {
  vi.resetModules()
  postSpy = vi.fn()
  rpcSeq = 0
  vi.stubGlobal('postMessage', postSpy)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function initMemory(name: string, payload: string): Promise<void> {
  await import('../../workers/jsonl.worker.js')
  const id = rpcId()
  await post({ requestId: id, operationId: 'op-init', type: 'initMemory', name, payload })
  const init = await waitForResponse(id)
  expect(init.ok).toBe(true)
}

async function indexNow(): Promise<void> {
  const id = rpcId()
  await post({ requestId: id, operationId: 'op-index', type: 'index' })
  const index = await waitForResponse(id)
  expect(index.ok).toBe(true)
  await vi.waitFor(() => {
    const events = postSpy.mock.calls.map((c) => c[0] as Envelope).filter((m) => m?.type === 'indexComplete')
    expect(events.length).toBeGreaterThan(0)
  })
}

async function setEdit(lineId: number, text: string | undefined): Promise<Envelope> {
  const id = rpcId()
  await post({ requestId: id, operationId: 'op-edit', type: 'setEdit', lineId, ...(text !== undefined ? { text } : {}) })
  return waitForResponse(id)
}

async function filterText(query: string): Promise<{ matchedRows: number; generation: number }> {
  const id = rpcId()
  await post({ requestId: id, operationId: 'op-filter', type: 'filter', kind: 'text', query })
  const res = await waitForResponse(id)
  expect(res.ok).toBe(true)
  return res.value as { matchedRows: number; generation: number }
}

interface StartResult {
  token: string
  estimatedBytes: number
  totalRows: number
  generation: number
}

/** exportStart + one stale retry (the documented TSK0035 contract). */
async function exportStartWithRetry(generation: number): Promise<StartResult> {
  const id = rpcId()
  await post({ requestId: id, operationId: 'op-export', type: 'exportStart', generation })
  const res = await waitForResponse(id)
  if (res.ok) return res.value as StartResult
  expect(res.error?.code).toBe('STALE_GENERATION')
  const current = res.error?.details?.['currentGeneration'] as number
  const retryId = rpcId()
  await post({ requestId: retryId, operationId: 'op-export', type: 'exportStart', generation: current })
  const retry = await waitForResponse(retryId)
  expect(retry.ok).toBe(true)
  return retry.value as StartResult
}

/** Pump until done, returning the concatenated bytes and the chunks. */
async function pumpToDone(token: string): Promise<{ bytes: Uint8Array; chunks: Uint8Array[] }> {
  const chunks: Uint8Array[] = []
  for (;;) {
    const id = rpcId()
    await post({ requestId: id, operationId: 'op-export', type: 'exportNext', token })
    const res = await waitForResponse(id)
    expect(res.ok).toBe(true)
    const chunk = res.value as { data: Uint8Array; done: boolean; rowsExported: number }
    chunks.push(chunk.data)
    const ackId = rpcId()
    await post({ requestId: ackId, operationId: 'op-export', type: 'exportAck', token })
    const ack = await waitForResponse(ackId)
    expect(ack.ok).toBe(true)
    if (chunk.done) break
  }
  const total = chunks.reduce((sum, c) => sum + c.length, 0)
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    bytes.set(c, offset)
    offset += c.length
  }
  return { bytes, chunks }
}

function exportCancel(token: string): Promise<Envelope> {
  const id = rpcId()
  void post({ requestId: id, operationId: 'op-export', type: 'exportCancel', token })
  return waitForResponse(id)
}

const decoder = new TextDecoder()

/** The fixture: valid rows, an invalid raw row, and a row larger than
 *  the 256 KiB chunk cap (a 300 KiB payload). */
const HUG = 'x'.repeat(300 * 1024)
const ROW_KEEP_VALID = '{"id":1,"tag":"keep"}'
const ROW_RAW = 'not valid json but keep'
const ROW_DROP = '{"id":3,"tag":"drop"}'
const ROW_HUGE = `{"id":4,"tag":"keep","blob":"${HUG}"}`
const SOURCE = [ROW_KEEP_VALID, ROW_RAW, ROW_DROP, ROW_HUGE].map((r) => `${r}\n`).join('')

describe('edit -> filter -> export pipeline (TSK0036)', () => {
  it('exports the filtered view byte-for-byte, with the edit applied and the huge row unsplit', async () => {
    await initMemory('flow.jsonl', SOURCE)
    await indexNow()

    // Edit row 1 (generation bump).
    const edit = await setEdit(1, '{"id":1,"tag":"keep","edited":true}')
    expect(edit.ok).toBe(true)

    // Filter view: rows 1, 2, 4 (the raw row matches the text too).
    const filter = await filterText('keep')
    expect(filter.matchedRows).toBe(3)

    const start = await exportStartWithRetry(filter.generation)
    expect(start.totalRows).toBe(3)
    expect(start.estimatedBytes).toBeGreaterThan(0)

    const { bytes, chunks } = await pumpToDone(start.token)
    const expected = [
      '{"id":1,"tag":"keep","edited":true}',
      ROW_RAW,
      ROW_HUGE,
    ]
      .map((r) => `${r}\n`)
      .join('')
    // Byte-for-byte: the exported output IS the expected fixture.
    expect(decoder.decode(bytes)).toBe(expected)
    expect(bytes.length).toBe(new TextEncoder().encode(expected).length)

    // The 300 KiB row is larger than the 256 KiB chunk cap: it must be
    // emitted as its OWN chunk (a row is never split).
    const hugeChunk = chunks.find((c) => decoder.decode(c).includes('"blob"'))
    expect(hugeChunk).toBeDefined()
    expect(decoder.decode(hugeChunk!)).toBe(`${ROW_HUGE}\n`)
  })

  it('reset path: removing the override restores the source bytes in the export', async () => {
    await initMemory('reset.jsonl', SOURCE)
    await indexNow()

    const edit = await setEdit(1, '{"id":1,"tag":"keep","edited":true}')
    expect(edit.ok).toBe(true)
    const reset = await setEdit(1, undefined)
    expect(reset.ok).toBe(true)

    const filter = await filterText('keep')
    const start = await exportStartWithRetry(filter.generation)
    const { bytes } = await pumpToDone(start.token)
    const expected = [ROW_KEEP_VALID, ROW_RAW, ROW_HUGE].map((r) => `${r}\n`).join('')
    expect(decoder.decode(bytes)).toBe(expected)
  })

  it('the edit lock holds for the whole run: setEdit is refused while any export is in flight', async () => {
    await initMemory('lock.jsonl', SOURCE)
    await indexNow()

    const start = await exportStartWithRetry(1) // identity view, gen 1
    const refused = await setEdit(1, '{"id":1,"tag":"keep","edited":true}')
    expect(refused.ok).toBe(false)
    expect(refused.error?.code).toBe('EXPORT_IN_PROGRESS')

    // Cancel releases the lock; the same edit then succeeds.
    const cancel = await exportCancel(start.token)
    expect(cancel.ok).toBe(true)
    const after = await setEdit(1, '{"id":1,"tag":"keep","edited":true}')
    expect(after.ok).toBe(true)
  })

  it('stale-generation race: a filter after the start request is rejected, the retry with the reported generation is accepted', async () => {
    await initMemory('race.jsonl', SOURCE)
    await indexNow()

    // The view the caller "saw" is generation 1 (identity).
    const staleId = rpcId()
    await post({ requestId: staleId, operationId: 'op-export', type: 'filter', kind: 'text', query: 'keep' })
    const filter = await waitForResponse(staleId)
    expect(filter.ok).toBe(true)

    const stale = rpcId()
    await post({ requestId: stale, operationId: 'op-export', type: 'exportStart', generation: 1 })
    const res = await waitForResponse(stale)
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe('STALE_GENERATION')
    expect(res.error?.details?.['currentGeneration']).toBe((filter.value as { generation: number }).generation)

    const start = await exportStartWithRetry((filter.value as { generation: number }).generation)
    expect(start.generation).toBe((filter.value as { generation: number }).generation)
    const { bytes } = await pumpToDone(start.token)
    const expected = ['{"id":1,"tag":"keep"}', ROW_RAW, ROW_HUGE].map((r) => `${r}\n`).join('')
    expect(decoder.decode(bytes)).toBe(expected)
  })

  it('cancelling mid-stream releases the lock and invalidates the token', async () => {
    await initMemory('midcancel.jsonl', SOURCE)
    await indexNow()

    const start = await exportStartWithRetry(1)
    // One chunk in flight...
    const id = rpcId()
    await post({ requestId: id, operationId: 'op-export', type: 'exportNext', token: start.token })
    const chunk = await waitForResponse(id)
    expect(chunk.ok).toBe(true)

    const cancel = await exportCancel(start.token)
    expect(cancel.ok).toBe(true)

    // The token is dead: the next request fails typed.
    const dead = rpcId()
    await post({ requestId: dead, operationId: 'op-export', type: 'exportNext', token: start.token })
    const deadRes = await waitForResponse(dead)
    expect(deadRes.ok).toBe(false)
    expect(deadRes.error?.code).toBe('EXPORT_TOKEN_INVALID')

    // ...and the edit lock is free again.
    const edit = await setEdit(1, '{"id":1,"tag":"keep","edited":true}')
    expect(edit.ok).toBe(true)
  })
})
