/**
 * Browser save destinations (TSK0035).
 *
 * Two destinations, one pump:
 * - `fsaExport` — File System Access (Chrome/Edge): `showSaveFilePicker` →
 *   `createWritable` → stream chunks straight into the file. The whole
 *   output never sits in memory. `close()` commits on success; `abort()`
 *   DISCARDS a partial file on cancel or failure (a cancelled export must
 *   not leave a truncated file behind).
 * - `blobExport` — Firefox/Safari (TSK0001 support policy): accumulate
 *   chunks into a Blob, click a download anchor, revoke the object URL.
 *   The whole output sits in memory — the store gates this behind an
 *   explicit confirmation when the estimate exceeds the configured
 *   threshold.
 *
 * Both share `pumpExport` — the next → write → ack loop — so chunk
 * discipline (and the worker's backpressure gate) is implemented once.
 */
import type { ExportChunk, JsonlEngine } from '@jsonl-explorer/shared'

/** A started export (what exportStart returns minus the bookkeeping). */
export interface StartedExport {
  token: string
  totalRows: number
  estimatedBytes: number
}

export type ExportDestinationStatus = 'saved' | 'cancelled' | 'failed'

export interface ExportOutcome {
  status: ExportDestinationStatus
  /** Bytes actually written to the destination (0 when cancelled/failed). */
  bytes: number
  /** Human-readable message for failures (and picker-cancel details). */
  message?: string
}

export interface PumpCallbacks {
  /** Invoked per chunk BEFORE the ack — the writer for the destination. */
  onChunk: (chunk: ExportChunk) => Promise<void> | void
  /** Checked before every RPC: stop (without error) when true. */
  isCancelled: () => boolean
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Drives exportNext → onChunk → exportAck until the done chunk. Returns
 * the total bytes handed to `onChunk`.
 *
 * - Cancel: `isCancelled()` stops the loop and resolves (the CALLER
 *   issues exportCancel; the last chunk may be un-acked — the worker's
 *   cancel deletes the state either way).
 * - Failure (RPC or write): the error propagates; the previous chunk may
 *   be left un-acked and the worker state is cleaned by the caller's
 *   exportCancel.
 */
export async function pumpExport(engine: JsonlEngine, token: string, callbacks: PumpCallbacks): Promise<number> {
  let bytes = 0
  for (;;) {
    if (callbacks.isCancelled()) return bytes
    const chunk = await engine.exportNext(token)
    if (chunk.data.byteLength > 0) {
      await callbacks.onChunk(chunk)
      bytes += chunk.data.byteLength
    }
    await engine.exportAck(token)
    if (chunk.done) return bytes
  }
}

/** True when the browser can stream to a user-chosen file (Chrome/Edge). */
export function supportsFsa(): boolean {
  return typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function'
}

/**
 * Streams a STARTED export into a new file chosen by the user.
 *
 * Cleanup contract (acceptance: handles cleaned on success/error/cancel):
 * - success → `writable.close()` (commits the file);
 * - cancel or failure → `writable.abort()` (discards the partial file);
 * - picker closed by the user → `cancelled`, no writable was created.
 *
 * @param suggestedName the pre-filled file name (the user may rename).
 * @param onProgress optional per-chunk hook (progress UI); runs before the ack.
 */
export async function fsaExport(
  engine: JsonlEngine,
  started: StartedExport,
  suggestedName: string,
  isCancelled: () => boolean,
  onProgress?: (chunk: ExportChunk) => void,
): Promise<ExportOutcome> {
  const picker = window.showSaveFilePicker
  if (!picker) {
    return { status: 'failed', bytes: 0, message: 'File System Access is not supported in this browser.' }
  }

  let handle: FileSystemFileHandle
  try {
    handle = await picker({
      suggestedName,
      types: [{ description: 'JSON Lines', accept: { 'application/x-ndjson': ['.jsonl'] } }],
    })
  } catch (error) {
    // The user closed the picker: a plain cancel, not an error.
    return { status: 'cancelled', bytes: 0, message: errorMessage(error) }
  }

  let writable: FileSystemWritableFileStream
  try {
    writable = await handle.createWritable()
  } catch (error) {
    return { status: 'failed', bytes: 0, message: `Could not open the file for writing: ${errorMessage(error)}` }
  }

  let settled = false
  try {
    const bytes = await pumpExport(engine, started.token, {
      isCancelled,
      // Cloned worker bytes always back a real ArrayBuffer; the protocol
      // type is the looser ArrayBufferLike variant.
      onChunk: (chunk) => {
        onProgress?.(chunk)
        return writable.write(chunk.data as Uint8Array<ArrayBuffer>)
      },
    })
    if (isCancelled()) {
      await writable.abort() // discard the partial file
      settled = true
      return { status: 'cancelled', bytes: 0 }
    }
    await writable.close() // commit the complete file
    settled = true
    return { status: 'saved', bytes }
  } catch (error) {
    if (!settled) {
      try {
        await writable.abort() // discard the partial file
      } catch {
        // Best effort: the handle is unusable; nothing else to clean.
      }
    }
    if (isCancelled()) return { status: 'cancelled', bytes: 0 }
    return { status: 'failed', bytes: 0, message: `Export failed while writing the file: ${errorMessage(error)}` }
  }
}

/**
 * How long after the anchor click the object URL stays alive. The browser
 * has queued the download by the time click() returns, but the fetch of
 * the object URL may start a tick later in some engines — revoking
 * immediately can race it, so a short delay keeps the download safe while
 * still releasing the Blob promptly.
 */
const REVOKE_DELAY_MS = 1000

/**
 * Downloads a STARTED export as a Blob (Firefox/Safari fallback).
 *
 * Cleanup contract: the object URL is ALWAYS revoked — on success (after
 * the anchor click), on cancel (before the Blob is built), and on failure.
 *
 * @param fileName the download file name (always a `.jsonl` name).
 * @param onProgress optional per-chunk hook (progress UI); runs before the ack.
 */
export async function blobExport(
  engine: JsonlEngine,
  started: StartedExport,
  fileName: string,
  isCancelled: () => boolean,
  onProgress?: (chunk: ExportChunk) => void,
): Promise<ExportOutcome> {
  const parts: Uint8Array[] = []
  try {
    const bytes = await pumpExport(engine, started.token, {
      isCancelled,
      onChunk: (chunk) => {
        onProgress?.(chunk)
        parts.push(chunk.data)
      },
    })
    if (isCancelled()) {
      parts.length = 0
      return { status: 'cancelled', bytes: 0 }
    }
    const blob = new Blob(parts as BlobPart[], { type: 'application/x-ndjson' })
    const url = URL.createObjectURL(blob)
    try {
      triggerAnchorDownload(url, fileName)
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS)
    }
    return { status: 'saved', bytes }
  } catch (error) {
    parts.length = 0
    if (isCancelled()) return { status: 'cancelled', bytes: 0 }
    return { status: 'failed', bytes: 0, message: `Export failed: ${errorMessage(error)}` }
  }
}

function triggerAnchorDownload(url: string, fileName: string): void {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}
