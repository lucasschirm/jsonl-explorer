/**
 * UrlDownloader — worker-owned fetch → spool orchestration.
 *
 * Streams a URL's response bytes into a `ByteSpool`, choosing the backend
 * up front (ADR-008):
 * - OPFS available → `OpfsSpool` (artifact removed on any failure path)
 * - OPFS unavailable, or declared size exceeds estimated quota →
 *   `PagedMemoryStore`
 *
 * The in-memory fallback is NEVER silent: when the response size is unknown
 * or larger than the consent threshold (default 100 MiB handover cap), the
 * caller's `onFallbackRequest` handshake must accept before a single byte
 * is buffered in RAM. A mid-stream OPFS quota failure disposes the partial
 * artifact, asks for consent, and re-fetches into paged memory.
 *
 * R12: `declaredBytes` (and indeterminate vs. determinate progress) only
 * count when the response declared a `Content-Length` WITHOUT content
 * encoding — compressed responses' wire length is not the decoded size.
 */

import { THRESHOLDS } from '../config/adr.js'

import { PagedMemoryStore } from './pagedStore.js'
import { OpfsSpool } from './opfsSpool.js'
import { estimateStorageQuota } from './quota.js'
import type { StorageEstimateProvider } from './quota.js'
import { createSpoolSessionName, randomId } from './session.js'
import { SpoolQuotaExceededError } from './spool.js'
import type { ByteSpool } from './spool.js'

/** Why an OPFS spool could not (or should not) be used. */
export type FallbackReason = 'opfs-unavailable' | 'opfs-quota-exceeded' | 'declared-size-over-quota'

export interface UrlFallbackInfo {
  reason: FallbackReason
  /** Decoded byte count from Content-Length, when meaningful (R12). */
  declaredBytes?: number
  /** Bytes already received when the fallback was triggered. */
  receivedBytes: number
}

export interface UrlProgressInfo {
  receivedBytes: number
  /** Present only for determinate (unencoded Content-Length) downloads. */
  totalBytes?: number
}

/** OPFS-like storage surface used by the downloader (injectable for tests). */
export interface OpfsStorageLike extends StorageEstimateProvider {
  getDirectory(): Promise<FileSystemDirectoryHandle>
}

export interface UrlDownloaderOptions {
  /** Extra request headers (e.g. Authorization). */
  headers?: Record<string, string>
  /** Aborts the fetch/stream; abort errors propagate to the caller. */
  signal?: AbortSignal
  /** Progress callback after each received chunk. */
  onProgress?: (progress: UrlProgressInfo) => void
  /**
   * Consent handshake for the in-memory fallback. When consent is required
   * and no callback is provided, the fallback is DECLINED (never silent).
   */
  onFallbackRequest?: (info: UrlFallbackInfo) => Promise<boolean>
  /** Injectable fetch implementation (tests). */
  fetchImpl?: typeof fetch
  /**
   * Injectable storage. `null` forces the memory fallback; omitted →
   * feature-detect `navigator.storage`.
   */
  storage?: OpfsStorageLike | null
  /** Page size for the memory fallback (default 256 KiB). */
  pageSizeBytes?: number
  /**
   * RAM size above which the fallback requires consent.
   * Defaults to `THRESHOLDS.maxHandoverPayloadBytes` (100 MiB).
   */
  fallbackConsentThresholdBytes?: number
}

/** Typed error: the fetch itself failed (network, HTTP status, DNS, ...). */
export class UrlFetchError extends Error {
  readonly code = 'URL_FETCH_FAILED' as const
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'UrlFetchError'
    this.status = status
  }
}

/** Typed error: the user (or a missing handshake) declined the RAM fallback. */
export class FallbackDeclinedError extends Error {
  readonly code = 'URL_FALLBACK_DECLINED' as const

  constructor(url: string) {
    super(`In-memory fallback for "${url}" was not accepted`)
    this.name = 'FallbackDeclinedError'
  }
}

export interface UrlDownloadResult {
  /** Sealed spool holding the full response bytes. */
  spool: ByteSpool
  /** Decoded byte count declared via Content-Length, when meaningful (R12). */
  declaredBytes?: bigint
  /** Display name derived from the URL. */
  name: string
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/** R12: Content-Length only equals decoded size when no content-encoding. */
function parseDeclaredBytes(headers: Headers): bigint | undefined {
  if (headers.get('content-encoding') !== null) return undefined
  const raw = headers.get('content-length')
  if (raw === null || !/^\d+$/.test(raw)) return undefined
  return BigInt(raw)
}

export function urlFileName(url: string): string {
  try {
    const name = new URL(url).pathname.split('/').filter(Boolean).pop()
    return name || 'remote.jsonl'
  } catch {
    return 'remote.jsonl'
  }
}

export class UrlDownloader {
  private readonly options: UrlDownloaderOptions
  private spool: ByteSpool | null = null

  constructor(options: UrlDownloaderOptions = {}) {
    this.options = options
  }

  /**
   * Fetches the URL and streams all bytes into a spool.
   * Resolves with a sealed spool; on any failure (including abort) the
   * partial artifact, if any, is removed before rethrowing.
   */
  async download(url: string): Promise<UrlDownloadResult> {
    const fetchImpl = this.options.fetchImpl ?? fetch
    const response0 = await this.fetchDocument(fetchImpl, url)
    const declaredBytes = parseDeclaredBytes(response0.headers)
    const name = urlFileName(url)
    let response = response0
    const spool0 = await this.pickInitialSpool(url, declaredBytes)
    let spool = spool0
    let quotaRetries = 0
    try {
      for (;;) {
        try {
          await this.streamBody(response, spool, declaredBytes)
          break
        } catch (error) {
          if (
            !(error instanceof SpoolQuotaExceededError) ||
            spool.kind !== 'opfs' ||
            quotaRetries >= 1
          ) {
            throw error
          }
          // OPFS quota exhausted mid-stream: drop the partial artifact,
          // consent, and re-fetch into paged memory. The spool's size is the
          // exact number of bytes already received (consent info, UI).
          const received = Number(await spool.getSize())
          quotaRetries++
          await spool.dispose()
          spool = await this.memoryFallback(url, 'opfs-quota-exceeded', declaredBytes, received)
          response = await this.fetchDocument(fetchImpl, url)
        }
      }
      await spool.seal()
      this.spool = spool
      return { spool, declaredBytes, name }
    } catch (error) {
      // Failure/abort path: never leave an app-owned artifact behind.
      await spool.dispose().catch(() => {})
      throw error
    }
  }

  /** Disposes the sealed spool, if any. Idempotent. */
  async dispose(): Promise<void> {
    const spool = this.spool
    this.spool = null
    if (spool) await spool.dispose()
  }

  private async fetchDocument(fetchImpl: typeof fetch, url: string): Promise<Response> {
    let response: Response
    try {
      response = await fetchImpl(url, {
        headers: this.options.headers,
        credentials: 'omit',
        signal: this.options.signal,
      })
    } catch (error) {
      if (isAbortError(error)) throw error
      const message = error instanceof Error ? error.message : String(error)
      throw new UrlFetchError(`Failed to fetch ${url}: ${message}`)
    }
    if (!response.ok) {
      throw new UrlFetchError(`HTTP ${response.status}${response.statusText ? `: ${response.statusText}` : ''}`, response.status)
    }
    return response
  }

  private async resolveStorage(): Promise<OpfsStorageLike | null> {
    if (this.options.storage === null) return null
    if (this.options.storage) return this.options.storage
    const storage = navigator.storage
    return storage && typeof storage.getDirectory === 'function' ? storage : null
  }

  private async pickInitialSpool(url: string, declaredBytes?: bigint): Promise<ByteSpool> {
    const storage = await this.resolveStorage()
    if (!storage) {
      return this.memoryFallback(url, 'opfs-unavailable', declaredBytes, 0)
    }
    try {
      const quota = await estimateStorageQuota(storage)
      if (declaredBytes !== undefined && quota !== null && declaredBytes > quota.availableBytes) {
        return this.memoryFallback(url, 'declared-size-over-quota', declaredBytes, 0)
      }
      const root = await storage.getDirectory()
      return await OpfsSpool.create(createSpoolSessionName(), { rootDirectory: root })
    } catch (error) {
      if (error instanceof FallbackDeclinedError) throw error
      // OPFS creation failed (directory access, ...): degrade to RAM.
      return this.memoryFallback(url, 'opfs-unavailable', declaredBytes, 0)
    }
  }

  private async memoryFallback(
    url: string,
    reason: FallbackReason,
    declaredBytes: bigint | undefined,
    receivedBytes: number,
  ): Promise<PagedMemoryStore> {
    const declared = declaredBytes === undefined ? undefined : Number(declaredBytes)
    const needsConsent = declared === undefined || declared > this.consentThreshold()
    if (needsConsent) {
      const accept = this.options.onFallbackRequest
        ? await this.options.onFallbackRequest({ reason, declaredBytes: declared, receivedBytes })
        : false
      if (!accept) throw new FallbackDeclinedError(url)
    }
    return new PagedMemoryStore({
      artifactName: `memory-${randomId()}`,
      pageSizeBytes: this.options.pageSizeBytes,
    })
  }

  private async streamBody(response: Response, spool: ByteSpool, declaredBytes: bigint | undefined): Promise<void> {
    const reader = response.body ? response.body.getReader() : null
    if (!reader) return
    const totalBytes =
      declaredBytes !== undefined && declaredBytes <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(declaredBytes)
        : undefined
    let receivedBytes = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      if (!value || value.length === 0) continue
      await spool.append(value)
      receivedBytes += value.length
      this.options.onProgress?.({ receivedBytes, totalBytes })
    }
  }

  private consentThreshold(): number {
    return this.options.fallbackConsentThresholdBytes ?? THRESHOLDS.maxHandoverPayloadBytes
  }
}
