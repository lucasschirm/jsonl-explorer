<script setup lang="ts">
import type { UrlFallbackConfirmRequest } from '@jsonl-explorer/shared'
import { formatBytes } from '~/utils/format'

interface Props {
  /** The pending consent request from the worker; null when none is waiting. */
  request: UrlFallbackConfirmRequest | null
}

defineProps<Props>()

const emit = defineEmits<{ decide: [accept: boolean] }>()

const REASON_TEXT: Record<UrlFallbackConfirmRequest['reason'], string> = {
  'opfs-unavailable': 'The local disk cache (OPFS) is not available in this browser.',
  'opfs-quota-exceeded': 'The local disk cache quota was exceeded while saving the download.',
  'declared-size-over-quota': 'The declared file size exceeds the local disk cache quota.',
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="request"
      role="dialog"
      aria-modal="true"
      aria-labelledby="fallback-confirm-title"
      class="modal modal-open"
    >
      <div class="modal-box max-w-lg">
        <h2 id="fallback-confirm-title" class="text-lg font-bold">Confirm memory fallback</h2>
        <p class="py-2 text-sm text-base-content/80">{{ REASON_TEXT[request.reason] }}</p>
        <ul class="text-sm space-y-1 list-disc pl-5 text-base-content/80">
          <li>
            URL: <code class="text-xs break-all">{{ request.url }}</code>
          </li>
          <li v-if="request.declaredBytes !== undefined">
            Declared size: {{ formatBytes(request.declaredBytes) }}
          </li>
          <li v-else>Declared size: unknown</li>
        </ul>
        <div class="alert alert-info text-xs py-2 mt-3">
          <span>
            Loading in memory keeps the whole file in RAM: it uses more memory, is not cached to
            disk, is lost when you close this tab, and very large files may fail if memory runs
            out.
          </span>
        </div>
        <div class="modal-action justify-end gap-2 pt-4">
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            data-testid="fallback-reject"
            @click="emit('decide', false)"
          >
            Cancel download
          </button>
          <button
            type="button"
            class="btn btn-primary btn-sm"
            data-testid="fallback-accept"
            @click="emit('decide', true)"
          >
            Load in memory
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
