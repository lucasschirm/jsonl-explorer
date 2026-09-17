/**
 * Wires main-thread engine lifecycle hooks (client only).
 *
 * `pagehide` disposes the worker so bfcache/unload never leaks a live
 * worker; the next startup reclaims any stale spool artifacts.
 */
import { wireEnginePageCleanup } from '~/composables/useJsonlEngine'

export default defineNuxtPlugin(() => {
  if (import.meta.client) {
    wireEnginePageCleanup()
  }
})
