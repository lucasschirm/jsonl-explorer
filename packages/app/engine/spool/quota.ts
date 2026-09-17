/**
 * Storage quota estimation for pre-flight download decisions.
 *
 * Uses `navigator.storage.estimate()` (best effort). Returns `null` when the
 * API is unavailable or reports a zero quota, in which case callers treat
 * the quota as unknown (they may still try OPFS and handle quota errors at
 * write time).
 */

export interface QuotaEstimate {
  /** Currently used bytes for this origin. */
  usageBytes: bigint
  /** Total quota bytes for this origin. */
  quotaBytes: bigint
  /** `quotaBytes - usageBytes`, clamped at zero. */
  availableBytes: bigint
}

export interface StorageEstimateProvider {
  estimate(): Promise<{ usage?: number; quota?: number }>
}

/**
 * Estimates available storage.
 * @param storage A `StorageManager`-like provider (defaults to
 * `navigator.storage`); injectable for tests.
 */
export async function estimateStorageQuota(
  storage: StorageEstimateProvider | null | undefined = navigator.storage,
): Promise<QuotaEstimate | null> {
  if (!storage || typeof storage.estimate !== 'function') return null
  let usage = 0
  let quota = 0
  try {
    const result = await storage.estimate()
    usage = result.usage ?? 0
    quota = result.quota ?? 0
  } catch {
    return null
  }
  if (!Number.isFinite(usage) || !Number.isFinite(quota) || quota <= 0) return null
  const usageBytes = BigInt(Math.round(usage))
  const quotaBytes = BigInt(Math.round(quota))
  const availableBytes = quotaBytes - usageBytes > 0n ? quotaBytes - usageBytes : 0n
  return { usageBytes, quotaBytes, availableBytes }
}
