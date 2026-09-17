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
    // OPFS: getFile() only reflects CLOSED writes. A long-lived writer
    // would therefore hide every streamed byte from concurrent reads
    // (the indexer reads through readRange while the download streams —
    // with an unclosed writer it would see an empty file forever).
    // Each append is thus ONE complete writable cycle: create → write →
    // close. `keepExistingData` preserves prior content across cycles;
    // the on-disk file is current after every append, and only the
    // in-flight chunk is held in RAM at a time.
    let writer: WritableStreamDefaultWriter<Uint8Array> | null = null
    try {
      const stream = await this.handle.createWritable({ keepExistingData: true })
      writer = stream.getWriter()
      await writer.write(chunk)
      await writer.close()
    } catch (error) {
      await writer?.abort().catch(() => {})
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
    // All appends already closed their writers: nothing to flush.
    this.sealed = true
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    try {
      await this.root.removeEntry(this.artifactName)
    } catch {
      // Already gone (crash cleanup, prior dispose): nothing to do.
    }
  }

  private assertActive(): void {
    if (this.disposed) throw new SpoolDisposedError(this.artifactName)
  }
}
