import { describe, it, expect } from 'vitest'
import { formatBytes, formatInt } from '~/utils/format'

describe('formatBytes', () => {
  it('formats below 1 KiB as whole bytes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1)).toBe('1 B')
    expect(formatBytes(1023)).toBe('1023 B')
  })

  it('formats binary units with one decimal under 100', () => {
    expect(formatBytes(1024)).toBe('1.0 KiB')
    expect(formatBytes(1536)).toBe('1.5 KiB')
    expect(formatBytes(1048576)).toBe('1.0 MiB')
    expect(formatBytes(134217728)).toBe('128 MiB')
    expect(formatBytes(1073741824)).toBe('1.0 GiB')
    expect(formatBytes(1099511627776)).toBe('1.0 TiB')
  })

  it('drops the decimal at 100 and above', () => {
    expect(formatBytes(102400)).toBe('100 KiB')
    expect(formatBytes(107374182400)).toBe('100 GiB')
  })

  it('rejects invalid input', () => {
    expect(formatBytes(-5)).toBe('0 B')
    expect(formatBytes(NaN)).toBe('0 B')
    expect(formatBytes(Infinity)).toBe('0 B')
  })
})

describe('formatInt', () => {
  it('groups thousands with en-US separators', () => {
    expect(formatInt(0)).toBe('0')
    expect(formatInt(999)).toBe('999')
    expect(formatInt(1234)).toBe('1,234')
    expect(formatInt(123456789)).toBe('123,456,789')
  })

  it('truncates fractions and rejects invalid input', () => {
    expect(formatInt(12.9)).toBe('12')
    expect(formatInt(NaN)).toBe('0')
  })
})
