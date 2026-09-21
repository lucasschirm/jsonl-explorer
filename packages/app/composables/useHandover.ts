/**
 * JSONL Explorer - Handover handshake (TSK0037)
 *
 * The explorer side of the postMessage protocol (docs: embedding-handover):
 *
 *   host  -> explorer : { ns, v, type: 'load', name, payload }
 *   explorer -> host  : { ns, v, type: 'ready' }            (after mount, no data)
 *   explorer -> host  : { ns, v, type: 'loaded', lines }    (after the index commits)
 *   explorer -> host  : { ns, v, type: 'error', message }   (load or index failure)
 *
 * Trust boundary (utils/handover.ts): a load is accepted only from the
 * host window (opener or parent) with an origin on the exact allowlist.
 *
 * Behavior contract:
 * - The listener is installed BEFORE `ready` is posted (a fast host may
 *   post `load` the instant it sees `ready`).
 * - One session per page visit: the first SUCCESSFUL load takes ownership
 *   for good; further loads (even after completion) are ignored silently
 *   (an error reply would make a well-meaning retry look like a
 *   failure). A FAILED load takes no ownership, so the host may retry
 *   within the window.
 * - `load` must arrive within `readyTimeoutMs` (30 s) of `ready`; after
 *   the timeout the receiver is disarmed and the page stays usable
 *   (drop zone) — the host times out on its side.
 * - `loaded` is an ASYNC completion notice: it carries the row count,
 *   which only exists once the background index commits. Hosts should
 *   treat `load` as the handshake ack and not block on `loaded`.
 * - A load that fails (worker rejection) replies `error`; the receiver
 *   stays armed so the host can retry within the timeout window.
 */
import { onScopeDispose, ref, watch, type Ref } from 'vue'
import {
  createErrorMessage,
  createLoadedMessage,
  createReadyMessage,
  validateHandoverMessage,
  type HandoverLoadMessage,
  type HandoverMessage,
} from '@jsonl-explorer/shared'
import { useFileStore } from '~/stores/file'
import { useJsonlEngine } from '~/composables/useJsonlEngine'
import {
  HANDOVER_READY_TIMEOUT_MS,
  fitsPayloadLimit,
  isTrustedLoadEvent,
  resolveAllowedOrigins,
  resolveHostWindow,
} from '~/utils/handover'
import { THRESHOLDS } from '~/engine/config/adr'

export interface HandoverOptions {
  /** Raw allowlist (env value); default: runtime config or 'same-origin'. */
  allowedOrigins?: string
  /** Payload cap in bytes; default: runtime config or 100 MiB. */
  maxPayloadBytes?: number
  /** Handshake budget; default: 30 s. */
  readyTimeoutMs?: number
}

/**
 * Runtime config with safe fallbacks: `import.meta.client` only exists in
 * the Nuxt bundle; unit tests get the documented defaults.
 */
function getHandoverConfig(): { allowedOrigins: string; maxPayloadBytes: number } {
  const runtime = (
    import.meta as unknown as {
      client?: { $config?: { public?: Record<string, unknown> } }
    }
  ).client?.$config?.public
  const origins = runtime?.['handoverAllowedOrigins']
  const maxPayload = runtime?.['maxHandoverPayloadBytes']
  return {
    allowedOrigins: typeof origins === 'string' ? origins : 'same-origin',
    maxPayloadBytes: typeof maxPayload === 'number' ? maxPayload : THRESHOLDS.maxHandoverPayloadBytes,
  }
}

export function useHandover(options: HandoverOptions = {}): {
  /** True while waiting for the host's `load` (drives the wait banner). */
  waiting: Ref<boolean>
  /** Start the handshake. False when standalone (no host window). */
  start(): boolean
  /** Disarm the receiver (timeout, manual file load, unmount). */
  dispose(): void
} {
  const fileStore = useFileStore()
  const engineApi = useJsonlEngine()
  const waiting = ref(false)

  const config = getHandoverConfig()
  let host: Window | null = null
  let allowedOrigins: string[] = []
  let acceptedName: string | null = null // in-flight load (drives the reply)
  let acceptedOrigin: string | null = null
  let ownershipTaken = false // settled session (survives the reply)
  let listenerInstalled = false
  let timer: ReturnType<typeof setTimeout> | null = null

  function reply(message: HandoverMessage, origin: string): void {
    if (!host) return
    host.postMessage(message, origin)
  }

  function removeListener(): void {
    if (!listenerInstalled) return
    window.removeEventListener('message', onMessage)
    listenerInstalled = false
  }

  function onMessage(event: MessageEvent): void {
    if (!validateHandoverMessage(event.data)) return
    const data = event.data as HandoverMessage
    if (data.type !== 'load') return
    // Trust boundary: exact origin AND exact host window identity.
    if (!isTrustedLoadEvent(event, host, allowedOrigins)) return
    // Ownership: a load already in flight, or a session already settled,
    // wins — duplicates are ignored (in flight: the first load owns the
    // engine; settled: the file is already showing, re-loading it would
    // be surprising and would race the user's own session).
    if (acceptedName !== null || ownershipTaken) return
    // Malformed per the shared contract (empty name, wrong payload type):
    // validateLoadMessage already required a usable shape for the type
    // guard above to be meaningful — enforce it here, at the boundary.
    if (typeof data.name !== 'string' || data.name.length === 0) return
    // Boundary hardening: a `load` with a non string/ArrayBuffer payload
    // (e.g. a nested object) is malformed — ignore it. (TextEncoder would
    // otherwise happily encode the string "undefined".)
    if (typeof data.payload !== 'string' && !(data.payload instanceof ArrayBuffer)) return
    const maxBytes = options.maxPayloadBytes ?? config.maxPayloadBytes
    if (!fitsPayloadLimit(data.payload, maxBytes)) {
      reply(
        createErrorMessage(
          `Handover payload exceeds the ${Math.round(maxBytes / (1024 * 1024))} MiB limit; ` +
            'use URL loading for larger files.',
        ),
        event.origin,
      )
      return
    }
    acceptedName = data.name
    acceptedOrigin = event.origin
    waiting.value = false
    void acceptLoad(data, event.origin)
  }

  async function acceptLoad(data: HandoverLoadMessage, origin: string): Promise<void> {
    try {
      await fileStore.loadFromHandover(data.name, data.payload)
      // Ownership is settled: the timeout no longer disarms the reply
      // path, and no further load from the host is ever accepted.
      ownershipTaken = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      // `loaded` is sent by the index-state watch, once the row count exists.
    } catch (error) {
      // Reply and stay armed: the host may retry within the window.
      reply(
        createErrorMessage(
          error instanceof Error ? error.message : 'Handover load failed',
        ),
        origin,
      )
      acceptedName = null
      acceptedOrigin = null
    }
  }

  function onTimeout(): void {
    waiting.value = false
    removeListener()
  }

  function start(): boolean {
    if (waiting.value || acceptedName !== null) return false
    host = resolveHostWindow(window, window)
    if (!host) return false
    allowedOrigins = resolveAllowedOrigins(
      options.allowedOrigins ?? config.allowedOrigins,
      location.origin,
    )
    // Listener FIRST: a fast host may post `load` immediately on `ready`;
    // installing before posting guarantees no message is lost.
    window.addEventListener('message', onMessage)
    listenerInstalled = true
    // `ready` carries no data; it goes to each exact allowed origin
    // (never a wildcard).
    for (const origin of allowedOrigins) reply(createReadyMessage(), origin)
    waiting.value = true
    timer = setTimeout(onTimeout, options.readyTimeoutMs ?? HANDOVER_READY_TIMEOUT_MS)
    return true
  }

  function dispose(): void {
    waiting.value = false
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    removeListener()
  }

  // `loaded`/`error` completion: the accepted load's background index
  // commits the row count. A replaced source (user uploaded another file,
  // fatal) drops the pending reply silently — its host already sees a
  // different file (or a dead worker) in the explorer.
  watch(
    () => engineApi.indexState.value,
    (state) => {
      if (acceptedName === null) return
      // Only terminal states decide the reply: 'running'/'cancelled'
      // carry no verdict. (Checking metadata before the accepted load's
      // open() has settled would see the pre-load state and mis-fire.)
      if (state !== 'idle' && state !== 'failed') return
      // Replacement race: a stale index rejection lands while the NEW
      // source is still initializing — not the accepted load completing.
      if (engineApi.loading.value) return
      if (fileStore.metadata?.name !== acceptedName) {
        // The source was replaced (manual load, fatal): drop the reply.
        acceptedName = null
        acceptedOrigin = null
        return
      }
      if (state === 'failed') {
        reply(
          createErrorMessage(
            `Handover load failed indexing: ${engineApi.indexError.value ?? 'unknown error'}`,
          ),
          acceptedOrigin ?? location.origin,
        )
        acceptedName = null
        acceptedOrigin = null
      } else if (state === 'idle') {
        reply(createLoadedMessage(engineApi.totalRows.value), acceptedOrigin ?? location.origin)
        acceptedName = null
        acceptedOrigin = null
      }
    },
  )

  // A file that arrives by ANY other means (manual drop/pick) ends the
  // wait: the host's session is over. Our own load is recognized by the
  // already-set acceptedName.
  // NB: setup-store refs are unwrapped on the store instance —
  // `fileStore.hasFile` is the boolean (no `.value`).
  watch(
    () => fileStore.hasFile,
    (hasFile) => {
      if (hasFile && acceptedName === null) dispose()
    },
  )

  onScopeDispose(dispose)

  return { waiting, start, dispose }
}
