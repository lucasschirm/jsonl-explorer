/**
 * JSONL Explorer - Handover Trust Boundary (TSK0037)
 *
 * Pure helpers for the postMessage handover handshake. The policy:
 *
 * - Only ONE window may hand data over: the opener (window.open) or,
 *   when embedded, the parent (iframe). Standalone pages have no host.
 * - A `load` is trusted only when BOTH hold: `event.origin` is on the
 *   exact allowlist AND `event.source` IS the host window. Origin
 *   checking alone is not enough (any page on an allowed origin could
 *   post to us); source checking alone is not enough (an allowed page
 *   could be spoofed into thinking it is the host).
 * - Replies always go to that host with the validated exact origin —
 *   never `*`.
 */

/** The default handshake budget: a `load` must arrive within 30 s of `ready`. */
export const HANDOVER_READY_TIMEOUT_MS = 30_000

interface HostWindowLike {
  opener?: Window | null
  parent?: Window | null
}

/**
 * The window that may hand data over: `window.opener` (window.open
 * flow) or, when we are embedded, `window.parent`. A top-level window
 * with no opener has no host.
 */
export function resolveHostWindow(host: HostWindowLike, self: Window): Window | null {
  if (host.opener) return host.opener
  if (host.parent && host.parent !== self) return host.parent
  return null
}

/**
 * Resolve the runtime allowlist to EXACT origins.
 *
 * - The `same-origin` marker (the default) resolves to the current origin.
 * - `*` fails CLOSED: it is dropped. A wildcard target origin would let
 *   any window read our replies, so it is never emitted.
 * - An empty/missing list resolves to same-origin only.
 */
export function resolveAllowedOrigins(raw: string | undefined, currentOrigin: string): string[] {
  // The `same-origin` marker and `*` are not origins: the marker resolves
  // below, the wildcard fails closed (it would let any window read our
  // replies).
  const entries = (raw ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0 && o !== '*' && o !== 'same-origin')
  const origins = new Set<string>(entries)
  if (!raw || raw.includes('same-origin') || entries.length === 0) origins.add(currentOrigin)
  return [...origins]
}

/**
 * Trust check for an inbound `load`: exact origin on the allowlist AND
 * the event source being exactly the host window.
 */
export function isTrustedLoadEvent(
  event: { origin: string; source: unknown },
  host: Window | null,
  allowedOrigins: readonly string[],
): boolean {
  if (!host) return false
  if (!allowedOrigins.includes(event.origin)) return false
  return event.source === host
}

/**
 * Does the payload fit the handover cap, in BYTES?
 * Strings are UTF-8: one UTF-16 code unit is always >= 1 UTF-8 byte, so
 * `length > maxBytes` rejects without encoding; near the cap we encode
 * for the exact count (multi-byte characters cost more than `length`).
 */
export function fitsPayloadLimit(payload: string | ArrayBuffer, maxBytes: number): boolean {
  if (payload instanceof ArrayBuffer) return payload.byteLength <= maxBytes
  if (payload.length > maxBytes) return false
  return new TextEncoder().encode(payload).byteLength <= maxBytes
}
