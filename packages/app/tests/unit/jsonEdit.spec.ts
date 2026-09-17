/**
 * jsonEdit (TSK0031): coercion (JSON.parse first, string fallback),
 * immutable path application with stale-path detection, raw tokens, and
 * compact single-line serialization.
 */
import { describe, it, expect } from 'vitest'
import {
  applyValueAtPath,
  coerceEdit,
  rawTokenForValue,
  readValueAtPath,
  serializeEdited,
  type EditPath,
} from '~/utils/jsonEdit'
import type { JsonValue } from '~/utils/jsonTree'

describe('coerceEdit', () => {
  it('parses valid JSON into its real type', () => {
    expect(coerceEdit('42')).toBe(42)
    expect(coerceEdit('3.14')).toBeCloseTo(3.14)
    expect(coerceEdit('true')).toBe(true)
    expect(coerceEdit('false')).toBe(false)
    expect(coerceEdit('null')).toBeNull()
    expect(coerceEdit('"hi"')).toBe('hi')
    expect(coerceEdit('[1,2]')).toEqual([1, 2])
    expect(coerceEdit('{"a":1}')).toEqual({ a: 1 })
  })

  it('falls back to the literal string for invalid JSON', () => {
    expect(coerceEdit('hi')).toBe('hi')
    expect(coerceEdit('12abc')).toBe('12abc')
    expect(coerceEdit('')).toBe('')
    expect(coerceEdit('"unterminated')).toBe('"unterminated')
  })

  it('rejects non-finite number literals (they would serialize as null)', () => {
    expect(coerceEdit('1e400')).toBe('1e400')
    expect(coerceEdit('-1e999')).toBe('-1e999')
  })

  it('keeps strings containing CR/LF escaped-safe after serialization', () => {
    // A JSON string may contain escaped newlines; the RAW input cannot
    // (edits are single-line), but the round-trip must stay one line.
    const value = coerceEdit('{"s":"a\\nb"}')
    const out = serializeEdited(value)
    expect(out).toBe('{"s":"a\\nb"}')
    expect(out.includes('\n')).toBe(false)
    expect(out.includes('\r')).toBe(false)
  })
})

const DOC: JsonValue = {
  a: 1,
  b: { c: 'x', d: [10, 20, { e: true }] },
  s: 'top',
}

describe('applyValueAtPath', () => {
  it('replaces the root (empty path)', () => {
    expect(applyValueAtPath(DOC, [], 99)).toBe(99)
  })

  it('replaces nested object and array values', () => {
    expect(applyValueAtPath(DOC, ['a'], 'one')).toEqual({
      a: 'one',
      b: { c: 'x', d: [10, 20, { e: true }] },
      s: 'top',
    })
    expect(applyValueAtPath(DOC, ['b', 'c'], null)).toEqual({
      a: 1,
      b: { c: null, d: [10, 20, { e: true }] },
      s: 'top',
    })
    expect(applyValueAtPath(DOC, ['b', 'd', 1], 21)).toEqual({
      a: 1,
      b: { c: 'x', d: [10, 21, { e: true }] },
      s: 'top',
    })
  })

  it('replaces a whole container (object -> scalar, array -> object)', () => {
    expect(applyValueAtPath(DOC, ['b'], 42)).toEqual({ a: 1, b: 42, s: 'top' })
    expect(applyValueAtPath(DOC, ['b', 'd'], { replaced: true })).toEqual({
      a: 1,
      b: { c: 'x', d: { replaced: true } },
      s: 'top',
    })
  })

  it('never mutates the input document', () => {
    const before = JSON.stringify(DOC)
    applyValueAtPath(DOC, ['b', 'd', 2, 'e'], false)
    expect(JSON.stringify(DOC)).toBe(before)
  })

  it('returns null for stale or invalid paths (one toast upstream)', () => {
    expect(applyValueAtPath(DOC, ['missing'], 1)).toBeNull()
    expect(applyValueAtPath(DOC, ['missing', 'deep'], 1)).toBeNull()
    expect(applyValueAtPath(DOC, ['s', 'a'], 1)).toBeNull() // s is a string
    expect(applyValueAtPath(DOC, ['b', 'd', 99], 1)).toBeNull() // out of range
    expect(applyValueAtPath(DOC, ['b', 'd', -1], 1)).toBeNull()
    expect(applyValueAtPath(42, ['a'], 1)).toBeNull() // root scalar
    expect(applyValueAtPath(null, [], 1)).toBe(1) // root replacement is fine
  })
})

describe('readValueAtPath', () => {
  it('reads root and nested values', () => {
    expect(readValueAtPath(DOC, [])).toEqual(DOC)
    expect(readValueAtPath(DOC, ['a'])).toBe(1)
    expect(readValueAtPath(DOC, ['b', 'd', 2, 'e'])).toBe(true)
  })

  it('returns null for stale paths', () => {
    expect(readValueAtPath(DOC, ['nope'])).toBeNull()
    expect(readValueAtPath(DOC, ['s', 0])).toBeNull()
    expect(readValueAtPath(DOC, ['b', 'd', 5])).toBeNull()
  })
})

describe('rawTokenForValue / serializeEdited', () => {
  it('seeds the editor with the compact JSON of the value', () => {
    expect(rawTokenForValue('hi')).toBe('"hi"')
    expect(rawTokenForValue(42)).toBe('42')
    expect(rawTokenForValue(true)).toBe('true')
    expect(rawTokenForValue(null)).toBe('null')
    expect(rawTokenForValue([1, { a: 'b' }])).toBe('[1,{"a":"b"}]')
  })

  it('serializes the whole document compactly on exactly one line', () => {
    const out = serializeEdited({ z: 1, list: [1, 2], s: 'a\nb' })
    expect(out).toBe('{"z":1,"list":[1,2],"s":"a\\nb"}')
    expect(out).not.toContain('\n')
    expect(out).not.toContain('\r')
  })

  it('round-trips: parse(serialize(doc)) deep-equals doc', () => {
    const doc: JsonValue = { n: 1, arr: [null, 'x', [2]], obj: { k: false } }
    expect(JSON.parse(serializeEdited(doc))).toEqual(doc)
  })
})

describe('edit session end-to-end (pure)', () => {
  it('read -> edit -> serialize produces the expected new document', () => {
    const path: EditPath = ['b', 'd', 0]
    const current = readValueAtPath(DOC, path)
    expect(current).toBe(10)
    const next = applyValueAtPath(DOC, path, coerceEdit('ten'))
    expect(serializeEdited(next!)).toBe(
      '{"a":1,"b":{"c":"x","d":["ten",20,{"e":true}]},"s":"top"}',
    )
  })
})
