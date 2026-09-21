<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { useExporterStore } from '~/stores/exporter'
import { formatBytes } from '~/utils/format'

/**
 * Export progress strip (TSK0035): shown while an export runs, under the
 * indexing strip. Filename, row/byte progress, and Cancel. The worker's
 * ACK-gate keeps the pipeline bounded; cancelling releases the worker's
 * export state (and the edit lock) immediately.
 */
const exporterStore = useExporterStore()
const { fileName, progress, progressPercent, destination } = storeToRefs(exporterStore)

async function onCancel() {
  await exporterStore.cancel()
}
</script>

<template>
  <div
    data-testid="export-status"
    class="px-4 py-2 border-b border-base-300 bg-base-200 flex items-center gap-3 text-sm"
    role="status"
    aria-live="polite"
  >
    <span class="font-medium shrink-0" data-testid="export-status-name">
      {{ destination === 'fsa' ? 'Saving' : 'Preparing download' }}: {{ fileName }}
    </span>
    <div class="flex-1 max-w-xs">
      <ProgressBar :value="progressPercent" :max="100" />
    </div>
    <span class="text-base-content/80 tabular-nums shrink-0" data-testid="export-status-progress">
      {{ progress ? `${progress.rows.toLocaleString()} / ${progress.totalRows.toLocaleString()} rows` : '…' }}
      <template v-if="progress && progress.bytes > 0"> · {{ formatBytes(progress.bytes) }}</template>
    </span>
    <button
      class="btn btn-ghost btn-sm shrink-0"
      data-testid="export-cancel-btn"
      @click="onCancel"
    >
      Cancel
    </button>
  </div>
</template>
