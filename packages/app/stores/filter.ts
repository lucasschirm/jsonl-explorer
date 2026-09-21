import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { useJsonlEngine } from '~/composables/useJsonlEngine'
import { EngineRpcError } from '~/engine/workerClient'
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
 * counts, generation, partiality) as scalars. Row pages are always fetched
 * on demand through the engine (`getRows`) and never cached here.
 *
 * Result lifecycle (R3 — a failed/cancelled filter must never leave a
 * half-replaced view):
 * - A successful RPC response sets `result`.
 * - `FILTER_CANCELLED` returns to idle and KEEPS the previous result.
 * - Any other failure sets `error` and keeps the previous result.
 * - Automatic completion reruns (worker-side, after indexing finishes)
 *   arrive as `filterComplete` events and upgrade a partial result to the
 *   final one; stale events (older generation) are ignored.
 */
export const useFilterStore = defineStore('filter', () => {
  const engineApi = useJsonlEngine()
  const kind = ref<FilterKind>('text')
  const query = ref('')
  const status = ref<FilterStatus>('idle')
  const error = ref<string | null>(null)
  const result = ref<FilterResult | null>(null)
  const progress = ref<{ scannedRows: number; matchedRows: number; totalRows: number } | null>(null)
  let unsubscribeProgress: (() => void) | null = null

  /**
   * The generation of the view the main thread currently sees — identity
   * OR filtered. The worker bumps its generation on index commits, filter
   * completion, and edits; every one of those arrives here (indexComplete
   * / filterComplete / editComplete events, or the RPC results), so this
   * scalar is the best-known view generation for generation-gated RPCs
   * (e.g. exportStart). A value that lags the worker's is safe: the
   * worker rejects it typed and tells us the current one in the error.
   */
  const viewGeneration = ref(0)

  const matchedRows = computed(() => result.value?.matchedRows ?? 0)
  const totalRows = computed(() => result.value?.totalRows ?? 0)
  const generation = computed(() => result.value?.generation ?? 0)
  const isRunning = computed(() => status.value === 'running')
  /** True while `result` covers only the committed snapshot (indexing live). */
  const isPartial = computed(() => result.value?.partial ?? false)
  /** Rows skipped by the current result (invalid JSON / jq runtime). */
  const errorCount = computed(() => result.value?.errorCount ?? 0)
  /** One-line summary of the first row error, if rows were skipped. */
  const errorSummary = computed(() => result.value?.errorSummary ?? null)
  /** True when a filter view is active (any result exists). */
  const hasActiveFilter = computed(() => result.value !== null)

  // Completion reruns have no RPC in flight: the worker emits
  // filterComplete after rerunning the latest query at index completion.
  // Edit re-evaluations (TSK0030) arrive as editComplete with the same
  // shape. Adopt only NEWER generations (generation is per-source;
  // resetFilterState clears result on source replacement, so there is no
  // cross-source comparison) and only while a filter view is active.
  // The subscription follows the engine instance: a recreated engine
  // (dispose + reopen) re-binds it, and a dropped engine unbinds it.
  let unsubscribeComplete: (() => void) | null = null
  watch(
    () => engineApi.engine.value,
    (engine) => {
      unsubscribeComplete?.()
      unsubscribeComplete = null
      if (!engine) return
      unsubscribeComplete = engine.onProgress((event) => {
        if (event.type === 'indexComplete') {
          // Every index commit bumps the generation, even with no filter
          // active: track it for generation-gated RPCs.
          if (event.generation > viewGeneration.value) viewGeneration.value = event.generation
          return
        }
        if (event.type !== 'filterComplete' && event.type !== 'editComplete') return
        if (event.type === 'editComplete' && result.value === null) return // identity view: nothing to update
        const current = result.value?.generation ?? 0
        if (event.generation <= current) return
        if (event.generation > viewGeneration.value) viewGeneration.value = event.generation
        result.value = {
          matchedRows: event.matchedRows,
          totalRows: event.totalRows,
          generation: event.generation,
          partial: event.partial,
          errorCount: event.errorCount,
          errorSummary: event.errorSummary,
        }
        if (status.value === 'running') {
          status.value = 'idle'
        }
      })
    },
    { immediate: true },
  )

  function trackProgressFor(operationId: string): void {
    unsubscribeProgress?.()
    unsubscribeProgress = engineApi.getEngine().onProgress((event) => {
      if (event.type === 'filterProgress' && event.operationId === operationId) {
        progress.value = {
          scannedRows: event.scannedRows,
          matchedRows: event.matchedRows,
          totalRows: event.totalRows,
        }
      }
    })
  }

  function stopTracking(): void {
    unsubscribeProgress?.()
    unsubscribeProgress = null
    progress.value = null
  }

  /**
   * Runs a filter and returns its result. A cancelled filter resolves to
   * the previous result (possibly null) with status back to idle — it is
   * not an error and never rethrows.
   */
  async function runFilter(newQuery: string, newKind: FilterKind): Promise<FilterResult | null> {
    kind.value = newKind
    query.value = newQuery
    status.value = 'running'
    error.value = null
    const operationId = nextFilterOperationId()
    trackProgressFor(operationId)
    try {
      const filterResult = await engineApi.getEngine().filter({ operationId, kind: newKind, query: newQuery })
      result.value = filterResult
      if (filterResult.generation > viewGeneration.value) viewGeneration.value = filterResult.generation
      status.value = 'idle'
      return filterResult
    } catch (err) {
      // A cancel is not an error: back to idle, previous result kept.
      if (err instanceof EngineRpcError && err.code === 'FILTER_CANCELLED') {
        status.value = 'idle'
        error.value = null
        return result.value
      }
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

  /**
   * Resets to the unfiltered (identity) view (TSK0028): the worker drops
   * its filter state and bumps the generation, so stale row caches
   * invalidate and selection transitions run deterministically.
   *
   * A no-op when no filter is active; the query is only cleared on
   * success so a failed clear keeps the last query for a retry.
   */
  async function clearFilter(): Promise<void> {
    if (status.value === 'running') return
    if (result.value === null) {
      query.value = ''
      return
    }
    status.value = 'running'
    error.value = null
    const operationId = nextFilterOperationId()
    try {
      const cleared = await engineApi.getEngine().clearFilter({ operationId })
      result.value = cleared
      if (cleared.generation > viewGeneration.value) viewGeneration.value = cleared.generation
      query.value = ''
      status.value = 'idle'
    } catch (err) {
      status.value = 'error'
      error.value = err instanceof Error ? err.message : 'Clear filter failed'
      throw err
    }
  }

  /** Drops stale filter state (called when the source changes). */
  function resetFilterState(): void {
    kind.value = 'text'
    query.value = ''
    status.value = 'idle'
    error.value = null
    result.value = null
    viewGeneration.value = 0
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
    isPartial,
    errorCount,
    errorSummary,
    hasActiveFilter,
    viewGeneration,
    runFilter,
    cancelFilter,
    clearFilter,
    resetFilterState,
  }
})
