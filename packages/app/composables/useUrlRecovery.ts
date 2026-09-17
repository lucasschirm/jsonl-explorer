/**
 * Memory-only handoff for a URL whose startup failed.
 *
 * PLAN 4.1: when "Open" fails (deep-link bootstrap or otherwise), the user
 * remains on / returns to the landing page *with the entered non-secret
 * URL* so they can retry. The value lives in a module-level ref — it is
 * never written to the router, localStorage, or any store, so no secret
 * material can enter routes or persistence.
 *
 * The composable is a singleton: all callers share the same pending value.
 */

import { ref, type Ref } from 'vue'

/** The normalized URL the user entered, or `null` when nothing to retry. */
const pendingUrl: Ref<string | null> = ref(null)

export interface UrlRecoveryApi {
  /** Records a URL for retry on the landing page. */
  setRecoveredUrl: (url: string) => void
  /**
   * Consumes the pending URL (returns and clears it). The landing page
   * calls this exactly once on mount; `null` means "nothing to recover".
   */
  consumeRecoveredUrl: () => string | null
  /** Test helper: clears any pending value without consuming it. */
  clearRecoveredUrl: () => void
}

export function useUrlRecovery(): UrlRecoveryApi {
  function setRecoveredUrl(url: string): void {
    pendingUrl.value = url
  }

  function consumeRecoveredUrl(): string | null {
    const value = pendingUrl.value
    pendingUrl.value = null
    return value
  }

  function clearRecoveredUrl(): void {
    pendingUrl.value = null
  }

  return { setRecoveredUrl, consumeRecoveredUrl, clearRecoveredUrl }
}
