/**
 * Local document search (TSK0033): pure matching over the parsed tree —
 * literal, case-sensitive; keys and primitive values; tree render order;
 * path identity helpers (pathKey/ancestorKeys).
 */
import { describe, it, expect } from 'vitest'
import { findTreeMatches, pathKey, ancestorKeys } from '~/utils/detailSearch'
import type { JsonValue } from '~/utils/jsonTree'

const DOC: JsonValue = {
  name: 'alpha',
  tags: ['x', 'xy'],
  meta: { owner: 'beta', active: true, score: 3.5, note: null },
  list: [{ id: 'x1' }, { id: 'x2' }],
  'weird\u0000key': 'x in a tricky key',
}

describe('findTreeMatches', () => {
  it('matches object keys (literal, case-sensitive)', () => {
    const matches = findTreeMatches(DOC, 'name')
    expect(matches).toEqual([{ path: ['name'], kind: 'key' }])
    // case-sensitive: "Name" matches nothing
    expect(findTreeMatches(DOC, 'Name')).toEqual([])
  })

  it('matches string values by substring', () => {
    const matches = findTreeMatches(DOC, 'alpha')
    expect(matches).toEqual([{ path: ['name'], kind: 'value' }])
  })

  it('a key AND its value can match the same query', () => {
    // "score" appears as a key; "3.5" as its value — one query each:
    expect(findTreeMatches(DOC, 'score')).toEqual([{ path: ['meta', 'score'], kind: 'key' }])
    expect(findTreeMatches(DOC, '3.5')).toEqual([{ path: ['meta', 'score'], kind: 'value' }])
  })

  it('matches array elements by index (number segments)', () => {
    const matches = findTreeMatches(DOC, 'xy')
    // tags[1] = "xy" (exact substring "xy") and "x" is a substring of "xy"
    // too — but query "xy" matches only "xy":
    expect(matches).toEqual([{ path: ['tags', 1], kind: 'value' }])
  })

  it('matches boolean and null tokens', () => {
    expect(findTreeMatches(DOC, 'true')).toEqual([{ path: ['meta', 'active'], kind: 'value' }])
    expect(findTreeMatches(DOC, 'null')).toEqual([{ path: ['meta', 'note'], kind: 'value' }])
  })

  it('containers contribute nothing — only keys and primitive values match', () => {
    // "ta" hits the keys tags/meta and the value "beta" — but never the
    // containers themselves:
    expect(findTreeMatches(DOC, 'ta')).toEqual([
      { path: ['tags'], kind: 'key' },
      { path: ['meta'], kind: 'key' },
      { path: ['meta', 'owner'], kind: 'value' },
    ])
  })

  it('matches in tree render order (document order)', () => {
    const matches = findTreeMatches(DOC, 'x')
    const keys = matches.map((m) => `${m.kind}:${pathKey(m.path)}`)
    expect(keys).toEqual([
      'value:["tags",0]',
      'value:["tags",1]',
      'value:["list",0,"id"]',
      'value:["list",1,"id"]',
      'value:["weird\\u0000key"]', // JSON.stringify escapes the NUL
    ])
  })

  it('matches a primitive ROOT document', () => {
    expect(findTreeMatches('hello', 'ell')).toEqual([{ path: [], kind: 'value' }])
    expect(findTreeMatches(42, '4')).toEqual([{ path: [], kind: 'value' }])
  })

  it('an empty query yields no matches (and never throws)', () => {
    expect(findTreeMatches(DOC, '')).toEqual([])
    expect(findTreeMatches(null, 'x')).toEqual([])
    expect(findTreeMatches([], 'x')).toEqual([])
  })

  it('a query inside a key name but not a value only matches the key', () => {
    const doc = { 'x-note': 'nothing here' }
    expect(findTreeMatches(doc, 'x-note')).toEqual([{ path: ['x-note'], kind: 'key' }])
  })
})

describe('pathKey / ancestorKeys', () => {
  it('pathKey is unique per path (control chars and quotes included)', () => {
    expect(pathKey(['a\u0000b'])).not.toBe(pathKey(['a', 'b']))
    expect(pathKey(['a"b'])).not.toBe(pathKey(['a', 'b']))
    expect(pathKey(['a', 1])).not.toBe(pathKey(['a', '1']))
  })

  it('ancestorKeys returns all proper prefixes (root excluded)', () => {
    expect(ancestorKeys([])).toEqual([])
    expect(ancestorKeys(['a'])).toEqual([])
    expect(ancestorKeys(['a', 'b', 0, 'c'])).toEqual([pathKey(['a']), pathKey(['a', 'b']), pathKey(['a', 'b', 0])])
  })
})
