/**
 * URL validation and sanitization for the worker-owned URL source.
 *
 * Security rules (ADR-008, PLAN R11):
 * - Only `http:` / `https:` URLs may be fetched (no file:, blob:, ...).
 * - Custom headers are validated (token charset names) and sanitized:
 *   forbidden hop-by-hop names are dropped so they can never reach the
 *   network or be reflected back into events.
 * - URLs are redacted of userinfo (`user:pass@`) before they appear in
 *   error messages or protocol events, so credentials never leak into
 *   logs, toasts, or the main thread.
 */

import { isValidHeaderName } from '@jsonl-explorer/shared'

/** Header names the worker must never put on the wire (lowercase). */
const FORBIDDEN_HEADERS = new Set([
  'accept-encoding',
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/** Typed error: the URL is not parseable or not http(s). */
export class UrlValidationError extends Error {
  readonly code = 'URL_INVALID' as const

  constructor(detail: string) {
    super(`Invalid URL: ${detail}`)
    this.name = 'UrlValidationError'
  }
}

/** Typed error: a custom header failed validation. */
export class UrlInvalidHeadersError extends Error {
  readonly code = 'URL_INVALID_HEADERS' as const

  constructor(detail: string) {
    super(`Invalid request headers: ${detail}`)
    this.name = 'UrlInvalidHeadersError'
  }
}

/** Typed error: the fetch failed and the most likely cause is CORS. */
export class UrlCorsDeniedError extends Error {
  readonly code = 'URL_CORS_DENIED' as const

  constructor(url: string) {
    super(
      `Could not fetch ${redactUrl(url)}: the server may not allow cross-origin ` +
        'access (CORS) or the network request failed',
    )
    this.name = 'UrlCorsDeniedError'
  }
}

/** Typed error: redirect handling failed (loop or non-http target). */
export class UrlRedirectDeniedError extends Error {
  readonly code = 'URL_REDIRECT_DENIED' as const

  constructor(detail: string) {
    super(`Redirect denied: ${detail}`)
    this.name = 'UrlRedirectDeniedError'
  }
}

/**
 * Validates that `url` parses and uses http/https.
 * @returns the parsed URL (safe to read `.origin`, `.pathname`, ...).
 * @throws {UrlValidationError} for malformed URLs or other schemes.
 */
export function validateHttpUrl(url: string): URL {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new UrlValidationError('not a parseable URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UrlValidationError(`scheme "${parsed.protocol}" is not http/https`)
  }
  return parsed
}

/**
 * Validates and sanitizes custom request headers.
 * - Invalid names (outside the HTTP token charset) are rejected.
 * - Forbidden hop-by-hop names are dropped.
 * - Empty values are dropped.
 * The returned object is what should be passed to `fetch`; secret values
 * stay in the worker and are never logged or posted.
 */
export function sanitizeHeaders(headers?: Record<string, string>): Record<string, string> {
  if (!headers) return {}
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (!isValidHeaderName(name)) {
      throw new UrlInvalidHeadersError(`"${name}" is not a valid header name`)
    }
    if (FORBIDDEN_HEADERS.has(name.toLowerCase())) continue
    if (value === '') continue
    out[name] = value
  }
  return out
}

/**
 * Strips userinfo credentials from a URL for user-visible surfaces
 * (error messages, protocol events). Non-URL input is returned as-is.
 */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url)
    if (u.username !== '' || u.password !== '') {
      u.username = ''
      u.password = ''
    }
    return u.toString()
  } catch {
    return url
  }
}

/**
 * True when the URL's origin differs from the page origin. The page origin
 * is passed by the page in the init request (dedicated workers cannot read
 * `location`); when either side is unparseable the pair is treated as
 * same-origin (the CORS heuristic stays conservative).
 */
export function isCrossOrigin(url: string, pageOrigin: string | undefined): boolean {
  if (!pageOrigin) return false
  try {
    return new URL(url).origin !== new URL(pageOrigin).origin
  } catch {
    return false
  }
}
