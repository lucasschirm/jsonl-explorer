<script setup lang="ts">
/**
 * Filter bar (TSK0028): whole-file replace filtering for literal text and
 * jq, in the left panel of the explorer.
 *
 * Contract (PLAN 4.x / task TSK0028):
 * - A filter runs ONLY on an explicit action: Enter in the input or a
 *   click on the run button. Typing never filters (no `watch` on the
 *   draft, no debounce) — the previous view is kept until a run completes.
 * - An empty query on run clears the filter: the store resets to the
 *   unfiltered (identity) view.
 * - The jq program is compiled once per operation by the worker; compile
 *   failures reject the RPC, keep the previous result, and surface as one
 *   actionable toast with the jq error message.
 * - Per-row errors (invalid JSON / jq runtime) never fail the operation:
 *   the scan skips them, counts them, and the ONE summary (count + first
 *   error) is shown once — never a toast per row.
 * - Progress is reported (rows scanned/matched) with a cancel button;
 *   a partial result (indexing still running) is labeled and upgrades
 *   automatically when the worker reruns the query at index completion.
 */
import { computed, ref } from 'vue'
import { useFilterStore } from '~/stores/filter'
import { useToastStore } from '~/stores/toasts'
import { formatInt } from '~/utils/format'
import ProgressBar from '~/components/ui/ProgressBar.vue'

const filterStore = useFilterStore()
const toastStore = useToastStore()

/** Local draft: what the user has typed. The store's `query` is the last
 *  RUN query — the two only agree after a successful run. */
const draft = ref(filterStore.query)

/** Runs the draft (or clears it when empty). Explicit action only. */
async function run(): Promise<void> {
  if (filterStore.isRunning) return
  const query = draft.value.trim()
  if (query === '') {
    await clear()
    return
  }
  try {
    const result = await filterStore.runFilter(query, filterStore.kind)
    // One summary for all skipped rows — never one toast per row.
    if (result && result.errorCount && result.errorCount > 0) {
      const detail = result.errorSummary ? ` First: ${result.errorSummary}` : ''
      toastStore.info(
        `${formatInt(result.errorCount)} rows skipped (invalid JSON or jq error).${detail}`,
        'Filter',
      )
    }
  } catch (err) {
    // runFilter rethrows non-cancel failures (e.g. FILTER_FAILED with the
    // jq syntax error). The previous result is already kept by the store.
    const message = err instanceof Error ? err.message : 'Filter failed'
    toastStore.error(message, 'Filter failed')
  }
}

/** Resets to the unfiltered view (TSK0028). */
async function clear(): Promise<void> {
  if (filterStore.isRunning) return
  draft.value = ''
  try {
    await filterStore.clearFilter()
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Clear filter failed'
    toastStore.error(message, 'Clear filter failed')
  }
}

function cancel(): void {
  void filterStore.cancelFilter()
}

/** Progress denominator: the scan's own total (committed at scan start). */
const progressTotal = computed(() => filterStore.progress?.totalRows ?? 0)
const progressValue = computed(() => filterStore.progress?.scannedRows ?? 0)

/** "N of M rows" for the active result (0 matches included). */
const resultText = computed(() => {
  if (filterStore.result === null) return null
  return `${formatInt(filterStore.matchedRows)} of ${formatInt(filterStore.totalRows)} rows`
})

const placeholder = computed(() =>
  filterStore.kind === 'jq' ? 'jq program, e.g. .status == "error"' : 'substring to find…',
)
</script>

<template>
  <div class="p-3 border-b border-base-300 bg-base-200 flex flex-col gap-2" data-testid="filter-bar">
    <!-- Mode + input: the mode is an explicit choice, never inferred. -->
    <div class="flex items-center gap-2">
      <div class="join" role="group" aria-label="Filter mode">
        <button
          type="button"
          class="join-item btn btn-sm"
          :class="filterStore.kind === 'text' ? 'btn-primary' : 'btn-ghost'"
          data-testid="filter-kind-text"
          :disabled="filterStore.isRunning"
          @click="filterStore.kind = 'text'"
        >
          Text
        </button>
        <button
          type="button"
          class="join-item btn btn-sm"
          :class="filterStore.kind === 'jq' ? 'btn-primary' : 'btn-ghost'"
          data-testid="filter-kind-jq"
          :disabled="filterStore.isRunning"
          @click="filterStore.kind = 'jq'"
        >
          jq
        </button>
      </div>
      <input
        v-model="draft"
        type="text"
        class="input input-bordered input-sm flex-1"
        :placeholder="placeholder"
        data-testid="filter-input"
        :disabled="filterStore.isRunning"
        @keyup.enter="run"
        @keyup.esc="clear"
      />
      <button
        type="button"
        class="btn btn-primary btn-sm"
        data-testid="filter-run"
        :disabled="filterStore.isRunning"
        title="Filter (Enter)"
        @click="run"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
      </button>
      <button
        type="button"
        class="btn btn-ghost btn-sm"
        data-testid="filter-clear"
        :disabled="filterStore.isRunning || (filterStore.result === null && draft === '')"
        title="Clear filter (Esc)"
        @click="clear"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>

    <!-- Running: progress + cancel (R3). -->
    <div v-if="filterStore.isRunning" data-testid="filter-progress">
      <ProgressBar
        :value="progressTotal > 0 ? progressValue : undefined"
        :indeterminate="progressTotal === 0"
        :label="`Filtering… ${formatInt(progressValue)} scanned`"
        show-value
      />
      <div class="flex justify-end mt-1">
        <button
          type="button"
          class="btn btn-ghost btn-xs"
          data-testid="filter-cancel"
          @click="cancel"
        >
          Cancel
        </button>
      </div>
    </div>

    <!-- Result line: counts + skipped summary + partial marker. -->
    <div
      v-else-if="resultText !== null"
      class="flex items-center gap-2 text-xs text-base-content/70"
      data-testid="filter-result"
    >
      <span>{{ resultText }}</span>
      <span v-if="filterStore.errorCount > 0" data-testid="filter-skipped">
        · {{ formatInt(filterStore.errorCount) }} skipped
      </span>
      <span v-if="filterStore.isPartial" class="text-base-content/50" data-testid="filter-partial"
        >(indexing — will update)</span>
    </div>

    <!-- Last failure, kept visible until the next run (the toast is the
         actionable one; this is the persistent state). -->
    <p v-if="filterStore.status === 'error' && filterStore.error" role="alert" class="text-xs text-error" data-testid="filter-error">
      {{ filterStore.error }}
    </p>
  </div>
</template>
