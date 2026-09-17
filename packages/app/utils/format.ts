/**
 * Presentation-only number formatting for the loading UI. Pure functions,
 * no locale coupling (en-US grouping) so tests are stable.
 */

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const

/** Formats a byte count with binary units: `0 B`, `1.5 KiB`, `12.3 MiB`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  if (unit === 0) return `${Math.round(value)} B`
  const text = value >= 100 ? String(Math.round(value)) : value.toFixed(1)
  return `${text} ${BYTE_UNITS[unit]}`
}

/** Formats an integer with en-US thousands grouping: `12 345` → `12,345`. */
export function formatInt(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return Math.trunc(value).toLocaleString('en-US')
}
