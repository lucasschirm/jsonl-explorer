import { describe, it, expect, vi } from 'vitest'
import {
  createUint64,
  uint64ToNumber,
  uint64ToBigInt,
  addUint64,
  compareUint64,
  isUint64Zero,
  OffsetIndex,
  MatchIndex,
  offsetToNumber,
  offsetToBigInt,
  validateSafeOffset,
  MAX_SAFE_INTEGER,
  HAS_BIGUINT64ARRAY,
} from '~/engine/indexer.js'

describe('Uint64 Helpers', () => {
  describe('createUint64', () => {
    it('creates Uint64 from number', () => {
      const u64 = createUint64(42)
      expect(u64).toEqual({ hi: 0, lo: 42 })
    })

    it('creates Uint64 from bigint', () => {
      const u64 = createUint64(0x1234567809abcdefn)
      expect(u64).toEqual({ hi: 0x12345678, lo: 0x9abcdef })
    })

    it('throws for negative numbers', () => {
      expect(() => createUint64(-1)).toThrow()
    })

    it('throws for unsafe integers', () => {
      expect(() => createUint64(Number.MAX_SAFE_INTEGER + 1)).toThrow()
    })

    it('throws for non-integers', () => {
      expect(() => createUint64(3.14)).toThrow()
    })
  })

  describe('uint64ToNumber', () => {
    it('converts Uint64 to number', () => {
      expect(uint64ToNumber({ hi: 0, lo: 42 })).toBe(42)
    })

    it('converts large Uint64 to number', () => {
      const u64 = { hi: 1, lo: 0 }
      expect(uint64ToNumber(u64)).toBe(0x100000000)
    })

    it('throws for unsafe integers', () => {
      expect(() => uint64ToNumber({ hi: 0x200000, lo: 0 })).toThrow()
    })
  })

  describe('uint64ToBigInt', () => {
    it('converts Uint64 to bigint', () => {
      expect(uint64ToBigInt({ hi: 1, lo: 42 })).toBe(0x10000002an)
    })
  })

  describe('addUint64', () => {
    it('adds two Uint64', () => {
      const a = { hi: 0, lo: 100 }
      const b = { hi: 0, lo: 200 }
      expect(addUint64(a, b)).toEqual({ hi: 0, lo: 300 })
    })

    it('handles carry', () => {
      const a = { hi: 0, lo: 0xffffffff }
      const b = { hi: 0, lo: 1 }
      expect(addUint64(a, b)).toEqual({ hi: 1, lo: 0 })
    })
  })

  describe('compareUint64', () => {
    it('compares equal', () => {
      expect(compareUint64({ hi: 1, lo: 100 }, { hi: 1, lo: 100 })).toBe(0)
    })

    it('compares less', () => {
      expect(compareUint64({ hi: 0, lo: 100 }, { hi: 1, lo: 0 })).toBe(-1)
    })

    it('compares greater', () => {
      expect(compareUint64({ hi: 2, lo: 0 }, { hi: 1, lo: 0xffffffff })).toBe(1)
    })
  })

  describe('isUint64Zero', () => {
    it('returns true for zero', () => {
      expect(isUint64Zero({ hi: 0, lo: 0 })).toBe(true)
    })

    it('returns false for non-zero', () => {
      expect(isUint64Zero({ hi: 0, lo: 1 })).toBe(false)
    })
  })
})

describe('OffsetIndex', () => {
  describe('Basic Operations', () => {
    it('creates empty index', () => {
      const index = new OffsetIndex()
      expect(index.getLength()).toBe(0)
      expect(index.getCapacity()).toBe(1024)
    })

    it('appends offsets', () => {
      const index = new OffsetIndex(10)
      index.appendOffset(0)
      index.appendOffset(100)
      index.appendOffset(200)
      expect(index.getLength()).toBe(3)
    })

    it('grows capacity automatically', () => {
      const index = new OffsetIndex(4)
      for (let i = 0; i < 10; i++) {
        index.appendOffset(i * 100)
      }
      expect(index.getLength()).toBe(10)
      expect(index.getCapacity()).toBeGreaterThanOrEqual(10)
    })

    it('gets offsets as numbers', () => {
      const index = new OffsetIndex()
      index.appendOffset(0)
      index.appendOffset(100)
      index.appendOffset(200)
      expect(index.getOffsetAsNumber(0)).toBe(0)
      expect(index.getOffsetAsNumber(1)).toBe(100)
      expect(index.getOffsetAsNumber(2)).toBe(200)
    })

    it('gets offsets as bigint', () => {
      const index = new OffsetIndex()
      index.appendOffset(100n)
      index.appendOffset(200n)
      expect(index.getOffsetAsBigInt(0)).toBe(100n)
      expect(index.getOffsetAsBigInt(1)).toBe(200n)
    })

    it('gets offsets as Uint64', () => {
      const index = new OffsetIndex()
      index.appendOffset(0x100000000)
      const u64 = index.getOffsetAsUint64(0)
      expect(u64).toEqual({ hi: 1, lo: 0 })
    })
  })

  describe('Bounds Checking', () => {
    it('throws for negative index', () => {
      const index = new OffsetIndex()
      index.appendOffset(0)
      expect(() => index.getOffsetAsNumber(-1)).toThrow()
    })

    it('throws for out of bounds index', () => {
      const index = new OffsetIndex()
      index.appendOffset(0)
      expect(() => index.getOffsetAsNumber(1)).toThrow()
    })

    it('throws for negative offset', () => {
      const index = new OffsetIndex()
      expect(() => index.appendOffset(-1)).toThrow()
    })

    it('throws for unsafe integer offset', () => {
      const index = new OffsetIndex()
      expect(() => index.appendOffset(Number.MAX_SAFE_INTEGER + 1)).toThrow()
    })
  })

  describe('Large Offsets', () => {
    it('handles offsets > 4GB with bigint', () => {
      const index = new OffsetIndex()
      const largeOffset = 5000000000n // > 4GB
      index.appendOffset(largeOffset)
      expect(index.getOffsetAsBigInt(0)).toBe(largeOffset)
    })

    it('throws when converting large offset to number', () => {
      const index = new OffsetIndex()
      // Use value > MAX_SAFE_INTEGER (9007199254740991)
      index.appendOffset(10000000000000000n)
      expect(() => index.getOffsetAsNumber(0)).toThrow()
    })

    it('handles offsets at 4GB boundary', () => {
      const index = new OffsetIndex()
      const fourGB = 0x100000000n
      index.appendOffset(fourGB)
      expect(index.getOffsetAsBigInt(0)).toBe(fourGB)
    })
  })

  describe('Metrics', () => {
    it('reports correct metrics', () => {
      const index = new OffsetIndex(100)
      index.appendOffset(0)
      index.appendOffset(100)
      const metrics = index.getMetrics()
      expect(metrics.capacity).toBe(100)
      expect(metrics.length).toBe(2)
      expect(metrics.memoryBytes).toBe(800)
    })
  })

  describe('Clone', () => {
    it('creates independent clone', () => {
      const index = new OffsetIndex()
      index.appendOffset(100)
      index.appendOffset(200)
      const cloned = index.clone()
      expect(cloned.getLength()).toBe(2)
      expect(cloned.getOffsetAsNumber(0)).toBe(100)
      expect(cloned.getOffsetAsNumber(1)).toBe(200)
    })

    it('clone is independent', () => {
      const index = new OffsetIndex()
      index.appendOffset(100)
      const cloned = index.clone()
      index.appendOffset(300)
      expect(cloned.getLength()).toBe(1)
      expect(index.getLength()).toBe(2)
    })
  })
})

describe('MatchIndex', () => {
  describe('Basic Operations', () => {
    it('creates empty match index', () => {
      const matchIndex = new MatchIndex()
      expect(matchIndex.getMatchedCount()).toBe(0)
    })

    it('adds matches', () => {
      const matchIndex = new MatchIndex()
      matchIndex.addMatch(0)
      matchIndex.addMatch(5)
      matchIndex.addMatch(10)
      expect(matchIndex.getMatchedCount()).toBe(3)
    })

    it('gets matches', () => {
      const matchIndex = new MatchIndex()
      matchIndex.addMatch(0)
      matchIndex.addMatch(5)
      matchIndex.addMatch(10)
      expect(matchIndex.getMatch(0)).toBe(0)
      expect(matchIndex.getMatch(1)).toBe(5)
      expect(matchIndex.getMatch(2)).toBe(10)
    })

    it('grows capacity automatically', () => {
      const matchIndex = new MatchIndex(4)
      for (let i = 0; i < 10; i++) {
        matchIndex.addMatch(i)
      }
      expect(matchIndex.getMatchedCount()).toBe(10)
      expect(matchIndex.getCapacity()).toBeGreaterThanOrEqual(10)
    })

    it('gets all matches', () => {
      const matchIndex = new MatchIndex()
      matchIndex.addMatch(0)
      matchIndex.addMatch(5)
      matchIndex.addMatch(10)
      const rows = matchIndex.getMatchedRows()
      expect(rows).toEqual(new Uint32Array([0, 5, 10]))
    })

    it('clears matches', () => {
      const matchIndex = new MatchIndex()
      matchIndex.addMatch(0)
      matchIndex.addMatch(5)
      matchIndex.clear()
      expect(matchIndex.getMatchedCount()).toBe(0)
    })
  })

  describe('Bounds Checking', () => {
    it('throws for negative row index', () => {
      const matchIndex = new MatchIndex()
      expect(() => matchIndex.addMatch(-1)).toThrow()
    })

    it('throws for row index > Uint32 max', () => {
      const matchIndex = new MatchIndex()
      expect(() => matchIndex.addMatch(0xffffffff + 1)).toThrow()
    })

    it('throws for out of bounds getMatch', () => {
      const matchIndex = new MatchIndex()
      matchIndex.addMatch(0)
      expect(() => matchIndex.getMatch(1)).toThrow()
    })
  })

  describe('Clone', () => {
    it('creates independent clone', () => {
      const matchIndex = new MatchIndex()
      matchIndex.addMatch(0)
      matchIndex.addMatch(5)
      const cloned = matchIndex.clone()
      expect(cloned.getMatchedCount()).toBe(2)
      expect(cloned.getMatch(0)).toBe(0)
      expect(cloned.getMatch(1)).toBe(5)
    })

    it('clone is independent', () => {
      const matchIndex = new MatchIndex()
      matchIndex.addMatch(0)
      const cloned = matchIndex.clone()
      matchIndex.addMatch(10)
      expect(cloned.getMatchedCount()).toBe(1)
      expect(matchIndex.getMatchedCount()).toBe(2)
    })
  })

  describe('Metrics', () => {
    it('reports correct metrics', () => {
      const matchIndex = new MatchIndex(100)
      matchIndex.addMatch(0)
      matchIndex.addMatch(5)
      const metrics = matchIndex.getMetrics()
      expect(metrics.capacity).toBe(100)
      expect(metrics.matchedCount).toBe(2)
      expect(metrics.memoryBytes).toBe(400)
    })
  })
})

describe('Safe Integer Conversion', () => {
  describe('offsetToNumber', () => {
    it('converts small bigint to number', () => {
      expect(offsetToNumber(100n)).toBe(100)
    })

    it('converts MAX_SAFE_INTEGER', () => {
      expect(offsetToNumber(BigInt(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER)
    })

    it('throws for offset > MAX_SAFE_INTEGER', () => {
      expect(() => offsetToNumber(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow()
    })
  })

  describe('offsetToBigInt', () => {
    it('converts number to bigint', () => {
      expect(offsetToBigInt(100)).toBe(100n)
    })

    it('throws for negative', () => {
      expect(() => offsetToBigInt(-1)).toThrow()
    })

    it('throws for unsafe integer', () => {
      expect(() => offsetToBigInt(Number.MAX_SAFE_INTEGER + 1)).toThrow()
    })
  })

  describe('validateSafeOffset', () => {
    it('passes for safe numbers', () => {
      expect(() => validateSafeOffset(100)).not.toThrow()
    })

    it('passes for safe bigints', () => {
      expect(() => validateSafeOffset(100n)).not.toThrow()
    })

    it('throws for unsafe numbers', () => {
      expect(() => validateSafeOffset(Number.MAX_SAFE_INTEGER + 1)).toThrow()
    })

    it('throws for unsafe bigints', () => {
      expect(() => validateSafeOffset(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow()
    })
  })
})

describe('Constants', () => {
  it('MAX_SAFE_INTEGER is correct', () => {
    expect(MAX_SAFE_INTEGER).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('HAS_BIGUINT64ARRAY reflects environment', () => {
    expect(typeof HAS_BIGUINT64ARRAY).toBe('boolean')
  })
})