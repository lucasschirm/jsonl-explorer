import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

/**
 * Selection store — which rows the user has picked.
 *
 * Holds line ids only (small scalars in a Set); row text and other
 * payload data are fetched on demand through the engine and are never
 * stored here.
 */
export const useSelectionStore = defineStore('selection', () => {
  const selected = ref<Set<number>>(new Set())

  const count = computed(() => selected.value.size)
  const isEmpty = computed(() => selected.value.size === 0)

  function has(lineId: number): boolean {
    return selected.value.has(lineId)
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
  }

  return {
    selected,
    count,
    isEmpty,
    has,
    toggle,
    add,
    remove,
    selectRange,
    set,
    resetSelection,
  }
})
