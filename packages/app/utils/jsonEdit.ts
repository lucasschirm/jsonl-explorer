/**
 * JSON tree editing (TSK0031): pure helpers for inline value edits.
 *
 * The contract:
 * - `coerceEdit` parses the raw editor input with JSON.parse FIRST and
 *   falls back to the literal string — `42` becomes a number, `hi` stays
 *   a string (docs: "Valid JSON → parsed as that type; Invalid JSON →
 *   stored as string"). Non-finite number literals (e.g. `1e400`) would
 *   serialize back as `null` (silent data change), so they fall back to
 *   string as well.
 * - `applyValueAtPath` immutably replaces the value at an existing path;
 *   it returns `null` when the path no longer exists (a stale edit after
 *   the row changed) — callers surface that as one toast, never a guess.
 * - `serializeEdited` renders the whole edited document as COMPACT valid
 *   JSON: exactly one row, and JSON.stringify escapes any control
 *   character (CR/LF cannot appear literally), so "one row in, one row
 *   out" holds by construction.
 *
 * The store mirrors the serialized document with ONE setEdit call
 * ("mirror it once"); the worker stays authoritative.
 */
import type { JsonValue } from './jsonTree'

/** A path of object keys / array indices from the document root. */
export type EditPath = (string | number)[]

/** Coerce raw editor input: JSON.parse first, literal string as fallback. */
export function coerceEdit(raw: string): JsonValue {
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value === 'number' && !Number.isFinite(value)) {
      // 1e400 parses to Infinity, which would serialize back as null.
      return raw
    }
    return value as JsonValue
  } catch {
    return raw
  }
}

/** Stale-path sentinel: distinct from a legitimate `null` value. */
const STALE = Symbol('stale-path')
type ApplyResult = JsonValue | typeof STALE

function applyIn(doc: JsonValue, path: EditPath, value: JsonValue): ApplyResult {
  if (path.length === 0) return value
  if (doc === null || typeof doc !== 'object') return STALE
  const [head, ...rest] = path
  if (head === undefined) return STALE
  if (Array.isArray(doc)) {
    if (typeof head !== 'number' || head < 0 || head >= doc.length) return STALE
    const child = applyIn(doc[head]!, rest, value)
    if (child === STALE) return STALE
    const copy = doc.slice()
    copy[head] = child
    return copy
  }
  if (typeof head !== 'string' || !(head in doc)) return STALE
  const record = doc as Record<string, JsonValue>
  const child = applyIn(record[head]!, rest, value)
  if (child === STALE) return STALE
  return { ...record, [head]: child }
}

/**
 * Return a copy of `doc` with `value` set at `path` (the path must exist),
 * or `null` when the path does not resolve (stale edit). The input is
 * never mutated. (A sentinel keeps a legitimate `null` value distinct
 * from a stale path.)
 */
export function applyValueAtPath(
  doc: JsonValue,
  path: EditPath,
  value: JsonValue,
): JsonValue | null {
  const result = applyIn(doc, path, value)
  return result === STALE ? null : result
}

/**
 * Read the value at `path` (null when the path does not resolve).
 * Used to seed the editor input with the current value's raw token.
 */
export function readValueAtPath(doc: JsonValue, path: EditPath): JsonValue | null {
  let cursor: JsonValue = doc
  for (const segment of path) {
    if (cursor === null || typeof cursor !== 'object') return null
    if (Array.isArray(cursor)) {
      if (typeof segment !== 'number' || segment < 0 || segment >= cursor.length) return null
      cursor = cursor[segment]!
    } else {
      if (typeof segment !== 'string' || !(segment in cursor)) return null
      cursor = (cursor as Record<string, JsonValue>)[segment]!
    }
  }
  return cursor
}

/**
 * The raw editor text for a value (what the input shows on focus): the
 * compact JSON of the value. Primitives render as their literal token
 * (`"hi"`, `42`, `null`), containers as minified JSON.
 */
export function rawTokenForValue(value: JsonValue): string {
  return JSON.stringify(value)
}

/** Serialize the complete edited document: compact, valid, one row. */
export function serializeEdited(doc: JsonValue): string {
  return JSON.stringify(doc)
}
