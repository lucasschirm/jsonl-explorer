/**
 * Worker-level local jq search (TSK0033): the runJq RPC executes a
 * program against ONE document (sent by value) using the REAL jq backend
 * (WASM via the test fetch shim) and returns every output in emission
 * order. Malformed documents are rejected before they can reach jq
 * (a malformed input silently kills the module); parse and runtime
 * errors come back as typed errors.
 *
 * NOTE: every runJq post uses a UNIQUE requestId — with a fixed id,
 * waitForResponse would match a PREVIOUS run's answer (stale by design).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

interface Envelope {
  type?: string
  requestId?: string
  ok?: boolean
  value?: { lineId?: number; outputs?: unknown[] }
  error?: { code?: string; message?: string }
}

let postSpy: ReturnType<typeof vi.fn>
let runSeq = 0

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

beforeEach(() => {
  vi.resetModules()
  postSpy = vi.fn()
  vi.stubGlobal('postMessage', postSpy)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function initMemoryOnly(name: string, payload: string): Promise<void> {
  await import('../../workers/jsonl.worker.js')
  post({ requestId: 'r-init', operationId: 'op-init', type: 'initMemory', name, payload })
  const init = await waitForResponse('r-init')
  expect(init.ok).toBe(true)
}

async function runJq(program: string, text: string): Promise<Envelope> {
  const requestId = `r-jq-${++runSeq}`
  post({ requestId, type: 'runJq', lineId: 1, program, text })
  return await waitForResponse(requestId)
}

describe('jsonl.worker runJq (TSK0033)', () => {
  it('returns every output of the program, in emission order', async () => {
    await initMemoryOnly('t.jsonl', '{"items":[{"id":1,"tag":"a"},{"id":2,"tag":"b"}],"n":7}\n')
    const res = await runJq('.items[].id', '{"items":[{"id":1,"tag":"a"},{"id":2,"tag":"b"}],"n":7}')
    expect(res.ok).toBe(true)
    expect(res.value?.lineId).toBe(1)
    expect(res.value?.outputs).toEqual([1, 2])
  })

  it('single, repeated, and identity outputs all work', async () => {
    await initMemoryOnly('t.jsonl', '{"a":1}\n')
    const one = await runJq('.a', '{"a":1}')
    expect(one.ok).toBe(true)
    expect(one.value?.outputs).toEqual([1])

    // `.a, .a` emits twice; `.` (identity) emits the input once:
    const twice = await runJq('.a, .a', '{"a":1}')
    expect(twice.value?.outputs).toEqual([1, 1])
    const identity = await runJq('.', '{"a":1}')
    expect(identity.value?.outputs).toEqual([{ a: 1 }])
  })

  it('`empty` is an empty outputs array (not an error); `.missing` emits null', async () => {
    await initMemoryOnly('t.jsonl', '{"a":1}\n')
    const none = await runJq('empty', '{"a":1}')
    expect(none.ok).toBe(true)
    expect(none.value?.outputs).toEqual([])
    // jq semantics: a missing key is the VALUE null, not an error.
    const missing = await runJq('.missing', '{"a":1}')
    expect(missing.ok).toBe(true)
    expect(missing.value?.outputs).toEqual([null])
  })

  it('string, boolean, and object outputs survive the round trip', async () => {
    await initMemoryOnly('t.jsonl', '{"s":"hi","o":{"x":true}}\n')
    const res = await runJq('.s, .o.x, "literal", .o', '{"s":"hi","o":{"x":true}}')
    expect(res.value?.outputs).toEqual(['hi', true, 'literal', { x: true }])
  })

  it('a malformed document is rejected BEFORE jq runs (typed INVALID_JSON)', async () => {
    await initMemoryOnly('t.jsonl', '{"a":1}\n')
    const res = await runJq('.a', 'not json at all')
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe('INVALID_JSON')
    // The module survived: a later valid run still works.
    const ok = await runJq('.a', '{"a":5}')
    expect(ok.ok).toBe(true)
    expect(ok.value?.outputs).toEqual([5])
  })

  it('a program that does not parse is a typed JQ_COMPILE_FAILED', async () => {
    await initMemoryOnly('t.jsonl', '{"a":1}\n')
    const res = await runJq('.a |', '{"a":1}')
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe('JQ_COMPILE_FAILED')
    expect(res.error?.message).toContain('does not parse')
  })

  it('a runtime error on the document is a typed JQ_RUNTIME_ERROR', async () => {
    await initMemoryOnly('t.jsonl', '{"a":1}\n')
    const res = await runJq('.a.b.c', '{"a":1}')
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe('JQ_RUNTIME_ERROR')
    expect(res.error?.message).toContain('jq failed on this document')
    // The module survives a runtime error: the next run still works.
    const ok = await runJq('.a', '{"a":9}')
    expect(ok.ok).toBe(true)
    expect(ok.value?.outputs).toEqual([9])
  })

  it('works on a primitive document (string root)', async () => {
    await initMemoryOnly('t.jsonl', '"hello"\n')
    const res = await runJq('length', '"hello"')
    expect(res.ok).toBe(true)
    expect(res.value?.outputs).toEqual([5])
  })
})
