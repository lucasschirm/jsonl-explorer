/**
 * jsonTree helpers (TSK0024): parsing, container introspection, and the
 * presentation-only serializations.
 */
import { describe, it, expect } from 'vitest'
import {
  parseJsonText,
  isContainer,
  isArray,
  childCount,
  objectKeys,
  serializeFormatted,
  serializeCompact,
  formatBytes,
  type JsonValue,
} from '~/utils/jsonTree'

describe('parseJsonText', () => {
  it('parses every JSON shape without throwing', () => {
    expect(parseJsonText('{"a":[1,2], "b":null, "c":true, "d":"x"}').ok).toBe(true)
    expect(parseJsonText('"just a string"').ok).toBe(true)
    expect(parseJsonText('42').value).toBe(42)
    expect(parseJsonText('[]').value).toEqual([])
    expect(parseJsonText('null').value).toBeNull()
  })

  it('reports invalid JSON with a message (never throws)', () => {
    const bad = parseJsonText('{"a": }')
    expect(bad.ok).toBe(false)
    expect(bad.value).toBeNull()
    expect(bad.error).toBeTruthy()
    expect(parseJsonText('').ok).toBe(false)
  })
})

describe('container introspection', () => {
  const value: JsonValue = { a: [1, { b: null }], c: 'x' }

  it('distinguishes objects, arrays, and primitives', () => {
    expect(isContainer(value)).toBe(true)
    expect(isContainer([])).toBe(true)
    expect(isContainer('x')).toBe(false)
    expect(isContainer(null)).toBe(false)
    expect(isContainer(42)).toBe(false)
    expect(isArray(value)).toBe(false)
    expect(isArray([])).toBe(true)
  })

  it('counts children and lists keys in order', () => {
    expect(childCount(value)).toBe(2)
    expect(childCount([1, 2, 3])).toBe(3)
    expect(childCount('nope')).toBe(0)
    expect(objectKeys(value)).toEqual(['a', 'c'])
    expect(objectKeys([1, 2])).toEqual([])
  })
})

describe('presentation serializations (never edits)', () => {
  const value: JsonValue = { a: [1, 2], b: 'x' }

  it('format: two-space pretty; compact: minified', () => {
    expect(serializeFormatted(value)).toBe('{\n  "a": [\n    1,\n    2\n  ],\n  "b": "x"\n}')
    expect(serializeCompact(value)).toBe('{"a":[1,2],"b":"x"}')
  })
})

describe('formatBytes', () => {
  it('renders human sizes', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KiB')
    expect(formatBytes(1536 * 1024)).toBe('1.5 MiB')
  })
})
