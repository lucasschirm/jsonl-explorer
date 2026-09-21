/**
 * TSK0037 - handover handshake (explorer side), full trust boundary.
 *
 * Covers: ready-before-load ordering, exact origin + source validation,
 * string and transferred-ArrayBuffer payloads, loaded/error replies,
 * duplicate rejection, timeout disarm, malformed messages, and disposal
 * on manual file load / unmount.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { effectScope, nextTick } from 'vue'
import { useJsonlEngine, resetJsonlEngineForTests } from '~/composables/useJsonlEngine'
import { useFileStore } from '~/stores/file'
import { useHandover } from '~/composables/useHandover'
import { FakeWorker, success, failure } from '~/tests/helpers/fakeWorker'

interface HostSpy {
  postMessage: ReturnType<typeof vi.fn>
  window: Window
}

function makeHost(): HostSpy {
  const postMessage = vi.fn()
  const window = { postMessage } as unknown as Window
  Object.defineProperty(globalThis.window, 'opener', { value: window, configurable: true })
  return { postMessage, window }
}

function sentTypes(host: HostSpy): string[] {
  return host.postMessage.mock.calls.map(([data]) => (data as { type: string }).type)
}

function lastOfType(host: HostSpy, type: string): Record<string, unknown> | undefined {
  const calls = host.postMessage.mock.calls
  for (let i = calls.length - 1; i >= 0; i--) {
    const data = calls[i]![0] as { type?: string }
    if (data.type === type) return calls[i]![0] as Record<string, unknown>
  }
  return undefined
}

function lastReplyOrigin(host: HostSpy): string | undefined {
  return host.postMessage.mock.calls.at(-1)?.[1] as string | undefined
}

/**
 * Dispatch a synthetic message event with a controllable origin/source —
 * the only way to simulate a CROSS-ORIGIN postMessage in happy-dom.
 */
function deliver(
  data: unknown,
  options: { origin?: string; source?: unknown } = {},
): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      data,
      origin: options.origin ?? location.origin,
      // Default: the stubbed host (window.opener).
      source: options.source ?? (window.opener ?? undefined),
    }),
  )
}

function loadMessage(payload: string | ArrayBuffer, name = 'hand.jsonl') {
  return { ns: 'jsonl-explorer', v: 1, type: 'load', name, payload }
}

/** Answer the pending initMemory RPC (the manual FakeWorker is silent). */
async function answerInit(worker: FakeWorker, name: string, size: number): Promise<void> {
  const init = (await vi.waitFor(() => {
    const found = worker.posted.find((m) => (m as { type?: string }).type === 'initMemory')
    expect(found).toBeTruthy()
    return found
  })) as { requestId: string }
  worker.emit(success(init.requestId, { name, size, type: 'handover' }))
}

async function settleIndex(worker: FakeWorker, rows: number): Promise<void> {
  // The engine auto-starts the background index after init: answer the
  // index RPC, then commit the row count via the indexComplete event
  // (the event must carry the operation id the engine is tracking).
  const index = (await vi.waitFor(() => {
    const found = worker.posted.find((m) => (m as { type?: string }).type === 'index')
    expect(found).toBeTruthy()
    return found
  })) as { requestId: string; operationId: string }
  worker.emit(success(index.requestId, null))
  worker.emit({
    ns: 'jsonl-explorer',
    v: 1,
    type: 'indexComplete',
    operationId: index.operationId,
    totalRows: rows,
    totalBytes: rows * 4,
    durationMs: 1,
    generation: 1,
  })
}

describe('handover handshake (TSK0037)', () => {
  let pinia: Pinia
  let worker: FakeWorker
  let host: HostSpy
  let scope: ReturnType<typeof effectScope>

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    resetJsonlEngineForTests()
    worker = new FakeWorker()
    useJsonlEngine({ workerFactory: () => worker as unknown as Worker })
    host = makeHost()
    scope = effectScope()
  })

  afterEach(() => {
    scope.stop()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    // Drop the stubbed opener for the next test.
    Object.defineProperty(window, 'opener', { value: null, configurable: true })
  })

  function startHandover(options: Parameters<typeof useHandover>[0] = {}) {
    let started: ReturnType<typeof useHandover> | undefined
    scope.run(() => {
      started = useHandover(options)
    })
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return started!
  }

  it('refuses to start when standalone (no host window)', () => {
    Object.defineProperty(window, 'opener', { value: null, configurable: true })
    const handover = startHandover()
    expect(handover.start()).toBe(false)
    expect(handover.waiting.value).toBe(false)
  })

  it('posts ready to the exact same-origin, and the listener is already armed', () => {
    const handover = startHandover()
    expect(handover.start()).toBe(true)
    // ready went to the host's exact origin (never '*').
    expect(host.postMessage).toHaveBeenCalledTimes(1)
    expect(host.postMessage.mock.calls[0]).toEqual([
      { ns: 'jsonl-explorer', v: 1, type: 'ready' },
      location.origin,
    ])
    // The listener was installed BEFORE ready was posted: a load
    // delivered the instant after start() is accepted.
    deliver(loadMessage('{"a":1}\n'))
    expect(worker.posted.some((m) => (m as { type?: string }).type === 'initMemory')).toBe(true)
  })

  it('loads a string payload and replies loaded with the index row count', async () => {
    const handover = startHandover({ maxPayloadBytes: 1024 })
    handover.start()

    deliver(loadMessage('{"a":1}\n{"b":2}\n'))
    await answerInit(worker, 'hand.jsonl', 16)
    await vi.waitFor(() =>
      expect(useFileStore().metadata?.name).toBe('hand.jsonl'),
    )
    expect(useFileStore().metadata?.type).toBe('handover')
    expect(handover.waiting.value).toBe(false)

    await settleIndex(worker, 2)
    await vi.waitFor(() => expect(sentTypes(host)).toContain('loaded'))
    expect(lastOfType(host, 'loaded')).toMatchObject({ type: 'loaded', lines: 2 })
    expect(lastReplyOrigin(host)).toBe(location.origin)
  })

  it('loads a transferred ArrayBuffer payload', async () => {
    const handover = startHandover({ maxPayloadBytes: 1024 })
    handover.start()

    const buffer = new TextEncoder().encode('{"a":1}\n').buffer
    deliver(loadMessage(buffer))
    await answerInit(worker, 'hand.jsonl', 8)
    await vi.waitFor(() => expect(useFileStore().hasFile).toBe(true))
    const init = worker.posted.find((m) => (m as { type?: string }).type === 'initMemory') as {
      payload: unknown
    }
    expect(init.payload).toBeInstanceOf(ArrayBuffer)
    expect(worker.transferred).toContain(buffer)
  })

  it('ignores a load from a wrong origin (no state, no reply)', () => {
    const handover = startHandover({ maxPayloadBytes: 1024 })
    handover.start()

    deliver(loadMessage('{"a":1}\n'), { origin: 'https://evil.example', source: host.window })
    expect(worker.posted.some((m) => (m as { type?: string }).type === 'initMemory')).toBe(false)
    expect(host.postMessage).toHaveBeenCalledTimes(1) // only ready
    expect(handover.waiting.value).toBe(true) // still waiting
  })

  it('ignores a load from a different window on a good origin', () => {
    const handover = startHandover({ maxPayloadBytes: 1024 })
    handover.start()

    const impostor = { postMessage: vi.fn() } as unknown as Window
    deliver(loadMessage('{"a":1}\n'), { source: impostor })
    expect(worker.posted.some((m) => (m as { type?: string }).type === 'initMemory')).toBe(false)
    expect(handover.waiting.value).toBe(true)
  })

  it('rejects an oversized payload with an actionable error and stays armed', async () => {
    const cap = 1024 * 1024 // 1 MiB
    const handover = startHandover({ maxPayloadBytes: cap })
    handover.start()

    deliver(loadMessage('a'.repeat(cap + 1))) // 1 MiB + 1
    await vi.waitFor(() => expect(sentTypes(host)).toContain('error'))
    const err = lastOfType(host, 'error') as { message: string }
    expect(err.message).toContain('1 MiB')
    expect(worker.posted.some((m) => (m as { type?: string }).type === 'initMemory')).toBe(false)

    // Still armed: a retry within the window is accepted.
    deliver(loadMessage('1234\n'))
    expect(worker.posted.some((m) => (m as { type?: string }).type === 'initMemory')).toBe(true)
  })

  it('ignores duplicate loads while in flight AND after the session settled', async () => {
    const handover = startHandover({ maxPayloadBytes: 1024 })
    handover.start()

    deliver(loadMessage('{"a":1}\n', 'first.jsonl'))
    await answerInit(worker, 'first.jsonl', 8)
    await vi.waitFor(() => expect(useFileStore().metadata?.name).toBe('first.jsonl'))
    deliver(loadMessage('{"a":2}\n', 'second.jsonl')) // in flight: ignored
    // Settle the session (index commits → loaded reply → in-flight cleared).
    await settleIndex(worker, 1)
    await vi.waitFor(() => expect(sentTypes(host)).toContain('loaded'))
    // After settlement the ownership is permanent: a late load is still
    // ignored (the file is showing; re-loading would race the user).
    deliver(loadMessage('{"a":3}\n', 'third.jsonl'))
    const inits = worker.posted.filter((m) => (m as { type?: string }).type === 'initMemory')
    expect(inits).toHaveLength(1)
  })

  it('disarms after the 30 s handshake timeout; late loads are ignored', () => {
    vi.useFakeTimers()
    try {
      const handover = startHandover({ maxPayloadBytes: 1024, readyTimeoutMs: 30_000 })
      handover.start()
      expect(handover.waiting.value).toBe(true)

      vi.advanceTimersByTime(29_999)
      expect(handover.waiting.value).toBe(true)
      vi.advanceTimersByTime(1)
      expect(handover.waiting.value).toBe(false)

      deliver(loadMessage('{"a":1}\n'))
      expect(worker.posted.some((m) => (m as { type?: string }).type === 'initMemory')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores malformed messages (bad ns/v/type, empty name, wrong payload type)', () => {
    const handover = startHandover({ maxPayloadBytes: 1024 })
    handover.start()

    deliver({ ns: 'other', v: 1, type: 'load', name: 'x', payload: 'a' })
    deliver({ ns: 'jsonl-explorer', v: 2, type: 'load', name: 'x', payload: 'a' })
    deliver({ ns: 'jsonl-explorer', v: 1, type: 'ready' }) // inbound ready: not a load
    deliver({ ns: 'jsonl-explorer', v: 1, type: 'load', name: '', payload: 'a' })
    deliver({ ns: 'jsonl-explorer', v: 1, type: 'load', name: 'x', payload: { a: 1 } })
    deliver({ ns: 'jsonl-explorer', v: 1, type: 'load', name: 'x' }) // no payload

    expect(worker.posted.some((m) => (m as { type?: string }).type === 'initMemory')).toBe(false)
    expect(sentTypes(host)).toEqual(['ready'])
  })

  it('replies error when the worker rejects the load, and stays armed for a retry', async () => {
    const handover = startHandover({ maxPayloadBytes: 1024 })
    handover.start()

    deliver(loadMessage('{"a":1}\n'))
    const init = (await vi.waitFor(
      () => {
        const found = worker.posted.find((m) => (m as { type?: string }).type === 'initMemory')
        expect(found).toBeTruthy()
        return found
      },
    )) as { requestId: string }
    worker.emit(
      failure(init.requestId, 'HANDOVER_PAYLOAD_TOO_LARGE', 'Handover payload exceeds the cap'),
    )
    await vi.waitFor(() => expect(sentTypes(host)).toContain('error'))
    expect(lastOfType(host, 'error')?.['message']).toBe('Handover payload exceeds the cap')
    expect(useFileStore().hasFile).toBe(false)

    // Retry succeeds this time (manual worker answers ok).
    deliver(loadMessage('{"a":1}\n', 'retry.jsonl'))
    const retry = (await vi.waitFor(
      () => {
        const found = worker.posted
          .filter((m) => (m as { type?: string }).type === 'initMemory')
          .at(-1)
        expect(found).toBeTruthy()
        return found
      },
    )) as { requestId: string }
    worker.emit(
      success(retry.requestId, { name: 'retry.jsonl', size: 8, type: 'handover' }),
    )
    await vi.waitFor(() => expect(useFileStore().metadata?.name).toBe('retry.jsonl'))
  })

  it('replies loaded only for the accepted load (a replaced file drops it)', async () => {
    const handover = startHandover({ maxPayloadBytes: 1024 })
    handover.start()

    deliver(loadMessage('{"a":1}\n', 'hand.jsonl'))
    await answerInit(worker, 'hand.jsonl', 8)
    await vi.waitFor(() => expect(useFileStore().metadata?.name).toBe('hand.jsonl'))

    // The user replaces the source (manual load): the pending reply must
    // not fire for the old name.
    const file = new File(['{"z":9}\n'], 'manual.jsonl')
    void useFileStore().loadFile(file)
    await vi.waitFor(() => {
      const init = worker.posted.find((m) => (m as { type?: string }).type === 'initFile') as {
        requestId: string
      }
      if (init) worker.emit(success(init.requestId, { name: 'manual.jsonl', size: 9, type: 'file' }))
      expect(useFileStore().metadata?.name).toBe('manual.jsonl')
    })
    await settleIndex(worker, 1)
    await new Promise((r) => setTimeout(r, 20))
    expect(sentTypes(host)).not.toContain('loaded')
  })

  it('disposes on manual file load: no further loads are accepted', async () => {
    const handover = startHandover({ maxPayloadBytes: 1024 })
    handover.start()
    expect(handover.waiting.value).toBe(true)

    const file = new File(['{"z":9}\n'], 'manual.jsonl')
    void useFileStore().loadFile(file)
    await vi.waitFor(() => {
      const init = worker.posted.find((m) => (m as { type?: string }).type === 'initFile') as {
        requestId: string
      }
      if (init) worker.emit(success(init.requestId, { name: 'manual.jsonl', size: 9, type: 'file' }))
      expect(useFileStore().metadata).not.toBeNull()
    })
    // The hasFile watch (which disarms the receiver) flushes on nextTick.
    await nextTick()

    deliver(loadMessage('{"a":1}\n'))
    expect(
      worker.posted.filter((m) => (m as { type?: string }).type === 'initMemory').length,
    ).toBe(0)
  })
})
