import { describe, it, expect } from 'vitest'
import {
  HANDOVER_NAMESPACE,
  HANDOVER_VERSION,
  HANDOVER_MAX_PAYLOAD_BYTES,
  getAllowedOrigins,
  isOriginAllowed,
  validateHandoverMessage,
  validateLoadMessage,
  createReadyMessage,
  createLoadedMessage,
  createErrorMessage,
} from '../src/handover.js'

describe('Handover Protocol', () => {
  describe('Constants', () => {
    it('should have correct namespace', () => {
      expect(HANDOVER_NAMESPACE).toBe('jsonl-explorer')
    })

    it('should have version 1', () => {
      expect(HANDOVER_VERSION).toBe(1)
    })

    it('should have 100MB max payload', () => {
      expect(HANDOVER_MAX_PAYLOAD_BYTES).toBe(100 * 1024 * 1024)
    })
  })

  describe('getAllowedOrigins', () => {
    it('should return default when no env provided', () => {
      expect(getAllowedOrigins()).toEqual(['same-origin'])
    })

    it('should parse comma-separated origins', () => {
      expect(getAllowedOrigins('https://a.com, https://b.com')).toEqual(['https://a.com', 'https://b.com'])
    })

    it('should trim whitespace', () => {
      expect(getAllowedOrigins('  https://a.com , https://b.com  ')).toEqual(['https://a.com', 'https://b.com'])
    })

    it('should filter empty entries', () => {
      expect(getAllowedOrigins('https://a.com,,https://b.com')).toEqual(['https://a.com', 'https://b.com'])
    })
  })

  describe('isOriginAllowed', () => {
    it('should allow same-origin when configured', () => {
      expect(isOriginAllowed('https://any.com', 'same-origin')).toBe(true)
    })

    it('should check against allowed list', () => {
      expect(isOriginAllowed('https://a.com', 'https://a.com,https://b.com')).toBe(true)
      expect(isOriginAllowed('https://c.com', 'https://a.com,https://b.com')).toBe(false)
    })
  })

  describe('validateHandoverMessage', () => {
    it('should reject non-objects', () => {
      expect(validateHandoverMessage(null)).toBe(false)
      expect(validateHandoverMessage('string')).toBe(false)
      expect(validateHandoverMessage(123)).toBe(false)
    })

    it('should reject wrong namespace', () => {
      expect(validateHandoverMessage({ ns: 'wrong', v: 1, type: 'ready' })).toBe(false)
    })

    it('should reject wrong version', () => {
      expect(validateHandoverMessage({ ns: 'jsonl-explorer', v: 2, type: 'ready' })).toBe(false)
    })

    it('should reject missing type', () => {
      expect(validateHandoverMessage({ ns: 'jsonl-explorer', v: 1 })).toBe(false)
    })

    it('should accept valid ready message', () => {
      expect(validateHandoverMessage({ ns: 'jsonl-explorer', v: 1, type: 'ready' })).toBe(true)
    })

    it('should accept valid load message', () => {
      expect(validateHandoverMessage({ ns: 'jsonl-explorer', v: 1, type: 'load', name: 'test', payload: '' })).toBe(true)
    })
  })

  describe('validateLoadMessage', () => {
    it('should reject non-load messages', () => {
      expect(validateLoadMessage({ ns: 'jsonl-explorer', v: 1, type: 'ready' })).toBe(false)
    })

    it('should reject missing name', () => {
      expect(validateLoadMessage({ ns: 'jsonl-explorer', v: 1, type: 'load', payload: '' })).toBe(false)
    })

    it('should reject empty name', () => {
      expect(validateLoadMessage({ ns: 'jsonl-explorer', v: 1, type: 'load', name: '', payload: '' })).toBe(false)
    })

    it('should reject invalid payload', () => {
      expect(validateLoadMessage({ ns: 'jsonl-explorer', v: 1, type: 'load', name: 'test', payload: 123 })).toBe(false)
    })

    it('should accept valid load message with string payload', () => {
      expect(validateLoadMessage({ ns: 'jsonl-explorer', v: 1, type: 'load', name: 'test', payload: 'data' })).toBe(true)
    })

    it('should accept valid load message with ArrayBuffer payload', () => {
      expect(validateLoadMessage({ ns: 'jsonl-explorer', v: 1, type: 'load', name: 'test', payload: new ArrayBuffer(10) })).toBe(true)
    })
  })

  describe('createReadyMessage', () => {
    it('should create correct message', () => {
      const msg = createReadyMessage()
      expect(msg.ns).toBe('jsonl-explorer')
      expect(msg.v).toBe(1)
      expect(msg.type).toBe('ready')
    })
  })

  describe('createLoadedMessage', () => {
    it('should create correct message', () => {
      const msg = createLoadedMessage(42)
      expect(msg.ns).toBe('jsonl-explorer')
      expect(msg.v).toBe(1)
      expect(msg.type).toBe('loaded')
      expect(msg.lines).toBe(42)
    })
  })

  describe('createErrorMessage', () => {
    it('should create correct message', () => {
      const msg = createErrorMessage('Something went wrong')
      expect(msg.ns).toBe('jsonl-explorer')
      expect(msg.v).toBe(1)
      expect(msg.type).toBe('error')
      expect(msg.message).toBe('Something went wrong')
    })
  })
})