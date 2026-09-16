/**
 * Blocked 64-bit offset index and 32-bit match index for the JSONL engine.
 *
 * These are non-reactive, geometrically growing typed-array structures that
 * scale past 4 GiB file offsets and very large row counts without allocating a
 * new contiguous buffer on every append (amortized O(1)).
 *
 * Offsets are stored in a `BigUint64Array` when the runtime provides it, with a
 * hi/lo `Uint32Array` fallback for environments that do not. Conversion to
 * JavaScript `number` is guarded at the read boundary so oversized offsets fail
 * with a typed error instead of silently losing precision.
 */

export const DEFAULT_INITIAL_CAPACITY = 1024
export const GROWTH_FACTOR = 2

export const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER

const MAX_SAFE_INTEGER_BIGINT = BigInt(MAX_SAFE_INTEGER)
const MAX_UINT64 = 0xffffffffffffffffn
const UINT32_MASK = 0xffffffff
const UINT64_SHIFT = 32n
const UINT32_STRIDE = 0x100000000

export const HAS_BIGUINT64ARRAY: boolean = typeof BigUint64Array !== 'undefined'

/** 64-bit unsigned integer represented as a high/low 32-bit word pair. */
export interface Uint64 {
  hi: number
  lo: number
}

export interface OffsetIndexMetrics {
  capacity: number
  length: number
  memoryBytes: number
}

export interface MatchIndexMetrics {
  capacity: number
  matchedCount: number
  memoryBytes: number
}

/**
 * Typed error thrown when a 64-bit offset cannot be represented exactly as a
 * JavaScript `number` (i.e. it exceeds `Number.MAX_SAFE_INTEGER`).
 */
export class UnsafeConversionError extends RangeError {
  readonly code = 'ERR_UNSAFE_CONVERSION' as const

  constructor(message: string) {
    super(message)
    this.name = 'UnsafeConversionError'
  }
}

/**
 * Creates a `Uint64` hi/lo pair from a non-negative integer (number or bigint).
 * @throws {RangeError} for negatives, non-integers, or unsafe numbers.
 */
export function createUint64(value: number | bigint): Uint64 {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(`Offset ${value} is not a safe integer`)
    }
    if (value < 0) throw new RangeError(`Offset ${value} is negative`)
    return { hi: Math.floor(value / UINT32_STRIDE), lo: value >>> 0 }
  }
  if (value < 0n) throw new RangeError(`Offset ${value} is negative`)
  if (value > MAX_UINT64) throw new RangeError(`Offset ${value} exceeds 64-bit range`)
  return { hi: Number(value >> UINT64_SHIFT), lo: Number(value & 0xffffffffn) }
}

/**
 * Converts a `Uint64` hi/lo pair to a `number`.
 * @throws {UnsafeConversionError} when the value exceeds `Number.MAX_SAFE_INTEGER`.
 */
export function uint64ToNumber(value: Uint64): number {
  const big = uint64ToBigInt(value)
  if (big > MAX_SAFE_INTEGER_BIGINT) {
    throw new UnsafeConversionError(`Offset ${big} exceeds MAX_SAFE_INTEGER`)
  }
  return Number(big)
}

/** Converts a `Uint64` hi/lo pair to a `bigint`. */
export function uint64ToBigInt(value: Uint64): bigint {
  return (BigInt(value.hi) << UINT64_SHIFT) | BigInt(value.lo >>> 0)
}

/** Adds two `Uint64` values, propagating the carry into the high word. */
export function addUint64(a: Uint64, b: Uint64): Uint64 {
  const lo = a.lo + b.lo
  const carry = lo > UINT32_MASK ? 1 : 0
  return { hi: (a.hi + b.hi + carry) >>> 0, lo: lo >>> 0 }
}

/**
 * Compares two `Uint64` values.
 * @returns -1 if `a < b`, 0 if equal, 1 if `a > b`.
 */
export function compareUint64(a: Uint64, b: Uint64): -1 | 0 | 1 {
  if (a.hi !== b.hi) return a.hi < b.hi ? -1 : 1
  if (a.lo !== b.lo) return a.lo < b.lo ? -1 : 1
  return 0
}

/** Returns true when the `Uint64` value is zero. */
export function isUint64Zero(value: Uint64): boolean {
  return value.hi === 0 && value.lo === 0
}

/**
 * Converts a non-negative `bigint` offset to a `number`.
 * @throws {UnsafeConversionError} when the value exceeds `Number.MAX_SAFE_INTEGER`.
 */
export function offsetToNumber(offset: bigint): number {
  if (offset < 0n) throw new RangeError(`Offset ${offset} is negative`)
  if (offset > MAX_SAFE_INTEGER_BIGINT) {
    throw new UnsafeConversionError(`Offset ${offset} exceeds MAX_SAFE_INTEGER`)
  }
  return Number(offset)
}

/**
 * Converts a safe non-negative `number` offset to a `bigint`.
 * @throws {RangeError} for negatives or unsafe integers.
 */
export function offsetToBigInt(offset: number): bigint {
  if (!Number.isSafeInteger(offset)) {
    throw new RangeError(`Offset ${offset} is not a safe integer`)
  }
  if (offset < 0) throw new RangeError(`Offset ${offset} is negative`)
  return BigInt(offset)
}

/**
 * Validates that an offset (number or bigint) is a safe non-negative integer.
 * @throws {RangeError} when the offset is negative or unsafe.
 */
export function validateSafeOffset(offset: number | bigint): void {
  if (typeof offset === 'number') {
    if (!Number.isSafeInteger(offset)) {
      throw new RangeError(`Offset ${offset} is not a safe integer`)
    }
    return
  }
  if (offset < 0n || offset > MAX_SAFE_INTEGER_BIGINT) {
    throw new RangeError(`Offset ${offset} is out of safe range`)
  }
}

/**
 * Coerces an accepted offset (number or bigint) into a `bigint` for storage,
 * enforcing non-negativity and the 64-bit upper bound.
 */
function toStoredBigInt(offset: number | bigint): bigint {
  if (typeof offset === 'number') {
    if (!Number.isSafeInteger(offset)) {
      throw new RangeError(`Offset ${offset} is not a safe integer`)
    }
    if (offset < 0) throw new RangeError(`Offset ${offset} is negative`)
    return BigInt(offset)
  }
  if (offset < 0n) throw new RangeError(`Offset ${offset} is negative`)
  if (offset > MAX_UINT64) {
    throw new RangeError(`Offset ${offset} exceeds 64-bit range`)
  }
  return offset
}

/**
 * Geometrically growing index of N+1 line-start offsets, stored as 64-bit
 * unsigned values so it can address files larger than 4 GiB.
 */
export class OffsetIndex {
  private big: BigUint64Array | null
  private hi: Uint32Array | null
  private lo: Uint32Array | null
  private length = 0
  private capacity: number

  constructor(initialCapacity = DEFAULT_INITIAL_CAPACITY) {
    this.capacity = Math.max(1, initialCapacity)
    if (HAS_BIGUINT64ARRAY) {
      this.big = new BigUint64Array(this.capacity)
      this.hi = null
      this.lo = null
    } else {
      this.big = null
      this.hi = new Uint32Array(this.capacity)
      this.lo = new Uint32Array(this.capacity)
    }
  }

  getLength(): number {
    return this.length
  }

  getCapacity(): number {
    return this.capacity
  }

  getMetrics(): OffsetIndexMetrics {
    return {
      capacity: this.capacity,
      length: this.length,
      memoryBytes: this.capacity * 8,
    }
  }

  /** Grows the backing buffer (geometrically) so it can hold at least `min`. */
  ensureCapacity(min: number): void {
    if (min <= this.capacity) return
    let next = this.capacity
    while (next < min) next *= GROWTH_FACTOR
    this.allocate(next)
  }

  /** Appends a line-start offset, growing the buffer when required. */
  appendOffset(offset: number | bigint): void {
    const value = toStoredBigInt(offset)
    this.ensureCapacity(this.length + 1)
    this.write(this.length, value)
    this.length += 1
  }

  /** Overwrites the offset currently stored at `index`. */
  setOffset(index: number, offset: number | bigint): void {
    this.assertBounds(index)
    this.write(index, toStoredBigInt(offset))
  }

  /** Returns the offset at `index` as a `number`. */
  getOffsetAsNumber(index: number): number {
    this.assertBounds(index)
    return offsetToNumber(this.read(index))
  }

  /** Returns the offset at `index` as a `bigint`. */
  getOffsetAsBigInt(index: number): bigint {
    this.assertBounds(index)
    return this.read(index)
  }

  /** Returns the offset at `index` as a `Uint64` hi/lo pair. */
  getOffsetAsUint64(index: number): Uint64 {
    this.assertBounds(index)
    const value = this.read(index)
    return { hi: Number(value >> UINT64_SHIFT), lo: Number(value & 0xffffffffn) }
  }

  /** Removes all stored offsets. */
  clear(): void {
    this.length = 0
  }

  /** Creates an independent copy of this index. */
  clone(): OffsetIndex {
    const cloned = new OffsetIndex(this.capacity)
    for (let i = 0; i < this.length; i += 1) {
      cloned.write(i, this.read(i))
    }
    cloned.length = this.length
    return cloned
  }

  private assertBounds(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.length) {
      throw new RangeError(`Offset index ${index} out of bounds [0, ${this.length})`)
    }
  }

  private allocate(capacity: number): void {
    if (this.big !== null) {
      const next = new BigUint64Array(capacity)
      next.set(this.big.subarray(0, this.length))
      this.big = next
    } else {
      const hi = new Uint32Array(capacity)
      const lo = new Uint32Array(capacity)
      if (this.hi !== null) hi.set(this.hi.subarray(0, this.length))
      if (this.lo !== null) lo.set(this.lo.subarray(0, this.length))
      this.hi = hi
      this.lo = lo
    }
    this.capacity = capacity
  }

  private read(index: number): bigint {
    if (this.big !== null) return this.big[index]!
    const hi = this.hi
    const lo = this.lo
    if (hi === null || lo === null) {
      throw new RangeError('Internal error: offset storage not initialized')
    }
    return (BigInt(hi[index]!) << UINT64_SHIFT) | BigInt(lo[index]! >>> 0)
  }

  private write(index: number, value: bigint): void {
    if (this.big !== null) {
      this.big[index] = value
      return
    }
    const hi = this.hi
    const lo = this.lo
    if (hi === null || lo === null) {
      throw new RangeError('Internal error: offset storage not initialized')
    }
    hi[index] = Number(value >> UINT64_SHIFT)
    lo[index] = Number(value & 0xffffffffn)
  }
}

/**
 * Geometrically growing index of matched row numbers (stable 32-bit match IDs).
 */
export class MatchIndex {
  private rows: Uint32Array
  private matchedCount = 0
  private capacity: number

  constructor(initialCapacity = DEFAULT_INITIAL_CAPACITY) {
    this.capacity = Math.max(1, initialCapacity)
    this.rows = new Uint32Array(this.capacity)
  }

  getMatchedCount(): number {
    return this.matchedCount
  }

  getCapacity(): number {
    return this.capacity
  }

  getMetrics(): MatchIndexMetrics {
    return {
      capacity: this.capacity,
      matchedCount: this.matchedCount,
      memoryBytes: this.capacity * 4,
    }
  }

  /** Grows the backing buffer (geometrically) so it can hold at least `min`. */
  ensureCapacity(min: number): void {
    if (min <= this.capacity) return
    let next = this.capacity
    while (next < min) next *= GROWTH_FACTOR
    const grown = new Uint32Array(next)
    grown.set(this.rows.subarray(0, this.matchedCount))
    this.rows = grown
    this.capacity = next
  }

  /** Appends a matched row number, growing the buffer when required. */
  addMatch(row: number): void {
    if (!Number.isInteger(row) || row < 0 || row > UINT32_MASK) {
      throw new RangeError(`Row index ${row} out of bounds [0, ${UINT32_MASK}]`)
    }
    this.ensureCapacity(this.matchedCount + 1)
    this.rows[this.matchedCount] = row
    this.matchedCount += 1
  }

  /** Returns the matched row number at position `index`. */
  getMatch(index: number): number {
    if (!Number.isInteger(index) || index < 0 || index >= this.matchedCount) {
      throw new RangeError(
        `Match index ${index} out of bounds [0, ${this.matchedCount})`,
      )
    }
    return this.rows[index]!
  }

  /** Returns a view over all matched row numbers. */
  getMatchedRows(): Uint32Array {
    return this.rows.subarray(0, this.matchedCount)
  }

  /** Removes all stored matches. */
  clear(): void {
    this.matchedCount = 0
  }

  /** Creates an independent copy of this index. */
  clone(): MatchIndex {
    const cloned = new MatchIndex(this.capacity)
    cloned.rows.set(this.rows.subarray(0, this.matchedCount))
    cloned.matchedCount = this.matchedCount
    return cloned
  }
}
