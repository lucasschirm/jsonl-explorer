/**
 * OpfsSpool — incremental OPFS byte spool for streamed URL data.
 *
 * OPFS `createWritable({ keepExistingData: true })` does NOT append: it
 * opens the file at offset 0 WITHOUT truncating, so a "close-per-append"
 * cycle silently OVERWRITES the file's beginning (verified in Chromium:
 * two such cycles leave only the last chunk on disk). Appending through
 * a single long-lived writer is equally unusable: `getFile()` only
 * reflects CLOSED writes, so concurrent reads would see an empty file.
 *
 * The spool therefore writes a SEQUENCE OF IMMUTABLE PART FILES
 * (`<artifact>-p<seq>`): each part is written exactly once
 * (create → write → close) and is never touched again. Reads walk a
 * small in-memory part table and slice each part through a CACHED
 * `getFile()` (safe: closed parts are immutable). Bytes that have not
 * filled a part yet live in a bounded in-RAM pending buffer and are
 * served from RAM. Every `readRange(offset, len)` with
 * `offset < getSize()` returns real bytes — the indexer's incremental
 * feed never sees an empty window.
 *
 * Disposal removes every part; it is idempotent and tolerant of
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

/** One part file = 1 MiB: bounds the RAM pending buffer and keeps the
 *  part count low (1024 parts per GiB) so dispose stays cheap. */
export const OPFS_PART_SIZE_BYTES = 1024 * 1024

interface Part {
  handle: FileSystemFileHandle
  /** Cached after first use; closed parts are immutable, so the snapshot
   *  never goes stale. */
  file: File | null
  /** Start offset of the part in the logical stream. */
  offset: number
  size: number
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

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

function concatAll(parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let pos = 0
  for (const p of parts) {
    out.set(p, pos)
    pos += p.length
  }
  return out
}

export class OpfsSpool implements ByteSpool {
  readonly kind = 'opfs' as const
  readonly artifactName: string
  private readonly root: FileSystemDirectoryHandle
  private readonly parts: Part[] = []
  private partSeq = 0
  /** In-flight bytes (< 1 part); served from RAM until flushed. */
  private pending: Uint8Array = new Uint8Array(0)
  private size = 0n
  private sealed = false
  private disposed = false

  private constructor(artifactName: string, root: FileSystemDirectoryHandle) {
    this.artifactName = artifactName
    this.root = root
  }

  /** Creates a fresh spool session and returns a ready spool. */
  static async create(artifactName: string, options: OpfsSpoolOptions = {}): Promise<OpfsSpool> {
    const root = options.rootDirectory ?? (await defaultRoot())
    return new OpfsSpool(artifactName, root)
  }

  async append(chunk: Uint8Array): Promise<void> {
    this.assertActive()
    if (this.sealed) throw new SpoolSealedError(this.artifactName)
    if (chunk.length === 0) return
    // The buffer starts where the pending region starts in the logical
    // stream — NOT at this.size: the pending bytes were already written
    // at earlier offsets. Recording a part at this.size would shift it by
    // pending.length and make readRange serve its head bytes twice (the
    // worker would re-feed those rows to the scanner — TSK0047 e2e caught
    // 20,097 rows for a 20,000-row file).
    const bufferStart = this.size - BigInt(this.pending.length)
    let buffer = this.pending.length === 0 ? chunk : concat(this.pending, chunk)
    let flushed = 0n // bytes flushed by THIS append (part offsets)
    while (buffer.length >= OPFS_PART_SIZE_BYTES) {
      const part = buffer.subarray(0, OPFS_PART_SIZE_BYTES)
      await this.flushPart(part, bufferStart + flushed)
      flushed += BigInt(part.length)
      // Copy the remainder: releases the flushed bytes from memory.
      buffer = buffer.slice(OPFS_PART_SIZE_BYTES)
    }
    // Keep a private copy: the caller's fetch chunk may be reused/freed.
    this.pending = this.pending.length === 0 && buffer === chunk ? chunk.slice() : buffer
    // Commit the size only after every flush succeeded (a quota failure
    // leaves the spool exactly as it was).
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

    const out: Uint8Array[] = []
    let pos = start
    for (const part of this.parts) {
      if (pos >= end) break
      if (part.offset + part.size <= pos) continue
      const from = pos > BigInt(part.offset) ? pos : BigInt(part.offset)
      const to = end < BigInt(part.offset + part.size) ? end : BigInt(part.offset + part.size)
      const file = (part.file ??= await part.handle.getFile())
      // Number conversion only at the Blob.slice boundary (part-local
      // offsets are < 1 MiB, always safe).
      const blob = file.slice(Number(from - BigInt(part.offset)), Number(to - BigInt(part.offset)))
      out.push(new Uint8Array(await blob.arrayBuffer()))
      pos = to
    }
    if (pos < end) {
      // The tail always lives in the RAM pending buffer.
      const pendingStart = this.size - BigInt(this.pending.length)
      const from = pos > pendingStart ? pos : pendingStart
      out.push(this.pending.subarray(Number(from - pendingStart), Number(end - pendingStart)))
    }
    return concatAll(out)
  }

  async seal(): Promise<void> {
    this.assertActive()
    // Parts are already closed; the pending buffer stays readable in RAM.
    this.sealed = true
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.pending = new Uint8Array(0)
    for (const part of this.parts.splice(0)) {
      try {
        await this.root.removeEntry(part.handle.name)
      } catch {
        // Already gone (crash cleanup, prior dispose): nothing to do.
      }
    }
  }

  /** Writes one full part file (exactly one writable cycle per part). */
  private async flushPart(data: Uint8Array, offset: bigint): Promise<void> {
    const name = `${this.artifactName}-p${this.partSeq++}`
    const handle = await this.root.getFileHandle(name, { create: true })
    let writer: WritableStreamDefaultWriter<Uint8Array> | null = null
    try {
      const stream = await handle.createWritable()
      writer = stream.getWriter()
      await writer.write(data)
      await writer.close()
    } catch (error) {
      await writer?.abort().catch(() => {})
      await this.root.removeEntry(name).catch(() => {})
      mapQuotaError(error, name)
      throw error
    }
    // Safe-number: part offsets beyond 2^53 bytes are not addressable
    // through Blob.slice anyway (readRange checks at the boundary).
    this.parts.push({ handle, file: null, offset: Number(offset), size: data.length })
  }

  private assertActive(): void {
    if (this.disposed) throw new SpoolDisposedError(this.artifactName)
  }
}
