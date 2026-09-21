/**
 * Pure JSON helpers for the read-only detail tree (TSK0024).
 *
 * Parsing is defensive: a JSONL row is valid JSON or it is not — there is
 * no partial recovery. The tree renders whatever `JSON.parse` returns;
 * collapse state lives in the components, never here (no source mutation).
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

export interface JsonParseResult {
  ok: boolean
  value: JsonValue | null
  error: string | null
}

/** Parses a full row as JSON. Never throws. */
export function parseJsonText(text: string): JsonParseResult {
  try {
    return { ok: true, value: JSON.parse(text) as JsonValue, error: null }
  } catch (error) {
    return {
      ok: false,
      value: null,
      error: error instanceof Error ? error.message : 'Invalid JSON',
    }
  }
}

/** True for objects and arrays (the only collapsible containers). */
export function isContainer(value: JsonValue): boolean {
  return value !== null && typeof value === 'object'
}

/** True for arrays (affects the collapsed bracket style). */
export function isArray(value: JsonValue): boolean {
  return Array.isArray(value)
}

/** Child count of a container (keys or elements). */
export function childCount(value: JsonValue): number {
  if (Array.isArray(value)) return value.length
  if (value !== null && typeof value === 'object') return Object.keys(value).length
  return 0
}

/** Object keys in insertion order (arrays have no keys). */
export function objectKeys(value: JsonValue): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.keys(value)
}

/** Presentation-only serializations (never touch the worker, TSK0024). */
export function serializeFormatted(value: JsonValue): string {
  return JSON.stringify(value, null, 2) ?? ''
}

export function serializeCompact(value: JsonValue): string {
  return JSON.stringify(value) ?? ''
}

/** Human size for the large-row confirmation (e.g. "1.3 MiB"). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kiB = bytes / 1024
  if (kiB < 1024) return `${kiB.toFixed(1)} KiB`
  return `${(kiB / 1024).toFixed(1)} MiB`
}
