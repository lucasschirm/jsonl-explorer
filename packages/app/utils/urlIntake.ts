/**
 * URL-open intake decisions for the landing-page modal.
 *
 * Pure functions only (no DOM, no network, no stores) so every validation
 * rule is unit-testable in isolation. The component maps these decisions
 * to inline errors, warnings, and engine calls.
 *
 * Security: the normalized URL is the only value handed to the engine.
 * Header values (potentially credentials) are validated here but never
 * logged, persisted, or echoed into error messages — they travel directly
 * to the worker, which keeps them in memory for the fetch.
 */

import { isValidHeaderName } from '@jsonl-explorer/shared'

/** Browser-forbidden header names (fetch rejects these anyway; we give a
 *  clearer inline message instead). Lowercase. */
export const FORBIDDEN_HEADER_NAMES: ReadonlySet<string> = new Set([
  'accept-charset',
  'accept-encoding',
  'access-control-request-headers',
  'access-control-request-method',
  'connection',
  'content-length',
  'cookie',
  'cookie2',
  'date',
  'dnt',
  'expect',
  'host',
  'keep-alive',
  'origin',
  'referer',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'user-agent',
  'via',
])

/** Header names that typically carry credentials; a non-blocking warning
 *  is shown so the user knows the value is kept in memory only. */
const CREDENTIAL_LIKE_NAMES: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'api-key',
  'x-api-key',
  'x-auth-token',
  'x-access-token',
  'x-session-token',
  'token',
])

export const MAX_HEADER_NAME_LENGTH = 256
export const MAX_HEADER_VALUE_LENGTH = 4096

/** Result of validating the URL input field. */
export type UrlIntake =
  | { kind: 'empty' }
  | { kind: 'invalid'; message: string }
  | { kind: 'ready'; url: string }

/**
 * Validates and normalizes the raw URL input.
 *
 * Rules (PLAN 4.1): http/https only; embedded userinfo credentials and
 * fragments are rejected (secrets must never travel in routes/persistence);
 * surrounding whitespace is trimmed; the canonical `URL#toString()` form is
 * returned so the engine, metadata, and UI all agree on one string.
 */
export function decideUrlInput(raw: string): UrlIntake {
  const input = raw.trim()
  if (input === '') return { kind: 'empty' }

  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    return { kind: 'invalid', message: 'Invalid URL format' }
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { kind: 'invalid', message: 'Only HTTP and HTTPS URLs are supported' }
  }
  if (parsed.username !== '' || parsed.password !== '') {
    // The message never echoes the credential material itself.
    return { kind: 'invalid', message: 'URLs with embedded credentials are not allowed' }
  }
  if (parsed.hash !== '') {
    return { kind: 'invalid', message: 'URL fragments (#...) are not allowed' }
  }
  return { kind: 'ready', url: parsed.toString() }
}

/** Result of validating one header row. */
export type HeaderRowIntake =
  | { kind: 'skip' }
  | { kind: 'invalid'; message: string }
  | { kind: 'ready'; name: string; value: string; credentialLike: boolean }

/**
 * Validates one header row. `seenNames` (lowercased, trimmed) is maintained
 * by the caller across rows so duplicates are reported deterministically.
 *
 * A row is skipped (not an error) when both fields are blank — the modal
 * always renders at least one empty starter row.
 */
export function decideHeaderRow(
  key: string,
  value: string,
  seenNames: Set<string>,
): HeaderRowIntake {
  const name = key.trim()
  const val = value.trim()

  if (name === '' && val === '') return { kind: 'skip' }
  if (name === '') return { kind: 'invalid', message: 'Header name cannot be empty' }

  // Length caps first: a too-long name gets a specific message instead of
  // the generic charset rejection.
  if (name.length > MAX_HEADER_NAME_LENGTH) {
    return { kind: 'invalid', message: `Header name too long (max ${MAX_HEADER_NAME_LENGTH})` }
  }
  if (val.length > MAX_HEADER_VALUE_LENGTH) {
    return { kind: 'invalid', message: `Header value too long (max ${MAX_HEADER_VALUE_LENGTH})` }
  }
  if (!isValidHeaderName(name)) {
    return {
      kind: 'invalid',
      message: `Header name "${name}" is not a valid HTTP header name`,
    }
  }

  const lower = name.toLowerCase()
  if (FORBIDDEN_HEADER_NAMES.has(lower)) {
    return { kind: 'invalid', message: `Header "${name}" is forbidden by the browser` }
  }
  if (/\r|\n/.test(name) || /\r|\n/.test(val)) {
    return { kind: 'invalid', message: 'Header name and value cannot contain line breaks' }
  }
  if (seenNames.has(lower)) {
    return { kind: 'invalid', message: `Duplicate header: ${name}` }
  }

  seenNames.add(lower)
  return { kind: 'ready', name, value: val, credentialLike: CREDENTIAL_LIKE_NAMES.has(lower) }
}
