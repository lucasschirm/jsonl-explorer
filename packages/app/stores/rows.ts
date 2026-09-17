import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { useJsonlEngine } from '~/composables/useJsonlEngine'
import { useFilterStore } from '~/stores/filter'
import { ENGINE_DEFAULTS } from '~/engine/config/adr'
import { EngineRpcError } from '~/engine/workerClient'
import { ErrorCode, type RowData } from '@jsonl-explorer/shared'

// Module-level (not const) so tests can exercise eviction with small
// budgets; production always runs with the ENGINE_DEFAULTS values.
let maxBytes: number = ENGINE_DEFAULTS.rowCacheMaxBytes
let maxEntries: number = ENGINE_DEFAULTS.rowCacheMaxEntries
const textEncoder = new TextEncoder()
const byteLengthOf = (text: string): number => textEncoder.encode(text).length

/** TEST-ONLY: override the cache budgets (restored by resetRowStoreLimitsForTests). */
export function setRowCacheLimitsForTests(bytes: number, entries: number): void {
  maxBytes = bytes
  maxEntries = entries
}

/** TEST-ONLY: restore the default cache budgets. */
export function resetRowCacheLimitsForTests(): void {
  maxBytes = ENGINE_DEFAULTS.rowCacheMaxBytes
  maxEntries = ENGINE_DEFAULTS.rowCacheMaxEntries
}

/**
 * Row-window store (TSK0021).
 *
 * Owns the main-thread side of row access for the virtualized list:
 * - `ensureWindow(start, end)` coalesces overlapping/overscanned windows
 *   into a single in-flight getRows RPC (no duplicate windows, bounded
 *   messages while scrolling).
 * - Results are cached by (generation, lineId) under a BYTE budget with
 *   LRU eviction — never only by entry count (R12 memory).
 * - Stale responses (generation mismatch, e.g. a filter or index commit
 *   landed mid-flight) are NEVER applied; the store adopts the newer
 *   generation and re-fetches.
 * - `getFullText(lineId)` fetches the full (unescaped) row separately —
 *   list rows carry only the capped, escaped preview.
 *
 * Row data never enters any other store: only scalars (generation,
 * totalFiltered, error) are shared state.
 */
export const useRowStore = defineStore('rows', () => {
  const engineApi = useJsonlEngine()
  const filterStore = useFilterStore()

  /** Worker generation this cache corresponds to (worker is authoritative). */
  const generation = ref(0)
  const totalFiltered = ref(0)
  /** lineId -> row, insertion-ordered (oldest first) for LRU eviction. */
  const rows = ref<Map<number, RowData>>(new Map())
  /** Bumped on every insertion/eviction: the re-render signal for lists. */
  const version = ref(0)
  const loadError = ref<string | null>(null)

  // Non-reactive working state (never observed directly by the UI).
  const displayToLine = new Map<number, number>()
  const lineToDisplay = new Map<number, number>()
  const rowBytes = new Map<number, number>()
  let cachedBytes = 0
  const desired = { start: null as number | null, end: null as number | null }
  let loopRunning = false
  let unsubscribeIndexComplete: (() => void) | null = null

  const rowCount = computed(() => rows.value.size)

  /** Adopt a (different) worker generation: every cached window is stale. */
  function adoptGeneration(gen: number): void {
    if (gen === generation.value) return
    generation.value = gen
    clearCache()
  }

  function clearCache(): void {
    rows.value = new Map()
    displayToLine.clear()
    lineToDisplay.clear()
    rowBytes.clear()
    cachedBytes = 0
    desired.start = null
    desired.end = null
    version.value += 1
  }

  /** New source / fatal / reset: full reset, including the generation. */
  function reset(): void {
    generation.value = 0
    clearCache()
    totalFiltered.value = 0
    loadError.value = null
  }

  function rememberRow(row: RowData): void {
    if (rows.value.has(row.lineId)) {
      // Refresh: re-insert so LRU order moves it to the most-recent end.
      rows.value.delete(row.lineId)
      cachedBytes -= rowBytes.get(row.lineId) ?? 0
      rowBytes.delete(row.lineId)
    }
    rows.value.set(row.lineId, row)
    rowBytes.set(row.lineId, byteLengthOf(row.text))
    cachedBytes += rowBytes.get(row.lineId)!
    displayToLine.set(row.displayIndex, row.lineId)
    lineToDisplay.set(row.lineId, row.displayIndex)
  }

  /** LRU-evict oldest rows until under budget (on-screen rows are kept). */
  function evict(): void {
    let changed = false
    for (const lineId of [...rows.value.keys()]) {
      if (cachedBytes <= maxBytes && rows.value.size <= maxEntries) break
      const displayIndex = lineToDisplay.get(lineId)
      if (
        displayIndex !== undefined &&
        desired.start !== null &&
        desired.end !== null &&
        displayIndex >= desired.start &&
        displayIndex <= desired.end
      ) {
        continue // never evict what the virtualizer is asking for
      }
      rows.value.delete(lineId)
      if (displayIndex !== undefined) displayToLine.delete(displayIndex)
      lineToDisplay.delete(lineId)
      cachedBytes -= rowBytes.get(lineId) ?? 0
      rowBytes.delete(lineId)
      changed = true
    }
    if (changed) version.value += 1
  }

  /** Smallest span covering every missing display index (null when none). */
  function missingSpan(): { start: number; end: number } | null {
    if (desired.start === null || desired.end === null) return null
    let start = -1
    let end = -1
    const limit = Math.min(desired.end, desired.start + maxEntries - 1)
    for (let i = desired.start; i <= limit; i++) {
      if (!displayToLine.has(i)) {
        if (start === -1) start = i
        end = i
      }
    }
    return start === -1 ? null : { start, end }
  }

  /**
   * The single fetch loop: re-checks missing rows each iteration, so an
   * expanded window mid-flight is picked up and a stale response triggers
   * a clean re-fetch. Only one loop (and thus one in-flight RPC) exists.
   */
  async function fetchLoop(): Promise<void> {
    loopRunning = true
    try {
      while (true) {
        loadError.value = null
        const engine = engineApi.engine.value
        const span = missingSpan()
        if (!engine || span === null) break
        const requestGeneration = generation.value
        let result: { rows: RowData[]; generation: number; totalFiltered: number }
        try {
          result = await engine.getRows({
            start: span.start,
            count: span.end - span.start + 1,
            generation: requestGeneration,
          })
        } catch (error) {
          // A view change landed mid-fetch and the worker refused to send
          // a possibly-mixed window. Not an error state: re-fetch against
          // the current view (the generation watch has adopted it, or the
          // next response will carry it).
          if (error instanceof EngineRpcError && error.code === ErrorCode.STALE_GENERATION) {
            continue
          }
          loadError.value = error instanceof Error ? error.message : 'Failed to load rows'
          break
        }
        if (result.generation > generation.value) {
          // Data changed mid-flight (filter, edit, index commit). The
          // response carries the NEW state, so it is fresh: adopt the
          // newer generation and apply its rows (they describe that
          // generation's view).
          adoptGeneration(result.generation)
        } else if (result.generation < generation.value) {
          // STALE: an older generation than the current view (e.g. a reset
          // raced this in-flight request). Never apply it, never downgrade
          // — the next ensureWindow re-fetches for the current generation.
          break
        }
        // The view may be smaller than the window (e.g. a 3-row filter
        // result with a 50-row overscan): clamp so missingSpan() cannot
        // keep asking for rows past the end of the view.
        totalFiltered.value = result.totalFiltered
        if (desired.end !== null) {
          desired.end = Math.min(desired.end, result.totalFiltered - 1)
        }
        if (result.rows.length === 0) break
        for (const row of result.rows) rememberRow(row)
        evict()
        version.value += 1
        if (missingSpan() === null) break
      }
    } finally {
      loopRunning = false
      desired.start = null
      desired.end = null
    }
  }

  /**
   * Ensure the display range [start, end] is cached. Overlapping calls
   * (viewport + overscan, fast scrolls) widen the same window instead of
   * posting duplicate RPCs.
   */
  function ensureWindow(start: number, end: number): void {
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start < 0) return
    desired.start = desired.start === null ? start : Math.min(desired.start, start)
    desired.end = desired.end === null ? end : Math.max(desired.end, end)
    if (!loopRunning) void fetchLoop()
  }

  /** The cached row for a display index (null when not yet fetched).
   *  Note: displayToLine is a plain Map — callers that must re-render when
   *  a pending index gets a row should also read `version` (the re-render
   *  signal) in their own reactive scope. */
  function rowForDisplay(displayIndex: number): RowData | null {
    const lineId = displayToLine.get(displayIndex)
    if (lineId === undefined) return null
    return rows.value.get(lineId) ?? null
  }

  /** Display index of a cached line (null when not in the cache). Reads a
   *  plain Map — pair with `version` when used in a reactive scope. */
  function displayIndexForLine(lineId: number): number | null {
    const displayIndex = lineToDisplay.get(lineId)
    return displayIndex === undefined ? null : displayIndex
  }

  /**
   * Full, unescaped row text for the detail panel (fetched separately
   * from the capped list preview). Null when no source is loaded.
   */
  async function getFullText(
    lineId: number,
  ): Promise<{ lineId: number; text: string; isEdited: boolean } | null> {
    const engine = engineApi.engine.value
    if (!engine) return null
    return await engine.getLine(lineId)
  }

  // A new filter (or its reset) changes the display->line mapping: the
  // filter store's generation is the worker's, so follow it directly. A
  // completed filter also tells us the view size immediately (the filter
  // result carries matchedRows), so the list count never lags.
  watch(
    () => filterStore.generation,
    (gen) => {
      adoptGeneration(gen)
      if (gen > 0) {
        totalFiltered.value = filterStore.result?.matchedRows ?? 0
      }
    },
  )

  // Index commits bump the worker generation (new rows exist): invalidate
  // and adopt the committed row count from the event. Re-subscribe whenever
  // the engine instance changes (new worker).
  watch(
    () => engineApi.engine.value,
    (engine) => {
      unsubscribeIndexComplete?.()
      unsubscribeIndexComplete = null
      if (!engine) return
      unsubscribeIndexComplete = engine.onProgress((event) => {
        if (event.type === 'indexComplete') {
          adoptGeneration(event.generation)
          totalFiltered.value = event.totalRows
        }
      })
    },
    { immediate: true },
  )

  return {
    generation,
    totalFiltered,
    rows,
    rowCount,
    version,
    loadError,
    ensureWindow,
    rowForDisplay,
    displayIndexForLine,
    getFullText,
    reset,
  }
})
