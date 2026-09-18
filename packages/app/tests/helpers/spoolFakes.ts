/**
 * Shared fakes for spool / URL-source tests (TSK0014/TSK0015).
 *
 * happy-dom has no OPFS and an incomplete fetch/Response, so these fakes
 * stand in for the storage and network layers: in-memory OPFS dir/file
 * handles (with quota enforcement and `values()`), and a duck-typed
 * `fetch` returning a Response-like object built from chunks.
 */

import type { OpfsStorageLike } from '../../engine/spool/index.js'

// ============================================================================
// Helpers
// ============================================================================

export const encoder = new TextEncoder()

export function encode(text: string): Uint8Array {
  return encoder.encode(text)
}

export function patternBytes(total: number): Uint8Array {
  const out = new Uint8Array(total)
  for (let i = 0; i < total; i++) out[i] = (i * 7 + 3) % 256
  return out
}

export function splitBytes(bytes: Uint8Array, chunkSizes: number[]): Uint8Array[] {
  const out: Uint8Array[] = []
  let pos = 0
  for (const size of chunkSizes) {
    if (pos >= bytes.length) break
    out.push(bytes.slice(pos, pos + size))
    pos += size
  }
  return out
}

// --- Fake OPFS -------------------------------------------------------------

export class FakeFileHandle {
  readonly kind = 'file' as const
  name: string
  data: Uint8Array = new Uint8Array(0)
  closedWritables = 0
  quotaLimit: number | null = null

  constructor(name: string, quotaLimit: number | null = null) {
    this.name = name
    this.quotaLimit = quotaLimit
  }

  /**
   * Faithful to REAL OPFS semantics (verified in Chromium, TSK0046):
   * - writes are STAGED on the writable and only become visible through
   *   getFile() once the writable is CLOSED;
   * - `keepExistingData: false` (default) truncates the file on open;
   * - `keepExistingData: true` does NOT append: the writable starts at
   *   OFFSET 0 and OVERWRITES in place (a shorter write SHRINKS the
   *   file). This is why the spool must not use close-per-append
   *   cycles on one file — each cycle was silently clobbering the
   *   file's beginning (the old fake modeled append-at-end, which
   *   masked the bug; TSK0039's staged-write fix is preserved).
   */
  async createWritable(options?: { keepExistingData?: boolean }) {
    let closed = false
    const self = this
    let staged = options?.keepExistingData ? this.data.slice() : new Uint8Array(0)
    let position = 0
    return {
      getWriter() {
        return {
          async write(chunk: Uint8Array): Promise<void> {
            if (closed) throw new Error('Writer is closed')
            const projectedSize = Math.max(staged.length, position + chunk.length)
            if (self.quotaLimit !== null && projectedSize > self.quotaLimit) {
              throw new DOMException('Exceeded quota', 'QuotaExceededError')
            }
            const next = new Uint8Array(Math.max(staged.length, position + chunk.length))
            next.set(staged, 0)
            next.set(chunk, position)
            position += chunk.length
            staged = next
          },
          async close(): Promise<void> {
            if (closed) return
            closed = true
            self.data = staged
            self.closedWritables++
          },
          async abort(): Promise<void> {
            if (closed) return
            closed = true
            self.closedWritables++
          },
        }
      },
    }
  }

  async getFile(): Promise<File> {
    const self = this
    return {
      name: this.name,
      slice(start: number, end?: number): Blob {
        const data = self.data
        const s = Math.max(0, Math.floor(start))
        const e = end === undefined ? data.length : Math.min(Math.floor(end), data.length)
        const out = new Uint8Array(Math.max(0, e - s))
        out.set(data.subarray(s, e), 0)
        return new Blob([out])
      },
    } as unknown as File
  }
}

export class FakeDirHandle {
  entries = new Map<string, FakeFileHandle>()
  quotaLimit: number | null = null

  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    if (this.entries.has(name)) throw new DOMException('exists', 'TypeMismatchError')
    if (!options?.create) throw new DOMException('not found', 'NotFoundError')
    // Nested directories are not needed by the spool; return self-shaped fake.
    const dir = new FakeDirHandle()
    this.entries.set(name, dir as unknown as FakeFileHandle)
    return dir as unknown as FileSystemDirectoryHandle
  }

  async getFileHandle(name: string, options?: { create?: boolean }) {
    const existing = this.entries.get(name)
    if (existing) return existing as unknown as FileSystemFileHandle
    if (!options?.create) throw new DOMException('not found', 'NotFoundError')
    const file = new FakeFileHandle(name, this.quotaLimit)
    this.entries.set(name, file)
    return file as unknown as FileSystemFileHandle
  }

  async removeEntry(name: string, _options?: { recursive?: boolean }): Promise<void> {
    if (!this.entries.has(name)) throw new DOMException('not found', 'NotFoundError')
    this.entries.delete(name)
  }

  values(): AsyncIterableIterator<FileSystemHandle> {
    const values = [...this.entries.values()]
    let i = 0
    const iter = {
      [Symbol.asyncIterator]: () => iter,
      next: async (): Promise<IteratorResult<FileSystemHandle>> =>
        i < values.length
          ? { done: false, value: values[i++] as unknown as FileSystemHandle }
          : { done: true, value: undefined },
    }
    return iter as unknown as AsyncIterableIterator<FileSystemHandle>
  }
}

export interface FakeStorageOpts {
  quota?: number
  usage?: number
  /** Makes getDirectory() throw (OPFS unusable). */
  failGetDirectory?: boolean
}

export function makeFakeStorage(opts: FakeStorageOpts = {}) {
  const root = new FakeDirHandle()
  const storage: OpfsStorageLike = {
    getDirectory: async () => {
      if (opts.failGetDirectory) throw new DOMException('denied', 'SecurityError')
      return root as unknown as FileSystemDirectoryHandle
    },
    estimate: async () => ({ usage: opts.usage ?? 0, quota: opts.quota ?? 10 * 1024 * 1024 }),
  }
  return { root, storage }
}

// --- Fake fetch ------------------------------------------------------------

export interface FakeFetchOpts {
  /** Chunk sizes for the body stream; must cover the full payload. */
  chunks?: number[]
  headers?: Record<string, string>
  status?: number
  /** Reject the fetch call with a network error. */
  networkError?: boolean
  /** TypeError message thrown by fetch (default 'Failed to fetch'). */
  fetchError?: string
  /** Extra delay hook before each read resolves (tests gating aborts). */
  onRead?: (readIndex: number) => Promise<void> | void
  /** Omit the automatic Content-Length header (indeterminate size). */
  noContentLength?: boolean
  /** Final response URL (after redirects); defaults to the request URL. */
  finalUrl?: string
  /** Marks the response as having followed a redirect. */
  redirected?: boolean
  /** Response has no body at all (`body === null`). */
  noBody?: boolean
}

export function makeFetch(bytes: Uint8Array, opts: FakeFetchOpts = {}) {
  const calls: { url: string; headers?: Record<string, string>; signal?: AbortSignal }[] = []
  const headerMap = new Map<string, string>(Object.entries(opts.headers ?? {}))
  if (!opts.noContentLength && !headerMap.has('content-length') && !headerMap.has('content-encoding')) {
    headerMap.set('content-length', String(bytes.length))
  }
  const headers: Headers = {
    get: (name: string) => headerMap.get(name.toLowerCase()) ?? null,
  } as unknown as Headers
  const chunks = splitBytes(bytes, opts.chunks ?? [Math.max(1, bytes.length)])

  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: String(input),
      headers: init?.headers as Record<string, string> | undefined,
      signal: init?.signal ?? undefined,
    })
    if (opts.networkError) throw new TypeError(opts.fetchError ?? 'Failed to fetch')
    const status = opts.status ?? 200
    if (status >= 400) {
      return { ok: false, status, statusText: 'Not Found', headers, body: null } as unknown as Response
    }
    const signal = init?.signal
    let readIndex = 0
    return {
      ok: true,
      status,
      statusText: 'OK',
      url: opts.finalUrl ?? String(input),
      redirected: opts.redirected ?? false,
      headers,
      body: opts.noBody
        ? null
        : {
            getReader() {
              return {
                async read(): Promise<{ done: boolean; value?: Uint8Array }> {
                  if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
                  if (readIndex >= chunks.length) return { done: true }
                  const index = readIndex++
                  await opts.onRead?.(index)
                  if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
                  const value = chunks[index]!
                  return { done: false, value }
                },
              }
            },
          },
    } as unknown as Response
  }
  return { impl, calls }
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}


