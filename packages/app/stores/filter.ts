import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useJsonlEngine } from '~/composables/useJsonlEngine'
import type { FilterResult } from '@jsonl-explorer/shared'

export type FilterKind = 'text' | 'jq'
export type FilterStatus = 'idle' | 'running' | 'error'

let filterSeq = 0

function nextFilterOperationId(): string {
  filterSeq += 1
  return `filter-${filterSeq}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Filter state store.
 *
 * Tracks the active query and the worker's filter result (matched/total
 * counts, generation) as scalars. Row pages are always fetched on demand
 * through the engine (`getRows`) and never cached here.
 */
export const useFilterStore = defineStore('filter', () => {
  const engineApi = useJsonlEngine()
  const kind = ref<FilterKind>('text')
  const query = ref('')
  const status = ref<FilterStatus>('idle')
  const error = ref<string | null>(null)
  const result = ref<FilterResult | null>(null)
  const progress = ref<{ scannedRows: number; matchedRows: number } | null>(null)
  let unsubscribeProgress: (() => void) | null = null

  const matchedRows = computed(() => result.value?.matchedRows ?? 0)
  const totalRows = computed(() => result.value?.totalRows ?? 0)
  const generation = computed(() => result.value?.generation ?? 0)
  const isRunning = computed(() => status.value === 'running')

  function trackProgressFor(operationId: string): void {
    unsubscribeProgress?.()
    unsubscribeProgress = engineApi.getEngine().onProgress((event) => {
      if (event.type === 'filterProgress' && event.operationId === operationId) {
        progress.value = { scannedRows: event.scannedRows, matchedRows: event.matchedRows }
      }
    })
  }

  function stopTracking(): void {
    unsubscribeProgress?.()
    unsubscribeProgress = null
    progress.value = null
  }

  async function runFilter(newQuery: string, newKind: FilterKind): Promise<FilterResult> {
    kind.value = newKind
    query.value = newQuery
    status.value = 'running'
    error.value = null
    const operationId = nextFilterOperationId()
    trackProgressFor(operationId)
    try {
      const filterResult = await engineApi.getEngine().filter({ operationId, kind: newKind, query: newQuery })
      result.value = filterResult
      status.value = 'idle'
      return filterResult
    } catch (err) {
      status.value = 'error'
      error.value = err instanceof Error ? err.message : 'Filter failed'
      throw err
    } finally {
      stopTracking()
    }
  }

  async function cancelFilter(): Promise<void> {
    const engine = engineApi.engine.value
    if (engine && status.value === 'running') {
      await engine.cancel(engine.activeOperationId ?? '').catch(() => {})
    }
  }

  /** Drops stale filter state (called when the source changes). */
  function resetFilterState(): void {
    kind.value = 'text'
    query.value = ''
    status.value = 'idle'
    error.value = null
    result.value = null
    stopTracking()
  }

  return {
    kind,
    query,
    status,
    error,
    result,
    progress,
    matchedRows,
    totalRows,
    generation,
    isRunning,
    runFilter,
    cancelFilter,
    resetFilterState,
  }
})
