/**
 * TSK0037 - handover trust-boundary helpers (pure).
 *
 * The policy under test:
 * - host = opener, else parent (only when embedded), else none;
 * - allowlist = EXACT origins; the `same-origin` marker resolves at
 *   runtime; `*` fails CLOSED (never emitted as a target origin);
 * - a load is trusted only with origin on the list AND source === host;
 * - payload caps count BYTES (UTF-8 for strings).
 */
import { describe, expect, it } from 'vitest'
import {
  HANDOVER_READY_TIMEOUT_MS,
  fitsPayloadLimit,
  isTrustedLoadEvent,
  resolveAllowedOrigins,
  resolveHostWindow,
} from '~/utils/handover'

const ORIGIN = 'http://localhost:4173'

describe('resolveHostWindow', () => {
  it('prefers the opener (window.open flow)', () => {
    const self = {} as Window
    const opener = {} as Window
    const parent = {} as Window
    expect(resolveHostWindow({ opener, parent }, self)).toBe(opener)
  })

  it('uses the parent when embedded in an iframe (no opener)', () => {
    const self = {} as Window
    const parent = {} as Window
    expect(resolveHostWindow({ parent }, self)).toBe(parent)
  })

  it('returns null for a top-level window without an opener', () => {
    const self = {} as Window
    // parent === self is how a top-level window looks.
    expect(resolveHostWindow({ parent: self }, self)).toBeNull()
    expect(resolveHostWindow({}, self)).toBeNull()
  })
})

describe('resolveAllowedOrigins', () => {
  it('resolves the same-origin marker (and missing config) to the runtime origin', () => {
    expect(resolveAllowedOrigins('same-origin', ORIGIN)).toEqual([ORIGIN])
    expect(resolveAllowedOrigins(undefined, ORIGIN)).toEqual([ORIGIN])
    expect(resolveAllowedOrigins('', ORIGIN)).toEqual([ORIGIN])
  })

  it('keeps explicit origins (trimmed) and adds same-origin when marked', () => {
    expect(resolveAllowedOrigins('https://a.example, https://b.example', ORIGIN)).toEqual([
      'https://a.example',
      'https://b.example',
    ])
    // Explicit origins keep their order; the resolved same-origin is appended.
    expect(resolveAllowedOrigins('same-origin, https://a.example ,', ORIGIN)).toEqual([
      'https://a.example',
      ORIGIN,
    ])
  })

  it('drops the wildcard (fail closed) but keeps same-origin as the floor', () => {
    expect(resolveAllowedOrigins('*', ORIGIN)).toEqual([ORIGIN])
    expect(resolveAllowedOrigins('* , same-origin', ORIGIN)).toEqual([ORIGIN])
    expect(resolveAllowedOrigins('https://a.example, *', ORIGIN)).toEqual([
      'https://a.example',
    ])
  })
})

describe('isTrustedLoadEvent', () => {
  const host = {} as Window

  it('accepts only the exact origin AND the exact host window', () => {
    expect(
      isTrustedLoadEvent({ origin: ORIGIN, source: host }, host, [ORIGIN]),
    ).toBe(true)
  })

  it('rejects an origin that is not on the allowlist', () => {
    expect(
      isTrustedLoadEvent({ origin: 'https://evil.example', source: host }, host, [ORIGIN]),
    ).toBe(false)
  })

  it('rejects a different source window even with a good origin', () => {
    expect(
      isTrustedLoadEvent({ origin: ORIGIN, source: {} as Window }, host, [ORIGIN]),
    ).toBe(false)
  })

  it('rejects everything when there is no host', () => {
    expect(
      isTrustedLoadEvent({ origin: ORIGIN, source: host }, null, [ORIGIN]),
    ).toBe(false)
  })
})

describe('fitsPayloadLimit', () => {
  it('measures ArrayBuffers by byteLength (inclusive bound)', () => {
    expect(fitsPayloadLimit(new ArrayBuffer(100), 100)).toBe(true)
    expect(fitsPayloadLimit(new ArrayBuffer(101), 100)).toBe(false)
  })

  it('counts string BYTES in UTF-8, not UTF-16 units', () => {
    // ASCII: 1 byte per unit.
    expect(fitsPayloadLimit('a'.repeat(100), 100)).toBe(true)
    expect(fitsPayloadLimit('a'.repeat(101), 100)).toBe(false)
    // Multi-byte: 'é' is 2 UTF-8 bytes per 1 UTF-16 unit.
    expect(fitsPayloadLimit('é'.repeat(50), 100)).toBe(true)
    expect(fitsPayloadLimit('é'.repeat(51), 100)).toBe(false)
  })

  it('rejects long strings without encoding (length is a byte lower bound)', () => {
    expect(fitsPayloadLimit('é'.repeat(200), 100)).toBe(false)
  })
})

describe('HANDOVER_READY_TIMEOUT_MS', () => {
  it('is the documented 30 s handshake budget', () => {
    expect(HANDOVER_READY_TIMEOUT_MS).toBe(30_000)
  })
})
