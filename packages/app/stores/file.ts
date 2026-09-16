import { defineStore } from 'pinia'
import { ref, computed, shallowRef } from 'vue'
import type { JsonlEngine } from '~/engine/index'
import { createJsonlEngine } from '~/engine/index'

export interface FileMetadata {
  name: string
  size: number
  type: 'file' | 'url' | 'handover'
  url?: string
}

export const useFileStore = defineStore('file', () => {
  const metadata = ref<FileMetadata | null>(null)
  const engine = shallowRef<JsonlEngine | null>(null)
  const isLoading = ref(false)
  const loadError = ref<string | null>(null)

  const hasFile = computed(() => metadata.value !== null)
  const fileName = computed(() => metadata.value?.name ?? '')
  const fileSize = computed(() => metadata.value?.size ?? 0)

  async function loadFile(file: File) {
    isLoading.value = true
    loadError.value = null

    try {
      const newEngine = createJsonlEngine()
      await newEngine.initFile(file)

      engine.value = newEngine
      metadata.value = {
        name: file.name,
        size: file.size,
        type: 'file',
      }
    } catch (error) {
      loadError.value = error instanceof Error ? error.message : 'Failed to load file'
      throw error
    } finally {
      isLoading.value = false
    }
  }

  async function loadFromUrl(url: string, headers: Record<string, string> = {}) {
    isLoading.value = true
    loadError.value = null

    try {
      const newEngine = createJsonlEngine()
      await newEngine.initUrl(url, headers)

      engine.value = newEngine
      metadata.value = {
        name: new URL(url).pathname.split('/').pop() || 'remote.jsonl',
        size: 0, // Unknown until indexed
        type: 'url',
        url,
      }
    } catch (error) {
      loadError.value = error instanceof Error ? error.message : 'Failed to load from URL'
      throw error
    } finally {
      isLoading.value = false
    }
  }

  async function loadFromHandover(name: string, payload: string | ArrayBuffer) {
    isLoading.value = true
    loadError.value = null

    try {
      const newEngine = createJsonlEngine()
      await newEngine.initMemory(name, payload)

      engine.value = newEngine
      metadata.value = {
        name,
        size: payload instanceof ArrayBuffer ? payload.byteLength : new TextEncoder().encode(payload).length,
        type: 'handover',
      }
    } catch (error) {
      loadError.value = error instanceof Error ? error.message : 'Failed to load from handover'
      throw error
    } finally {
      isLoading.value = false
    }
  }

  function reset() {
    if (engine.value) {
      engine.value.dispose()
      engine.value = null
    }
    metadata.value = null
    loadError.value = null
  }

  function getEngine(): JsonlEngine | null {
    return engine.value
  }

  return {
    metadata,
    engine: computed(() => engine.value),
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