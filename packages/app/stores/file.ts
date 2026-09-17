import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { useJsonlEngine } from '~/composables/useJsonlEngine'
import { useSelectionStore } from '~/stores/selection'
import { useFilterStore } from '~/stores/filter'
import type { JsonlEngine } from '~/engine/index'

export interface FileMetadata {
  name: string
  size: number
  type: 'file' | 'url' | 'handover'
  url?: string
}

/**
 * File/source metadata store.
 *
 * Only scalars live here (name, size, type, URL string): the `File`
 * object, source bytes, and indexes stay in the worker and are reached
 * through the engine handle (`getEngine()`), never through reactive
 * state.
 */
export const useFileStore = defineStore('file', () => {
  const engineApi = useJsonlEngine()
  const metadata = ref<FileMetadata | null>(null)
  const loadError = ref<string | null>(null)

  // Reference-counted in the composable, so a rejected concurrent open does
  // not clear the flag while the in-flight open is still loading.
  const isLoading = computed(() => engineApi.loading.value)

  const hasFile = computed(() => metadata.value !== null)
  const fileName = computed(() => metadata.value?.name ?? '')
  const fileSize = computed(() => metadata.value?.size ?? 0)

  // A fatal worker error destroys the source with it: drop all derived UI
  // state immediately and leave only the fatal banner + reset path.
  watch(
    engineApi.fatal,
    (isFatal) => {
      if (!isFatal) return
      metadata.value = null
      resetDerivedState()
    },
    { immediate: true },
  )

  function trackError(error: unknown): void {
    loadError.value = error instanceof Error ? error.message : 'Failed to load source'
  }

  /** A new source invalidates every derived view (selection + filter). */
  function resetDerivedState(): void {
    useSelectionStore().resetSelection()
    useFilterStore().resetFilterState()
  }

  async function loadFile(file: File) {
    loadError.value = null
    try {
      const result = await engineApi.open('file', { file })
      metadata.value = { name: result.name, size: result.size, type: result.type }
      resetDerivedState()
    } catch (error) {
      trackError(error)
      throw error
    }
  }

  async function loadFromUrl(url: string, headers: Record<string, string> = {}) {
    loadError.value = null
    try {
      const result = await engineApi.open('url', { url, headers })
      metadata.value = { name: result.name, size: result.size, type: result.type, url }
      resetDerivedState()
    } catch (error) {
      trackError(error)
      throw error
    }
  }

  async function loadFromHandover(name: string, payload: string | ArrayBuffer) {
    loadError.value = null
    try {
      const result = await engineApi.open('handover', { name, payload })
      metadata.value = { name: result.name, size: result.size, type: result.type }
      resetDerivedState()
    } catch (error) {
      trackError(error)
      throw error
    }
  }

  /** Clears the source (worker-side) and all local metadata. */
  async function reset() {
    loadError.value = null
    await engineApi.closeSource()
    metadata.value = null
    resetDerivedState()
  }

  function getEngine(): JsonlEngine | null {
    return engineApi.engine.value
  }

  return {
    metadata,
    engine: computed(() => engineApi.engine.value),
    isLoading,
    loadError,
    hasFile,
    fileName,
    fileSize,
    loadFile,
    loadFromUrl,
    loadFromHandover,
    reset,
    getEngine,
  }
})
