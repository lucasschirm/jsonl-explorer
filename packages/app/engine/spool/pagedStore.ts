/**
 * PagedMemoryStore — fixed-size in-memory byte spool.
 *
 * Fallback storage for streamed URL data when OPFS is unavailable or its
 * quota is exhausted (ADR-008). Bytes live in independent fixed-size pages
 * (default 256 KiB, `ENGINE_DEFAULTS.spoolPageSizeBytes`); appends and
 * reads copy page-by-page, so the full response is NEVER concatenated into
 * a single buffer. Memory is bounded by the data size plus at most one
 * partially filled page.
 */

import { normalizeLength, normalizeOffset } from '../sources/source.js'
import { ENGINE_DEFAULTS } from '../config/adr.js'

import { SpoolDisposedError, SpoolSealedError } from './spool.js'
import type { ByteSpool } from './spool.js'

/** Copies bytes from `source` at `offset` into a fresh full-size page. */
function copyPage(source: Uint8Array, offset: number, pageSize: number): Uint8Array {
  const page = new Uint8Array(pageSize)
  page.set(source.subarray(offset, offset + pageSize))
  return page
}

export interface PagedMemoryStoreOptions {
  /** Fixed page size in bytes. Defaults to `spoolPageSizeBytes` (256 KiB). */
  pageSizeBytes?: number
  /** Identifier recorded as the artifact name (not a disk file). */
  artifactName?: string
}

export class PagedMemoryStore implements ByteSpool {
  readonly kind = 'memory' as const
  readonly artifactName: string
  /** Fixed page size in bytes (ADR-008 `spoolPageSizeBytes` by default). */
  get pageSizeBytes(): number {
    return this.pageSize
  }
  private readonly pageSize: number
  private pages: Uint8Array[] = []
  private fill = 0 // bytes used in the last page (full size when pages is empty)
  private size = 0n
  private sealed = false
  private disposed = false

  constructor(options: PagedMemoryStoreOptions = {}) {
    this.pageSize = options.pageSizeBytes ?? ENGINE_DEFAULTS.spoolPageSizeBytes
    if (!Number.isSafeInteger(this.pageSize) || this.pageSize < 1) {
      throw new RangeError(`Invalid page size: ${this.pageSize}`)
    }
    this.artifactName = options.artifactName ?? 'memory'
  }

  async append(chunk: Uint8Array): Promise<void> {
    this.assertActive()
    if (this.sealed) throw new SpoolSealedError(this.artifactName)
    if (chunk.length === 0) return
    const filled = this.fillLastPage(chunk)
    const rest = chunk.subarray(filled)
    const fullPages = Math.floor(rest.length / this.pageSize)
    for (let i = 0; i < fullPages; i++) {
      this.pages.push(copyPage(rest, i * this.pageSize, this.pageSize))
      this.fill = this.pageSize
    }
    const tail = rest.length - fullPages * this.pageSize
    if (tail > 0) {
      // The partial page is allocated at full size so that later appends can
      // fill the remainder in place without growing (or concatenating).
      this.pages.push(copyPage(rest, fullPages * this.pageSize, this.pageSize))
      this.fill = tail
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
    const result = new Uint8Array(Number(end - start))
    let cursor = start
    let written = 0
    while (cursor < end) {
      const pageIndex = Number(cursor / BigInt(this.pageSize))
      const pageStart = BigInt(pageIndex) * BigInt(this.pageSize)
      const pageOffset = Number(cursor - pageStart)
      const page = this.pages[pageIndex]
      if (!page) break
      // The last page may hold fewer than pageSize bytes (partial tail).
      const take = Math.min(page.byteLength - pageOffset, Number(end - cursor))
      result.set(page.subarray(pageOffset, pageOffset + take), written)
      written += take
      cursor += BigInt(take)
    }
    return result
  }

  /** Total bytes currently held across all pages. */
  getMemoryBytes(): number {
    let total = 0
    for (const page of this.pages) total += page.byteLength
    return total
  }

  async seal(): Promise<void> {
    this.assertActive()
    this.sealed = true
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.pages = []
    this.fill = 0
    this.size = 0n
  }

  private fillLastPage(chunk: Uint8Array): number {
    // Copies leading bytes into the partially filled last page (always
    // allocated at full size); returns the number of bytes consumed by that
    // copy (0 when no partial page is pending).
    if (this.pages.length === 0 || this.fill >= this.pageSize) return 0
    const last = this.pages[this.pages.length - 1]
    if (!last) return 0
    const take = Math.min(this.pageSize - this.fill, chunk.length)
    if (take === 0) return 0
    last.set(chunk.subarray(0, take), this.fill)
    this.fill += take
    return take
  }

  private assertActive(): void {
    if (this.disposed) throw new SpoolDisposedError(this.artifactName)
  }
}
