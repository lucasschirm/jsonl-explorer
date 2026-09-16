/**
 * FileSource — worker-owned byte source over a structured-cloned File/Blob.
 *
 * The main thread hands the File to the worker via structured clone, so the
 * worker owns an independent copy and no main-thread resources are released on
 * disposal. Reads are served from `blob.slice()` which performs no full-file
 * copy.
 */

import { AbstractJsonlSource, normalizeLength, normalizeOffset } from './source.js'

export class FileSource extends AbstractJsonlSource {
  readonly name: string
  private readonly blob: Blob

  constructor(blob: Blob, name?: string) {
    super()
    this.blob = blob
    this.name = name ?? (blob instanceof File ? blob.name : 'blob')
  }

  async getSize(): Promise<bigint> {
    this.assertActive()
    return BigInt(this.blob.size)
  }

  async readRange(offset: bigint | number, length: number): Promise<Uint8Array> {
    this.assertActive()
    const size = BigInt(this.blob.size)
    const start = normalizeOffset(offset)
    const end = clampEnd(start, BigInt(normalizeLength(length)), size)
    if (start >= size) return new Uint8Array(0)
    const bytes = await this.blob.slice(Number(start), Number(end)).arrayBuffer()
    return new Uint8Array(bytes)
  }

  protected override release(): void {
    // The blob is a structured clone owned by the worker; nothing to release.
  }
}

/** Clamps a requested end offset to end-of-file. */
function clampEnd(start: bigint, requestedLength: bigint, size: bigint): bigint {
  const end = start + requestedLength
  return end > size ? size : end
}
