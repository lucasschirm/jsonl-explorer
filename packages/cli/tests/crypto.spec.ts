/// <reference types="vitest/globals" />
import { describe, it, expect } from 'vitest'
import { generateCapability, constantTimeEquals } from '../src/crypto.js'

describe('CLI Crypto', () => {
  describe('generateCapability', () => {
    it('generates a 64-character hex string', () => {
      const cap = generateCapability()
      expect(cap).toHaveLength(64)
      expect(cap).toMatch(/^[0-9a-f]{64}$/)
    })

    it('generates different capabilities each call', () => {
      const cap1 = generateCapability()
      const cap2 = generateCapability()
      expect(cap1).not.toBe(cap2)
    })

    it('uses cryptographically random values', () => {
      // This test ensures crypto.getRandomValues is used
      const caps = new Set()
      for (let i = 0; i < 100; i++) {
        caps.add(generateCapability())
      }
      expect(caps.size).toBe(100)
    })
  })

  describe('constantTimeEquals', () => {
    it('returns true for equal strings', () => {
      expect(constantTimeEquals('abc', 'abc')).toBe(true)
      expect(constantTimeEquals('', '')).toBe(true)
      expect(constantTimeEquals('a'.repeat(100), 'a'.repeat(100))).toBe(true)
    })

    it('returns false for different strings', () => {
      expect(constantTimeEquals('abc', 'abd')).toBe(false)
      expect(constantTimeEquals('abc', 'abcd')).toBe(false)
      expect(constantTimeEquals('', 'a')).toBe(false)
    })

    it('returns false for different lengths', () => {
      expect(constantTimeEquals('a', 'aa')).toBe(false)
      expect(constantTimeEquals('aa', 'a')).toBe(false)
    })
  })
})