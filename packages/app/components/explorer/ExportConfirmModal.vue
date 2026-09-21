<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { useExporterStore } from '~/stores/exporter'
import { ENGINE_DEFAULTS } from '~/engine/config/adr'
import { formatBytes } from '~/utils/format'

/**
 * Blob-fallback confirmation (TSK0035): the estimate exceeded
 * `exportBlobConfirmBytes`, so the whole export will sit in memory as a
 * Blob. The user must confirm explicitly; the export (and its edit lock)
 * was released while they decide.
 */
const exporterStore = useExporterStore()
const { blobConfirm } = storeToRefs(exporterStore)

const threshold = formatBytes(ENGINE_DEFAULTS.exportBlobConfirmBytes)

function onConfirm() {
  void exporterStore.confirmBlob()
}

function onDismiss() {
  exporterStore.dismissBlobConfirm()
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="blobConfirm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="export-confirm-title"
      class="modal modal-open"
    >
      <div class="modal-box max-w-lg">
        <h2 id="export-confirm-title" class="text-lg font-bold" data-testid="export-confirm-title">
          Confirm large download
        </h2>
        <p class="py-2 text-sm text-base-content/80">
          This export is estimated at
          <strong data-testid="export-confirm-estimate">{{ formatBytes(blobConfirm.estimatedBytes) }}</strong>
          ({{ blobConfirm.totalRows.toLocaleString() }} rows).
        </p>
        <div class="alert alert-warning text-xs py-2 mt-2" data-testid="export-confirm-warning">
          <span>
            This browser has no direct file writing, so the whole file is assembled in memory before
            downloading (above {{ threshold }} that can exhaust the tab's memory). You can also close
            this dialog and export from a browser with direct file writing.
          </span>
        </div>
        <div class="modal-action justify-end gap-2 pt-4">
          <button class="btn btn-ghost btn-sm" data-testid="export-confirm-dismiss" @click="onDismiss">
            Cancel
          </button>
          <button class="btn btn-primary btn-sm" data-testid="export-confirm-ok" @click="onConfirm">
            Download anyway
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
