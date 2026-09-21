<script setup lang="ts">
import ProgressBar from '~/components/ui/ProgressBar.vue'
import type { ProgressSlot } from '~/composables/useJsonlEngine'
import { formatBytes, formatInt } from '~/utils/format'

interface Props {
  /** Display name of the source being loaded (file/URL tail). */
  sourceName: string | null
  /** Download slot — present while a URL response is streaming. */
  download: ProgressSlot | null
  /** Index slot — present while rows are being committed (file scan or incremental URL indexing). */
  index: ProgressSlot | null
  /** Shows the cancel button when true. */
  cancellable?: boolean
}

withDefaults(defineProps<Props>(), { cancellable: false })

const emit = defineEmits<{ cancel: [] }>()

function slotPercentText(slot: ProgressSlot): string {
  return slot.percent === null ? '' : `${slot.percent}%`
}

function slotBytesText(slot: ProgressSlot): string {
  const base = formatBytes(slot.bytes)
  return slot.totalBytes !== null ? `${base} / ${formatBytes(slot.totalBytes)}` : base
}
</script>

<template>
  <!-- The parent gates visibility (v-if="isLoading"); the panel always
       offers cancel while cancellable, even before the first progress
       event arrives (a stalled download has no progress to show). -->
  <div role="status" aria-live="polite" class="w-full space-y-3">
    <div v-if="download" class="space-y-1">
      <div class="flex items-baseline justify-between gap-2 text-sm">
        <span class="font-medium text-base-content">Downloading {{ sourceName ?? 'file' }}</span>
        <span class="font-mono text-xs text-base-content/70 shrink-0">
          {{ slotBytesText(download) }}{{ slotPercentText(download) ? ` · ${slotPercentText(download)}` : '' }}
        </span>
      </div>
      <ProgressBar
        :value="download.percent ?? undefined"
        :indeterminate="download.percent === null"
        :show-value="false"
      />
    </div>

    <div v-if="index" class="space-y-1">
      <div class="flex items-baseline justify-between gap-2 text-sm">
        <span class="font-medium text-base-content">Indexing</span>
        <span class="font-mono text-xs text-base-content/70 shrink-0">
          {{ formatInt(index.rows ?? 0) }} rows{{ slotPercentText(index) ? ` · ${slotPercentText(index)}` : '' }}
        </span>
      </div>
      <ProgressBar
        :value="index.percent ?? undefined"
        :indeterminate="index.percent === null"
        :show-value="false"
      />
    </div>

    <button
      v-if="cancellable"
      type="button"
      class="btn btn-sm btn-outline btn-block"
      data-testid="loading-cancel"
      @click="emit('cancel')"
    >
      Cancel
    </button>
  </div>
</template>
