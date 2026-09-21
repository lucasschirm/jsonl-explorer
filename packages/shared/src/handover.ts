/**
 * JSONL Explorer - Handover Protocol
 *
 * PostMessage-based protocol for loading JSONL data into the explorer
 * from a trusted opener (window.open parent or iframe parent).
 *
 * Version 1 - 2024
 */

export const HANDOVER_NAMESPACE = 'jsonl-explorer'
export const HANDOVER_VERSION = 1

/**
 * Maximum payload size for postMessage handover (100 MB).
 * Larger files should use URL-based loading or File API.
 */
export const HANDOVER_MAX_PAYLOAD_BYTES = 100 * 1024 * 1024

/**
 * Allowed origins for postMessage handover.
 * Configured at runtime via environment variable.
 * Defaults to same-origin only for security.
 */
export function getAllowedOrigins(allowedOrigins?: string): string[] {
  if (allowedOrigins) {
    return allowedOrigins.split(',').map((o: string) => o.trim()).filter(Boolean)
  }
  // Default: same-origin only (will be validated at runtime)
  return ['same-origin']
}

/**
 * Validates if an origin is allowed for handover.
 */
export function isOriginAllowed(origin: string, allowedOrigins?: string): boolean {
  const allowed = getAllowedOrigins(allowedOrigins)
  if (allowed.includes('same-origin')) {
    // same-origin will be checked against location.origin at runtime
    return true
  }
  return allowed.includes(origin)
}

/**
 * Message from Explorer to Opener: Explorer is ready to receive data
 */
export interface HandoverReadyMessage {
  ns: typeof HANDOVER_NAMESPACE
  v: typeof HANDOVER_VERSION
  type: 'ready'
}

/**
 * Message from Opener to Explorer: Load data into explorer
 */
export interface HandoverLoadMessage {
  ns: typeof HANDOVER_NAMESPACE
  v: typeof HANDOVER_VERSION
  type: 'load'
  name: string
  payload: string | ArrayBuffer
}

/**
 * Message from Explorer to Opener: Data loaded successfully
 */
export interface HandoverLoadedMessage {
  ns: typeof HANDOVER_NAMESPACE
  v: typeof HANDOVER_VERSION
  type: 'loaded'
  lines: number
}

/**
 * Message from Explorer to Opener: Error loading data
 */
export interface HandoverErrorMessage {
  ns: typeof HANDOVER_NAMESPACE
  v: typeof HANDOVER_VERSION
  type: 'error'
  message: string
}

/**
 * Union of all handover message types
 */
export type HandoverMessage =
  | HandoverReadyMessage
  | HandoverLoadMessage
  | HandoverLoadedMessage
  | HandoverErrorMessage

/**
 * Validates a handover message structure
 */
export function validateHandoverMessage(data: unknown): data is HandoverMessage {
  if (!data || typeof data !== 'object') return false
  const msg = data as Record<string, unknown>
  return (
    msg['ns'] === HANDOVER_NAMESPACE &&
    msg['v'] === HANDOVER_VERSION &&
    typeof msg['type'] === 'string'
  )
}

/**
 * Validates a load message specifically
 */
export function validateLoadMessage(data: unknown): data is HandoverLoadMessage {
  if (!validateHandoverMessage(data)) return false
  const msg = data as HandoverLoadMessage
  return (
    msg.type === 'load' &&
    typeof msg.name === 'string' &&
    msg.name.length > 0 &&
    (typeof msg.payload === 'string' || msg.payload instanceof ArrayBuffer)
  )
}

/**
 * Creates a ready message
 */
export function createReadyMessage(): HandoverReadyMessage {
  return { ns: HANDOVER_NAMESPACE, v: HANDOVER_VERSION, type: 'ready' }
}

/**
 * Creates a loaded message
 */
export function createLoadedMessage(lines: number): HandoverLoadedMessage {
  return { ns: HANDOVER_NAMESPACE, v: HANDOVER_VERSION, type: 'loaded', lines }
}

/**
 * Creates an error message
 */
export function createErrorMessage(message: string): HandoverErrorMessage {
  return { ns: HANDOVER_NAMESPACE, v: HANDOVER_VERSION, type: 'error', message }
}