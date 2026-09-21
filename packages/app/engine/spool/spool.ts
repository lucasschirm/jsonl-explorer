/**
 * Byte spool contract for worker-owned streaming storage.
 *
 * A `ByteSpool` accumulates bytes incrementally (`append`) and serves
 * random-access reads (`readRange`) once data has landed. Two
 * implementations exist (ADR-008):
 * - `OpfsSpool` — streams to an OPFS artifact, reads back via `File.slice`
 * - `PagedMemoryStore` — fixed-size in-memory pages (no concatenation)
 *
 * Spools are single-session: create, append, `seal` (read-only), then
 * `dispose` (artifacts removed). Disposal is idempotent; operations after
 * disposal reject with `SpoolDisposedError`.
 */

import type { JsonlSource } from '../sources/index.js'

export type SpoolKind = 'opfs' | 'memory'

/** Worker-owned, incrementally appended byte store with random-access reads. */
export interface ByteSpool {
  /** Storage backend kind. */
  readonly kind: SpoolKind

  /**
   * Name of the backing artifact (OPFS file name or memory identifier).
   * Used for display and cleanup bookkeeping.
   */
  readonly artifactName: string

  /**
   * Appends `chunk` at the current end.
   * @throws {SpoolSealedError} when the spool is already sealed.
   * @throws {SpoolQuotaExceededError} when storage quota is exhausted (OPFS).
   * @throws {SpoolDisposedError} when the spool is disposed.
   */
  append(chunk: Uint8Array): Promise<void>

  /** Total bytes appended so far. */
  getSize(): Promise<bigint>

  /**
   * Reads up to `length` bytes starting at `offset`, clamped to the current
   * size. Offsets are bigint-compatible; number conversion happens only
   * after a safe-integer check at the storage boundary.
   */
  readRange(offset: bigint | number, length: number): Promise<Uint8Array>

  /** Marks the spool read-only (all appended bytes are durable/complete). */
  seal(): Promise<void>

  /** Removes artifacts and releases memory. Safe to call multiple times. */
  dispose(): Promise<void>
}

/** Typed error: an operation was attempted on a disposed spool. */
export class SpoolDisposedError extends Error {
  readonly code = 'SPOOL_DISPOSED' as const

  constructor(artifactName: string) {
    super(`Spool "${artifactName}" has been disposed`)
    this.name = 'SpoolDisposedError'
  }
}

/** Typed error: storage quota was exhausted while appending. */
export class SpoolQuotaExceededError extends Error {
  readonly code = 'SPOOL_QUOTA_EXCEEDED' as const

  constructor(artifactName: string) {
    super(`Storage quota exceeded while writing to "${artifactName}"`)
    this.name = 'SpoolQuotaExceededError'
  }
}

/** Typed error: an append was attempted after `seal()`. */
export class SpoolSealedError extends Error {
  readonly code = 'SPOOL_SEALED' as const

  constructor(artifactName: string) {
    super(`Spool "${artifactName}" is sealed and read-only`)
    this.name = 'SpoolSealedError'
  }
}

/**
 * Adapts a sealed (or still-growing) `ByteSpool` to the engine's
 * `JsonlSource` contract so scanners/filters can consume spooled bytes.
 */
export class SpoolSource implements JsonlSource {
  readonly name: string
  private spool: ByteSpool
  private disposed = false

  constructor(name: string, spool: ByteSpool) {
    this.name = name
    this.spool = spool
  }

  async getSize(): Promise<bigint> {
    this.assertActive()
    return this.spool.getSize()
  }

  async readRange(offset: bigint | number, length: number): Promise<Uint8Array> {
    this.assertActive()
    return this.spool.readRange(offset, length)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.spool.dispose()
  }

  private assertActive(): void {
    if (this.disposed) throw new SpoolDisposedError(this.name)
  }
}
