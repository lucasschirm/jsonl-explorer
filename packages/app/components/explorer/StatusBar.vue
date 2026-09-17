<script setup lang="ts">
/**
 * Explorer status bar (TSK0023).
 *
 * Always-visible, fixed reporting: total/filtered row counts (agreement
 * with the worker snapshots) plus the current pipeline state — indexing
 * (with percent, paused/failed), filtering (with scanned/matched), and
 * the "partial" marker while the index is incomplete (the total is then
 * a lower bound that keeps growing as rows commit).
 */
import { computed } from 'vue'
import { useJsonlEngine } from '~/composables/useJsonlEngine'
import { useRowStore } from '~/stores/rows'
import { useFilterStore } from '~/stores/filter'
import { formatInt } from '~/utils/format'

const engineApi = useJsonlEngine()
const rowStore = useRowStore()
const filterStore = useFilterStore()

const totalRows = computed(() => engineApi.totalRows.value)
const filteredRows = computed(() => rowStore.totalFiltered)
/** Index incomplete: the total is a lower bound (rows keep committing). */
const indexPartial = computed(() => engineApi.indexState.value !== 'idle')

/** One-line pipeline state, highest priority first. */
const stateText = computed((): string | null => {
  if (filterStore.isRunning) {
    const p = filterStore.progress
    if (p) return `Filtering… ${formatInt(p.scannedRows)} scanned, ${formatInt(p.matchedRows)} matched`
    return 'Filtering…'
  }
  const state = engineApi.indexState.value
  if (state === 'running') {
    const p = engineApi.progress.value.index
    if (p !== null && p.percent !== null) return `Indexing… ${Math.round(p.percent)}%`
    return 'Indexing…'
  }
  if (state === 'cancelled') return 'Indexing paused'
  if (state === 'failed') return 'Indexing failed'
  return null
})
</script>

<template>
  <div class="p-3 border-t border-base-300 bg-base-200 text-xs text-base-content/70">
    <div class="flex items-center justify-between gap-2">
      <span>
        Total:
        <span class="font-mono" data-testid="total-count">{{ formatInt(totalRows) }}</span> rows
        <span v-if="indexPartial" class="text-base-content/50" data-testid="partial-marker"
          >(indexing)</span>
      </span>
      <span>
        Filtered:
        <span class="font-mono" data-testid="filtered-count">{{ formatInt(filteredRows) }}</span> rows
      </span>
      <span v-if="stateText" class="shrink-0 text-base-content/80" data-testid="state-text"
        :aria-live="stateText ? 'polite' : undefined">{{ stateText }}</span>
    </div>
  </div>
</template>
