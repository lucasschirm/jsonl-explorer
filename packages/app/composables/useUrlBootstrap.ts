/**
 * JSONL Explorer - `?url=` bootstrap consumption (TSK0038)
 *
 * Works on ANY route: the CLI capability URL lands on `/`, the documented
 * deep link lands on `/explorer`.
 *
 * Contract:
 * - Scrub BEFORE the load: the parameter can carry a signed
 *   (credential-bearing) URL, so it leaves BOTH the address bar and the
 *   router state the moment it is validated — `router.replace` to the
 *   same path without the query (a history.replaceState under the hood,
 *   and the router's current location is updated with it, so the two can
 *   never desync). A large URL file loads for minutes; the query must
 *   not sit in the address bar meanwhile.
 * - Only the URL is supported from the query — never headers (secrets go
 *   through the modal, where they are validated and kept in memory only).
 * - Scheme is validated by `decideUrlInput` (http/https, no userinfo,
 *   no fragments).
 * - Valid: load, then land on /explorer (staying put when already there).
 * - Invalid: actionable toast + landing.
 * - Load failure: toast + the URL kept in memory ONLY (useUrlRecovery) so
 *   landing can prefill the modal for a one-click retry.
 * - Refresh behavior: everything is in-memory — a refresh after scrubbing
 *   loses the session (the explorer redirects to landing). Re-open the
 *   original `?url=` link to reload the same data.
 *
 * The no-referrer meta tag + Referrer-Policy header (R6) keep the URL out
 * of any outgoing referrer header while it still exists.
 */
import { useRoute, useRouter } from 'vue-router'
import { useFileStore } from '~/stores/file'
import { useToastStore } from '~/stores/toasts'
import { useUrlRecovery } from '~/composables/useUrlRecovery'
import { decideUrlInput } from '~/utils/urlIntake'

export function useUrlBootstrap(): {
  /**
   * Consume a pending `?url=` bootstrap, if any.
   * @returns true when a `?url=` bootstrap was present (handled or
   *   failed) so the caller's own mount logic — e.g. the explorer's
   *   empty-state guard — backs off.
   */
  consume(): Promise<boolean>
} {
  const route = useRoute()
  const router = useRouter()
  const fileStore = useFileStore()
  const toastStore = useToastStore()
  const recovery = useUrlRecovery()

  async function consume(): Promise<boolean> {
    const urlParam = route.query['url']
    if (!urlParam || typeof urlParam !== 'string') return false

    // route.query values are already decoded once by vue-router; a second
    // decode would corrupt URLs containing a literal '%'.
    const intake = decideUrlInput(urlParam)
    if (intake.kind !== 'ready') {
      if (intake.kind === 'invalid') {
        toastStore.error(intake.message, 'Invalid URL parameter')
      }
      await router.push('/')
      return true
    }

    // Scrub address bar AND router state before the (potentially long)
    // load: same path, query dropped.
    const path = route.path
    await router.replace(path)

    try {
      // The URL is NOT named in the toast (it can be signed); the
      // download window has no progress bar on these pages — the toast
      // is the acknowledgement that the bootstrap is working.
      toastStore.info('Loading data from URL…', 'URL load')
      await fileStore.loadFromUrl(intake.url)
      if (path !== '/explorer') await router.push('/explorer')
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to load from URL parameter'
      toastStore.error(message, 'URL load failed')
      recovery.setRecoveredUrl(intake.url)
      await router.push('/')
    }
    return true
  }

  return { consume }
}
