import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { useJsonlEngine } from '~/composables/useJsonlEngine'
import { useRowStore } from '~/stores/rows'

/**
 * Selection store — which rows the user has picked, and which row is
 * active (detail panel + list highlight).
 *
 * Holds line ids only (small scalars in a Set); row text and other
 * payload data are fetched on demand through the engine and are never
 * stored here.
 *
 * Active-row transitions (TSK0023), keyed by the STABLE lineId so they
 * never drift with display indices:
 * - auto-select the first row once it is available (initial load, and
 *   after a transition that replaced the active row);
 * - when the view changes (filter, index commit), KEEP the active row if
 *   it is still in the view, otherwise REPLACE it with the first result,
 *   or CLEAR for zero results. "Still in the view" is answered by the
 *   worker (linePosition) — the main thread never guesses.
 */
export const useSelectionStore = defineStore('selection', () => {
  const rowStore = useRowStore()
  const engineApi = useJsonlEngine()

  const selected = ref<Set<number>>(new Set())
  /** The row shown in the detail panel (and highlighted in the list). */
  const activeLineId = ref<number | null>(null)
  /** Display index of the active row in the CURRENT view (null = not yet
   *  known; resolved from the row cache or the worker's answer). */
  const activeDisplayIndex = ref<number | null>(null)

  const count = computed(() => selected.value.size)
  const isEmpty = computed(() => selected.value.size === 0)

  function has(lineId: number): boolean {
    return selected.value.has(lineId)
  }

  /** Marks a row as active (detail panel + list highlight). Pass the
   *  display index when it is known (click); it is resolved otherwise. */
  function activate(lineId: number, displayIndex?: number | null): void {
    activeLineId.value = lineId
    activeDisplayIndex.value = displayIndex === undefined ? null : displayIndex
  }

  function toggle(lineId: number): void {
    if (selected.value.has(lineId)) {
      selected.value.delete(lineId)
    } else {
      selected.value.add(lineId)
    }
  }

  function add(lineId: number): void {
    selected.value.add(lineId)
  }

  function remove(lineId: number): void {
    selected.value.delete(lineId)
  }

  /** Selects every id in the inclusive range [from, to]. */
  function selectRange(from: number, to: number): void {
    const lo = Math.min(from, to)
    const hi = Math.max(from, to)
    for (let id = lo; id <= hi; id += 1) selected.value.add(id)
  }

  function set(ids: Iterable<number>): void {
    selected.value = new Set(ids)
  }

  function resetSelection(): void {
    selected.value = new Set()
    activeLineId.value = null
    activeDisplayIndex.value = null
  }

  // View changed (filter completion, index commit, source reset): decide
  // keep / replace-with-first / clear for the active row. The worker is
  // authoritative for "still matched".
  watch(
    [() => rowStore.generation, () => rowStore.totalFiltered],
    async () => {
      const id = activeLineId.value
      if (id === null) return // the cache watch auto-selects the first row
      const engine = engineApi.engine.value
      if (!engine) return
      const genAtRequest = rowStore.generation
      let position: { visible: boolean; displayIndex: number | null; generation: number }
      try {
        position = await engine.linePosition(id)
      } catch {
        return // worker failure/fatal owns the UI; never lose state on it
      }
      if (genAtRequest !== rowStore.generation || position.generation !== genAtRequest) {
        return // a newer view superseded this decision
      }
      if (position.visible) {
        activeDisplayIndex.value = position.displayIndex
        return
      }
      if (rowStore.totalFiltered > 0) {
        // Replace with the first result: the cache watch activates it as
        // soon as row 0 is back (the generation change cleared the cache).
        activeLineId.value = null
        activeDisplayIndex.value = 0
      } else {
        activeLineId.value = null
        activeDisplayIndex.value = null
      }
    },
  )

  // Row cache changes: (a) nothing active + rows available -> activate the
  // first row once it is cached; (b) active row's display index unknown ->
  // resolve it from the cache as soon as the row is.
  watch(
    () => rowStore.version,
    () => {
      if (activeLineId.value === null) {
        if (rowStore.totalFiltered > 0) {
          const first = rowStore.rowForDisplay(0)
          if (first) activate(first.lineId, 0)
        }
        return
      }
      if (activeDisplayIndex.value === null) {
        activeDisplayIndex.value = rowStore.displayIndexForLine(activeLineId.value)
      }
    },
  )

  return {
    selected,
    activeLineId,
    activeDisplayIndex,
    count,
    isEmpty,
    has,
    activate,
    toggle,
    add,
    remove,
    selectRange,
    set,
    resetSelection,
  }
})
