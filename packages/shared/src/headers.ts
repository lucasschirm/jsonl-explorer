/**
 * Shared header-name contract.
 *
 * Both the page (inline validation in the URL modal) and the worker
 * (defense-in-depth before fetch) validate header names against the same
 * rule: the RFC 7230 token charset. Keeping it in one place prevents the
 * UI and the worker from drifting apart.
 */

/** RFC 7230 header-name token charset. */
export const HEADER_NAME_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

/** True when `name` is a valid HTTP header name (token charset, 1-256 chars). */
export function isValidHeaderName(name: string): boolean {
  return name.length > 0 && name.length <= 256 && HEADER_NAME_TOKEN_RE.test(name)
}
