/**
 * Byte spool storage for streamed URL data (ADR-008).
 */

export {
  SpoolDisposedError,
  SpoolQuotaExceededError,
  SpoolSealedError,
  SpoolSource,
} from './spool.js'
export type { ByteSpool, SpoolKind } from './spool.js'

export { PagedMemoryStore } from './pagedStore.js'
export type { PagedMemoryStoreOptions } from './pagedStore.js'

export { OpfsSpool } from './opfsSpool.js'
export type { OpfsSpoolOptions } from './opfsSpool.js'

export { estimateStorageQuota } from './quota.js'
export type { QuotaEstimate, StorageEstimateProvider } from './quota.js'

export {
  SPOOL_ARTIFACT_PREFIX,
  SPOOL_ARTIFACT_SUFFIX,
  cleanupStaleSpools,
  createSpoolSessionName,
  randomId,
} from './session.js'

export {
  FallbackDeclinedError,
  UrlDownloader,
  UrlFetchError,
  urlFileName,
} from './urlDownloader.js'
export type {
  FallbackReason,
  OpfsStorageLike,
  UrlDownloaderOptions,
  UrlDownloadResult,
  UrlFallbackInfo,
  UrlProgressInfo,
  UrlSpoolCreatedInfo,
} from './urlDownloader.js'

export {
  UrlCorsDeniedError,
  UrlInvalidHeadersError,
  UrlRedirectDeniedError,
  UrlValidationError,
  isCrossOrigin,
  redactUrl,
  sanitizeHeaders,
  validateHttpUrl,
} from '../url.js'
