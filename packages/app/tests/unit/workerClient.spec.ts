import { describe, it, expect, vi } from 'vitest'
import {
  WorkerClient,
  EngineRpcError,
  EngineDisposedError,
  EngineFatalError,
  InitInProgressError,
  SourceReplacedError,
} from '~/engine/workerClient'
import { PROTOCOL_NAMESPACE, PROTOCOL_VERSION } from '@jsonl-explorer/shared'
import { FakeWorker, success, failure } from '../helpers/fakeWorker'

function makeClient(workers: FakeWorker[]): WorkerClient {
  return new WorkerClient({
    workerFactory: () => {
      const worker = new FakeWorker()
      workers.push(worker)
      return worker as unknown as Worker
    },
  })
}

describe('WorkerClient RPC correlation', () => {
  it('resolves responses by requestId, out of order', async () => {
    const workers: FakeWorker[] = []
    const client = makeClient(workers)

    const file = new File(['a'], 'a.jsonl')
    const initPromise = client.initFile(file)
    const linePromise = client.getLine(7)
    const worker = workers[0]!

    // Respond in reverse order.
    worker.emit(success(worker.last.requestId!, { lineId: 7, text: 'seven', isEdited: false }))
    const initMessage = worker.posted.find((m) => (m as { type?: string }).type === 'initFile') as unknown as {
      requestId: string
    }
    worker.emit(success(initMessage.requestId, { name: 'a.jsonl', size: 1, type: 'file' }))

    await expect(linePromise).resolves.toEqual({ lineId: 7, text: 'seven', isEdited: false })
    await expect(initPromise).resolves.toEqual({ name: 'a.jsonl', size: 1, type: 'file' })
  })

  it('rejects worker error responses with EngineRpcError carrying the code', async () => {
    const workers: FakeWorker[] = []
    const client = makeClient(workers)

    const promise = client.getLine(1)
    const worker = workers[0]!
    worker.emit(failure(worker.last.requestId!, 'SOURCE_NOT_INITIALIZED', 'Source not initialized'))

    await expect(promise).rejects.toBeInstanceOf(EngineRpcError)
    await expect(promise).rejects.toMatchObject({ code: 'SOURCE_NOT_INITIALIZED' })
  })


  it('transfers handover ArrayBuffers instead of cloning them', async () => {
    const workers: FakeWorker[] = []
    const client = makeClient(workers)

    const buffer = new ArrayBuffer(8)
    const promise = client.initMemory('handover', buffer)
    const worker = workers[0]!
    const initRequestId = (worker.posted[0] as { requestId: string }).requestId
    // The client must pass the buffer in the transfer list (a real
    // postMessage detaches it on the sending side).
    expect(worker.transferred).toContain(buffer)

    // Non-buffer payloads are posted without a transfer list.
    const linePromise = client.getLine(1)
    expect(worker.transferred).toHaveLength(1)
    worker.emit(success(worker.last.requestId!, { lineId: 1, text: 'one', isEdited: false }))
    await linePromise

    worker.emit(success(initRequestId, { name: 'handover', size: 8, type: 'handover' }))
    await promise
  })

  it('tags init requests with an operationId and exposes it as activeOperationId', async () => {
    const workers: FakeWorker[] = []
    const client = makeClient(workers)

    const promise = client.initFile(new File(['x'], 'x.jsonl'))
    const worker = workers[0]!
    const initMessage = worker.posted[0] as { type: string; operationId?: string; requestId: string }
    expect(initMessage.type).toBe('initFile')
    expect(typeof initMessage.operationId).toBe('string')
    expect(client.activeOperationId).toBe(initMessage.operationId)
    worker.emit(success(initMessage.requestId, { name: 'x.jsonl', size: 1, type: 'file' }))
    await promise
  })
})

describe('WorkerClient init races', () => {
  it('rejects a concurrent init with InitInProgressError', async () => {
    const workers: FakeWorker[] = []
    const client = makeClient(workers)

    const first = client.initFile(new File(['a'], 'a.jsonl'))
    await expect(client.initUrl('https://example.com/b.jsonl')).rejects.toBeInstanceOf(InitInProgressError)
    await expect(client.initMemory('m', '[]\n')).rejects.toBeInstanceOf(InitInProgressError)

    // Finishing the first init re-arms the engine for a new init.
    const worker = workers[0]!
    worker.emit(success(worker.last.requestId!, { name: 'a.jsonl', size: 1, type: 'file' }))
    await first
    const second = client.initMemory('m', '[]\n')
    const workerAfter = workers[0]!
    workerAfter.emit(success(workerAfter.last.requestId!, { name: 'm', size: 3, type: 'handover' }))
    await expect(second).resolves.toEqual({ name: 'm', size: 3, type: 'handover' })
  })

  it('rejects in-flight RPCs with SourceReplacedError when a new init starts', async () => {
    const workers: FakeWorker[] = []
    const client = makeClient(workers)

    const rowsPromise = client.getRows({ start: 0, count: 10, generation: 1 })
    const initPromise = client.initFile(new File(['b'], 'b.jsonl'))
    await expect(rowsPromise).rejects.toBeInstanceOf(SourceReplacedError)
    const worker = workers[0]!
    worker.emit(success(worker.last.requestId!, { name: 'b.jsonl', size: 1, type: 'file' }))
    await initPromise
  })
})

describe('WorkerClient fatal handling', () => {
  it('a worker error rejects pending RPCs, fires onError, and blocks new RPCs', async () => {
    const workers: FakeWorker[] = []
    const client = makeClient(workers)
    const errors: Error[] = []
    client.onError((error) => errors.push(error))

    const pending = client.getLine(3)
    workers[0]!.fail()

    await expect(pending).rejects.toBeInstanceOf(EngineFatalError)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(EngineFatalError)
    await expect(client.getLine(4)).rejects.toBeInstanceOf(EngineFatalError)
    await expect(client.initFile(new File(['z'], 'z.jsonl'))).rejects.toBeInstanceOf(EngineFatalError)
  })

  it('reset() terminates the dead worker and the next RPC spawns a fresh one', async () => {
    const workers: FakeWorker[] = []
    const client = makeClient(workers)

    const pending = client.getLine(1)
    workers[0]!.fail()
    await expect(pending).rejects.toBeInstanceOf(EngineFatalError)

    await client.reset()
    expect(workers[0]!.terminated).toBe(1)

    const promise = client.getLine(2)
    expect(workers).toHaveLength(2)
    workers[1]!.emit(success(workers[1]!.last.requestId!, { lineId: 2, text: 'two', isEdited: false }))
    await expect(promise).resolves.toMatchObject({ lineId: 2 })
  })

  it('does not double-fire fatal for repeated errors', async () => {
    const workers: FakeWorker[] = []
    const client = makeClient(workers)
    const errors: Error[] = []
    client.onError((error) => errors.push(error))

    const promise = client.getLine(1)
    workers[0]!.fail()
    workers[0]!.fail()
    await expect(promise).rejects.toBeInstanceOf(EngineFatalError)
    expect(errors).toHaveLength(1)
  })
})

describe('WorkerClient disposal', () => {
  it('dispose() sends a graceful dispose request, then terminates', async () => {
    const workers: FakeWorker[] = []
    const client = makeClient(workers)

    const initPromise = client.initFile(new File(['a'], 'a.jsonl'))
    const worker = workers[0]!
    worker.emit(success(worker.last.requestId!, { name: 'a.jsonl', size: 1, type: 'file' }))
    await initPromise

    const disposePromise = client.dispose()
    const disposeMessage = worker.posted.find(
      (m) => (m as { type?: string }).type === 'dispose',
    ) as { requestId: string }
    expect(disposeMessage).toBeTruthy()
    worker.emit(success(disposeMessage.requestId, { disposed: true }))
    await disposePromise
    expect(worker.terminated).toBe(1)
  })

  it('rejects RPCs after dispose with EngineDisposedError', async () => {
    const workers: FakeWorker[] = []
    const client = makeClient(workers)
    await client.dispose()
    await expect(client.getLine(1)).rejects.toBeInstanceOf(EngineDisposedError)
    await expect(client.initFile(new File(['a'], 'a.jsonl'))).rejects.toBeInstanceOf(EngineDisposedError)
    // dispose is idempotent
    await client.dispose()
    expect(workers).toHaveLength(0)
  })

  it('clearSource() posts the worker-side dispose RPC without terminating', async () => {
    const workers: FakeWorker[] = []
    const client = makeClient(workers)
    const initPromise = client.initFile(new File(['a'], 'a.jsonl'))
    const worker = workers[0]!
    worker.emit(success(worker.last.requestId!, { name: 'a.jsonl', size: 1, type: 'file' }))
    await initPromise

    const clearPromise = client.clearSource()
    worker.emit(success(worker.last.requestId!, { disposed: true }))
    await expect(clearPromise).resolves.toBeUndefined()
    expect(worker.terminated).toBe(0)
  })
})

describe('WorkerClient events and consent relay', () => {
  it('routes engine events to onProgress subscribers and honors unsubscribe', async () => {
    const workers: FakeWorker[] = []
    const client = makeClient(workers)
    const seen: string[] = []
    const unsubscribe = client.onProgress((event) => seen.push(event.type))

    // A pending RPC forces the worker to spawn.
    client.getLine(1)
    const worker = workers[0]!
    worker.emit({
      ns: PROTOCOL_NAMESPACE,
      v: PROTOCOL_VERSION,
      type: 'indexProgress',
      operationId: 'op-1',
      progress: 50,
      committedRows: 5,
      committedBytes: 100,
    })
    unsubscribe()
    worker.emit({
      ns: PROTOCOL_NAMESPACE,
      v: PROTOCOL_VERSION,
      type: 'urlProgress',
      operationId: 'op-1',
      receivedBytes: 1,
    })

    expect(seen).toEqual(['indexProgress'])
  })

  it('relays urlFallbackConfirm with the handler decision', async () => {
    const workers: FakeWorker[] = []
    const client = makeClient(workers)

    client.onUrlFallbackConfirm(() => true)
    client.getLine(1) // forces the worker to spawn
    const worker = workers[0]!
    worker.emit({
      ns: PROTOCOL_NAMESPACE,
      v: PROTOCOL_VERSION,
      type: 'urlFallbackConfirm',
      requestId: 'req-fb-1',
      operationId: 'op-9',
      url: 'https://example.com/big.jsonl',
      declaredBytes: 10,
      reason: 'opfs-quota-exceeded',
    })
    await vi.waitFor(() => {
      const reply = worker.posted.find((m) => (m as { type?: string }).type === 'urlFallbackConfirm') as {
        accept?: boolean
        operationId?: string
      }
      expect(reply).toBeTruthy()
      expect(reply.accept).toBe(true)
      expect(reply.operationId).toBe('op-9')
    })
  })

  it('declines the fallback when the handler says no or none is registered', async () => {
    const workers: FakeWorker[] = []
    const client = makeClient(workers)
    client.onUrlFallbackConfirm(() => false)
    client.getLine(1)
    const worker = workers[0]!
    worker.emit({
      ns: PROTOCOL_NAMESPACE,
      v: PROTOCOL_VERSION,
      type: 'urlFallbackConfirm',
      requestId: 'req-fb-2',
      operationId: 'op-10',
      url: 'https://example.com/big.jsonl',
      reason: 'opfs-unavailable',
    })
    await vi.waitFor(() => {
      const reply = worker.posted.find((m) => (m as { type?: string }).type === 'urlFallbackConfirm') as {
        accept?: boolean
      }
      expect(reply.accept).toBe(false)
    })

    // No handler at all ⇒ safe default (decline), never a silent fallback.
    const workers2: FakeWorker[] = []
    const client2 = makeClient(workers2)
    client2.getLine(1)
    workers2[0]!.emit({
      ns: PROTOCOL_NAMESPACE,
      v: PROTOCOL_VERSION,
      type: 'urlFallbackConfirm',
      requestId: 'req-fb-3',
      operationId: 'op-11',
      url: 'https://example.com/big.jsonl',
      reason: 'opfs-unavailable',
    })
    await vi.waitFor(() => {
      const reply = workers2[0]!.posted.find((m) => (m as { type?: string }).type === 'urlFallbackConfirm') as {
        accept?: boolean
      }
      expect(reply.accept).toBe(false)
    })
  })

  it('replays the last terminal view event to late subscribers, same session only', async () => {
    // Regression (TSK0039): for fast loads (small ?url= file) the index
    // commits BEFORE the explorer panel mounts, so component-level stores
    // subscribe after the indexComplete dispatch and would render an
    // empty view without a replay.
    const workers: FakeWorker[] = []
    const client = makeClient(workers)

    const initPromise = client.initMemory('fast.jsonl', '{"a":1}\n')
    const worker = workers[0]!
    const initMessage = worker.last as { requestId: string; operationId?: string }
    worker.emit(success(initMessage.requestId, { name: 'fast.jsonl', size: 8, type: 'handover' }))
    await initPromise
    worker.emit({
      ns: PROTOCOL_NAMESPACE,
      v: PROTOCOL_VERSION,
      type: 'indexComplete',
      operationId: initMessage.operationId ?? 'op-x',
      totalRows: 1,
      totalBytes: 8,
      durationMs: 1,
      generation: 1,
    })

    // Late subscriber (the panel mounting after the commit) gets the
    // event — deferred to a microtask so it lands after the caller's
    // synchronous store-setup/reset sequence.
    const seen: number[] = []
    client.onProgress((event) => {
      if (event.type === 'indexComplete') seen.push(event.totalRows)
    })
    await Promise.resolve()
    expect(seen).toEqual([1])

    // A NEW load starts a new session: the stale event is not replayed.
    const init2 = client.initMemory('second.jsonl', '{"b":2}\n')
    worker.emit(success(worker.last.requestId!, { name: 'second.jsonl', size: 8, type: 'handover' }))
    await init2
    const seen2: number[] = []
    client.onProgress((event) => {
      if (event.type === 'indexComplete') seen2.push(event.totalRows)
    })
    await Promise.resolve()
    expect(seen2).toEqual([])
  })
})
