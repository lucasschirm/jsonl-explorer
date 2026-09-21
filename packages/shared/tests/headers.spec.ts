import { describe, it, expect } from 'vitest'
import { HEADER_NAME_TOKEN_RE, isValidHeaderName } from '../src/headers.js'

describe('isValidHeaderName', () => {
  it('accepts ordinary header names', () => {
    expect(isValidHeaderName('Authorization')).toBe(true)
    expect(isValidHeaderName('X-Custom-Header')).toBe(true)
    expect(isValidHeaderName('Content-Type')).toBe(true)
    expect(isValidHeaderName('!#$%&\'*+-.^_`|~')).toBe(true)
  })

  it('rejects empty names', () => {
    expect(isValidHeaderName('')).toBe(false)
  })

  it('rejects names with whitespace or control characters', () => {
    expect(isValidHeaderName('Bad Name')).toBe(false)
    expect(isValidHeaderName('Bad\nName')).toBe(false)
    expect(isValidHeaderName('Bad\rName')).toBe(false)
    expect(isValidHeaderName('Bad\tName')).toBe(false)
    expect(isValidHeaderName('Bad/Name')).toBe(false)
    expect(isValidHeaderName('Bad:Name')).toBe(false)
  })

  it('rejects names over 256 characters', () => {
    expect(isValidHeaderName(`X-${'a'.repeat(256)}`)).toBe(false)
    expect(isValidHeaderName(`X-${'a'.repeat(253)}`)).toBe(true)
  })

  it('exposes the token regex for direct use', () => {
    expect(HEADER_NAME_TOKEN_RE.test('ok-name')).toBe(true)
    expect(HEADER_NAME_TOKEN_RE.test('no space')).toBe(false)
  })
})
