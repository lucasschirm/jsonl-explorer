/**
 * Worker-owned byte source contract for the JSONL engine.
 *
 * A `JsonlSource` exposes the raw bytes of a JSONL document to the engine.
 * Sizes and offsets are bigint-compatible so sources can represent documents
 * larger than 2^53 bytes without precision loss at the boundary with the
 * offset index (see `engine/indexer.ts`).
 *
 * Read semantics (shared by all implementations):
 * - `offset` must be a non-negative integer (number or bigint).
 * - `length` must be a non-negative safe integer.
 * - An `offset` at or beyond end-of-file yields an empty `Uint8Array`.
 * - A range extending past end-of-file is clamped to the available bytes.
 *
 * Disposal is idempotent. Once disposed, every read or size query rejects
 * with a `SourceDisposedError`.
 */

/** Typed error: an operation was attempted on a disposed source. */
export class SourceDisposedError extends Error {
  readonly code = 'SOURCE_DISPOSED' as const

  constructor(sourceName: string) {
    super(`Source "${sourceName}" has been disposed`)
    this.name = 'SourceDisposedError'
  }
}

/** Typed error: a handover payload exceeds the configured size cap. */
export class PayloadTooLargeError extends Error {
  readonly code = 'HANDOVER_PAYLOAD_TOO_LARGE' as const

  constructor(sizeBytes: number, maxBytes: number) {
    super(`Payload of ${sizeBytes} bytes exceeds the maximum of ${maxBytes} bytes`)
    this.name = 'PayloadTooLargeError'
  }
}

/** Worker-owned byte source for a JSONL document. */
export interface JsonlSource {
  /** Display name of the source (file name, URL, or handover name). */
  readonly name: string

  /** Total size of the document in bytes (bigint-compatible). */
  getSize(): Promise<bigint>

  /**
   * Reads up to `length` bytes starting at `offset`.
   * See module docs for clamping and validation semantics.
   */
  readRange(offset: bigint | number, length: number): Promise<Uint8Array>

  /** Releases source resources. Safe to call multiple times. */
  dispose(): Promise<void>
}

/** Validates and converts a read offset (number or bigint) to a non-negative bigint. */
export function normalizeOffset(offset: bigint | number): bigint {
  if (typeof offset === 'bigint') {
    if (offset < 0n) throw new RangeError(`Invalid read offset: ${offset}`)
    return offset
  }
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new RangeError(`Invalid read offset: ${offset}`)
  }
  return BigInt(offset)
}

/** Validates a read length as a non-negative safe integer. */
export function normalizeLength(length: number): number {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RangeError(`Invalid read length: ${length}`)
  }
  return length
}

/**
 * Base class implementing idempotent disposal and disposed-state guards so
 * concrete sources only implement byte access and resource release.
 */
export abstract class AbstractJsonlSource implements JsonlSource {
  protected disposed = false

  abstract readonly name: string

  abstract getSize(): Promise<bigint>

  abstract readRange(offset: bigint | number, length: number): Promise<Uint8Array>

  /** Releases resources. Safe to call multiple times. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.release()
  }

  /** Throws a typed error when the source has been disposed. */
  protected assertActive(): void {
    if (this.disposed) throw new SourceDisposedError(this.name)
  }

  /** Override to release underlying resources (buffer, handle, ...). */
  protected release(): void {
    // No resources by default.
  }
}
