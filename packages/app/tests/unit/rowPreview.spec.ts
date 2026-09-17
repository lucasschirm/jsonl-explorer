/**
 * escapeForSingleLine (TSK0021): list previews must always render as one
 * line — C0 control characters and DEL become \uXXXX escapes; everything
 * else (including Unicode) passes through unchanged.
 */
import { describe, it, expect } from 'vitest'
import { escapeForSingleLine } from '~/utils/rowPreview'

describe('escapeForSingleLine', () => {
  it('leaves printable text untouched (incl. Unicode and spaces)', () => {
    expect(escapeForSingleLine('{"a": 1} plain')).toBe('{"a": 1} plain')
    expect(escapeForSingleLine('héllo wörld 日本語 🚀')).toBe('héllo wörld 日本語 🚀')
    expect(escapeForSingleLine('')).toBe('')
  })

  it('escapes every C0 control character as \\u00XX', () => {
    expect(escapeForSingleLine('\u0000')).toBe('\\u0000')
    expect(escapeForSingleLine('a\u0001b')).toBe('a\\u0001b')
    expect(escapeForSingleLine('\t')).toBe('\\u0009')
    expect(escapeForSingleLine('x\u001fy')).toBe('x\\u001fy')
    expect(escapeForSingleLine('\u001b[31m')).toBe('\\u001b[31m')
  })

  it('escapes DEL (0x7F) but not other C1 characters', () => {
    expect(escapeForSingleLine('a\u007fb')).toBe('a\\u007fb')
    // C1 (0x80-0x9F) is not escaped: it is printable in UTF-8 contexts.
    expect(escapeForSingleLine('a\u0085b')).toBe('a\u0085b')
  })
})
