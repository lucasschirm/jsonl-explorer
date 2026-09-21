/**
 * Local document search (TSK0033): pure helpers for the right-toolbar
 * text search over the SELECTED document (its parsed tree) — completely
 * independent from the whole-file filtering on the left (this module
 * never touches the filter store or the worker).
 *
 * - `findTreeMatches` walks the document in TREE render order (object
 *   keys in insertion order, arrays by index) and records matches on
 *   KEYS (substring) and on PRIMITIVE VALUES (strings by substring;
 *   numbers/booleans/null by their JSON token, e.g. `true`, `null`,
 *   `3.14`). Matching is LITERAL and case-sensitive, consistent with the
 *   whole-file text filter.
 * - A match's identity is its path. `pathKey` renders a path as a unique
 *   string (JSON.stringify of the segment array — JSON escaping keeps
 *   keys containing quotes/control characters unambiguous).
 * - `ancestorKeys` yields the parent path keys needed to auto-expand the
 *   containers that hold the current match.
 */
import type { JsonValue } from './jsonTree'
import type { EditPath } from './jsonEdit'

export type TreeMatchKind = 'key' | 'value'

export interface TreeMatch {
  /** Path from the document root: the key's path for key matches, the
   *  value's path for value matches. */
  path: EditPath
  kind: TreeMatchKind
}

/** Unique string identity of a path (safe for Sets and component props). */
export function pathKey(path: EditPath): string {
  return JSON.stringify(path)
}

/** Parent path keys of `path` (excluding the root) — the containers that
 *  must be expanded for the node at `path` to be visible. */
export function ancestorKeys(path: EditPath): string[] {
  const out: string[] = []
  for (let i = 1; i < path.length; i++) out.push(pathKey(path.slice(0, i)))
  return out
}

/** Literal content of a primitive: string content unquoted (matching is
 *  against what the user sees inside the quotes), everything else as its
 *  JSON token. */
function primitiveContent(value: JsonValue): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return value
  return String(value)
}

function collect(value: JsonValue, path: EditPath, query: string, out: TreeMatch[]): void {
  if (value !== null && typeof value === 'object') {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const item = value[i]
        if (item === undefined) continue
        collect(item, [...path, i], query, out)
      }
      return
    }
    for (const [key, child] of Object.entries(value as Record<string, JsonValue>)) {
      if (key.includes(query)) out.push({ path: [...path, key], kind: 'key' })
      collect(child, [...path, key], query, out)
    }
    return
  }
  if (primitiveContent(value).includes(query)) {
    out.push({ path, kind: 'value' })
  }
}

/** Every match in tree render order. An empty query yields no matches. */
export function findTreeMatches(value: JsonValue, query: string): TreeMatch[] {
  const out: TreeMatch[] = []
  if (query === '') return out
  collect(value, [], query, out)
  return out
}
