/**
 * Shared worker fakes for main-thread engine tests.
 *
 * `FakeWorker` is a minimal `Worker` stand-in: it captures posted messages
 * (and transfer lists), lets tests deliver `message`/`error` events, and
 * counts terminates. `AutoWorker` extends it with canned per-type responses
 * and optional gating (hold messages until `release()`) to simulate
 * long-running operations.
 */
import { PROTOCOL_NAMESPACE, PROTOCOL_VERSION } from '@jsonl-explorer/shared'

export class FakeWorker {
  readonly posted: unknown[] = []
  /** Buffers the client asked to transfer (a real postMessage detaches them). */
  readonly transferred: Transferable[] = []
  terminated = 0
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  onmessageerror: ((event: unknown) => void) | null = null
  private listeners = new Map<string, Set<(event: { data: unknown }) => void>>()

  postMessage(message: unknown, transfer?: Transferable[]): void {
    this.posted.push(message)
    this.transferred.push(...(transfer ?? []))
  }

  addEventListener(type: string, handler: (event: { data: unknown }) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(handler)
  }

  removeEventListener(type: string, handler: (event: { data: unknown }) => void): void {
    this.listeners.get(type)?.delete(handler)
  }

  emit(data: unknown): void {
    this.onmessage?.({ data })
    this.listeners.get('message')?.forEach((handler) => handler({ data }))
  }

  fail(): void {
    this.onerror?.({})
  }

  terminate(): void {
    this.terminated += 1
  }

  get last(): { type?: string; requestId?: string } {
    return this.posted[this.posted.length - 1] as { type?: string; requestId?: string }
  }
}

interface AutoWorkerMessage {
  type?: string
  requestId?: string
  file?: File
  name?: string
}

/**
 * Auto-answering worker. Message types listed in `gate` are held until
 * `release()` — used to simulate long-running inits/filters.
 */
export class AutoWorker extends FakeWorker {
  private held: unknown[] = []
  private gate: Set<string>

  constructor(options: { gate?: string[] } = {}) {
    super()
    this.gate = new Set(options.gate ?? [])
  }

  setGate(types: string[] | null): void {
    this.gate = new Set(types ?? [])
  }

  override postMessage(message: unknown, transfer?: Transferable[]): void {
    const msg = message as AutoWorkerMessage
    // Always record for test inspection; gated responses are only delayed.
    super.postMessage(message, transfer)
    if (msg.type && this.gate.has(msg.type)) {
      this.held.push(message)
      return
    }
    queueMicrotask(() => this.respond(msg))
  }

  release(): void {
    const pending = this.held
    this.held = []
    for (const message of pending) this.respond(message as AutoWorkerMessage)
  }

  private respond(msg: AutoWorkerMessage): void {
    const value =
      msg.type === 'initFile'
        ? { name: msg.file?.name ?? 'a.jsonl', size: 11, type: 'file' as const }
        : msg.type === 'initUrl'
          ? { name: 'remote.jsonl', size: 22, type: 'url' as const }
          : msg.type === 'initMemory'
            ? { name: msg.name ?? 'handover.jsonl', size: 33, type: 'handover' as const }
            : msg.type === 'filter'
              ? { matchedRows: 3, totalRows: 10, generation: 1, partial: false }
              : msg.type === 'getRows'
                ? { rows: [], generation: 1, totalFiltered: 3 }
                : msg.type === 'dispose'
                  ? { disposed: true }
                  : null
    this.emit({ ns: PROTOCOL_NAMESPACE, v: PROTOCOL_VERSION, requestId: msg.requestId, ok: true, value })
  }
}

/** Success envelope for a canned RPC response. */
export function success(requestId: string, value: unknown) {
  return { ns: PROTOCOL_NAMESPACE, v: PROTOCOL_VERSION, requestId, ok: true, value }
}

/** Error envelope for a canned RPC response. */
export function failure(requestId: string, code: string, message: string) {
  return { ns: PROTOCOL_NAMESPACE, v: PROTOCOL_VERSION, requestId, ok: false, error: { code, message } }
}
