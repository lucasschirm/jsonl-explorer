/**
 * OpfsSpool — incremental OPFS byte spool for streamed URL data.
 *
 * Appends land in an OPFS artifact (`spool-<uuid>.jsonl` under the origin's
 * `navigator.storage` root) via a `FileSystemWritableFileStream`; random
 * reads go back through `getFile().slice()`, which OPFS serves efficiently
 * from disk. Quota exhaustion surfaces as a typed `SpoolQuotaExceededError`
 * so callers can fall back to paged memory (ADR-008).
 *
 * Disposal removes the artifact; it is idempotent and tolerant of
 * not-found (crash cleanup leaves nothing behind).
 */

import { normalizeLength, normalizeOffset } from '../sources/source.js'
import { offsetToNumber } from '../indexer.js'

import { SpoolDisposedError, SpoolQuotaExceededError, SpoolSealedError } from './spool.js'
import type { ByteSpool } from './spool.js'

export interface OpfsSpoolOptions {
  /**
   * Root directory handle. Defaults to `navigator.storage.getDirectory()`.
   * Injectable for tests.
   */
  rootDirectory?: FileSystemDirectoryHandle
}

/** Resolves the default OPFS root, rejecting when OPFS is unavailable. */
async function defaultRoot(): Promise<FileSystemDirectoryHandle> {
  const storage = navigator.storage
  if (!storage || typeof storage.getDirectory !== 'function') {
    throw new Error('OPFS is unavailable (navigator.storage.getDirectory missing)')
  }
  return storage.getDirectory()
}

/** Maps a failed write to `SpoolQuotaExceededError` when the cause is quota. */
function mapQuotaError(error: unknown, artifactName: string): void {
  if (
    error instanceof DOMException &&
    (error.name === 'QuotaExceededError' || error.code === 22)
  ) {
    throw new SpoolQuotaExceededError(artifactName)
  }
}

export class OpfsSpool implements ByteSpool {
  readonly kind = 'opfs' as const
  readonly artifactName: string
  private readonly root: FileSystemDirectoryHandle
  private readonly handle: FileSystemFileHandle
  private stream: FileSystemWritableFileStream | null = null
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null
  private size = 0n
  private sealed = false
  private disposed = false

  private constructor(artifactName: string, root: FileSystemDirectoryHandle, handle: FileSystemFileHandle) {
    this.artifactName = artifactName
    this.root = root
    this.handle = handle
  }

  /** Creates (or reopens) the artifact and returns a ready spool. */
  static async create(artifactName: string, options: OpfsSpoolOptions = {}): Promise<OpfsSpool> {
    const root = options.rootDirectory ?? (await defaultRoot())
    const handle = await root.getFileHandle(artifactName, { create: true })
    return new OpfsSpool(artifactName, root, handle)
  }

  async append(chunk: Uint8Array): Promise<void> {
    this.assertActive()
    if (this.sealed) throw new SpoolSealedError(this.artifactName)
    if (chunk.length === 0) return
    const writer = await this.ensureWriter()
    try {
      await writer.write(chunk)
    } catch (error) {
      mapQuotaError(error, this.artifactName)
      throw error
    }
    this.size += BigInt(chunk.length)
  }

  async getSize(): Promise<bigint> {
    this.assertActive()
    return this.size
  }

  async readRange(offset: bigint | number, length: number): Promise<Uint8Array> {
    this.assertActive()
    const start = normalizeOffset(offset)
    if (start >= this.size) return new Uint8Array(0)
    const requested = BigInt(normalizeLength(length))
    const end = start + requested < this.size ? start + requested : this.size
    // Number conversion only at the Blob.slice boundary, after the
    // safe-integer check (documents beyond 2^53 bytes are not addressable
    // through Blob offsets regardless).
    const file = await this.handle.getFile()
    const blob = file.slice(offsetToNumber(start), offsetToNumber(end))
    return new Uint8Array(await blob.arrayBuffer())
  }

  async seal(): Promise<void> {
    this.assertActive()
    this.sealed = true
    await this.closeWriter()
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.closeWriter()
    try {
      await this.root.removeEntry(this.artifactName)
    } catch {
      // Already gone (crash cleanup, prior dispose): nothing to do.
    }
  }

  private async ensureWriter(): Promise<WritableStreamDefaultWriter<Uint8Array>> {
    if (this.writer) return this.writer
    this.stream = await this.handle.createWritable()
    this.writer = this.stream.getWriter()
    return this.writer
  }

  private async closeWriter(): Promise<void> {
    const writer = this.writer
    this.writer = null
    this.stream = null
    if (!writer) return
    try {
      await writer.close()
    } catch {
      // Closing an already-failed/aborted stream is best effort.
    }
  }

  private assertActive(): void {
    if (this.disposed) throw new SpoolDisposedError(this.artifactName)
  }
}
