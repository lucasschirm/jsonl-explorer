<script setup lang="ts">
/**
 * Explorer detail panel (TSK0024): loads the active row's FULL text on
 * demand (detail store) and renders it —
 *   - valid JSON: collapsible, theme-aware JsonTree;
 *   - invalid JSON: raw text + error banner (one toast on selection);
 *   - row above the parse threshold: RAW by default with an explicit
 *     confirm before the tree is parsed/rendered (no auto-freeze);
 *   - no source / loading / RPC failure: typed states, never a blank.
 *
 * Format/Compact are PRESENTATION modes only (they re-serialize the
 * parsed value for text consumers) — they never post setEdit and never
 * touch the worker's text.
 */
import { computed, ref } from 'vue'
import { useDetailStore } from '~/stores/detail'
import { ENGINE_DEFAULTS } from '~/engine/config/adr'
import { formatBytes, serializeFormatted, serializeCompact } from '~/utils/jsonTree'
import JsonTree from '~/components/explorer/JsonTree.vue'
import RawModal from '~/components/explorer/RawModal.vue'
import { useToastStore } from '~/stores/toasts'
import { copyText } from '~/utils/clipboard'

const detailStore = useDetailStore()
const toastStore = useToastStore()

/** Raw view of the current filtered dataset (virtualized modal). */
const rawOpen = ref(false)
const copying = ref(false)

/** Copy the selected row's FULL text (loaded via getLine). For valid
 *  JSON the Format/Compact mode decides the serialization (the
 *  presentation-only modes are the copy/export consumer); invalid or
 *  unconfirmed rows copy the raw text. Errors are surfaced, never silent. */
function copyPayload(): string {
  const parsed = detailStore.parsed
  if (parsed !== null && parsed.ok) {
    return detailStore.viewMode === 'compact'
      ? serializeCompact(parsed.value)
      : serializeFormatted(parsed.value)
  }
  return detailStore.text ?? ''
}

async function copyRow(): Promise<void> {
  if (detailStore.status !== 'ready' || detailStore.text === null) return
  copying.value = true
  try {
    await copyText(copyPayload())
    toastStore.success('Row copied', 'Copied')
  } catch (error) {
    toastStore.error(error instanceof Error ? error.message : 'Copy failed', 'Copy failed')
  } finally {
    copying.value = false
  }
}

const showTree = computed(
  () => detailStore.status === 'ready' && !detailStore.needsConfirm && detailStore.parsed?.ok === true,
)
const showInvalidRaw = computed(
  () => detailStore.status === 'ready' && !detailStore.needsConfirm && detailStore.parsed?.ok === false,
)
const showLargeRaw = computed(
  () => detailStore.status === 'ready' && detailStore.needsConfirm,
)

// NOTE (TSK0031+): when the copy/export controls land, Format/Compact will
// decide how the parsed document is serialized for them (pretty 2-space
// vs minified). Until then the mode is the toolbar's active state + the
// panel's data-mode attribute — always presentation-only, never an edit.

function confirmTree(): void {
  detailStore.confirmTreeView()
}
</script>

<template>
  <section class="flex-1 flex flex-col overflow-hidden" data-testid="detail-panel" :data-mode="detailStore.viewMode">
    <!-- Toolbar: Format/Compact are presentation-only (no edits, no RPC) -->
    <div class="p-3 border-b border-base-300 bg-base-200 flex items-center gap-2 flex-wrap">
      <button
        class="btn btn-sm"
        :class="detailStore.viewMode === 'format' ? 'btn-primary' : 'btn-ghost'"
        data-testid="detail-format-btn"
        :disabled="detailStore.status !== 'ready'"
        title="Format (pretty-print, 2 spaces) — presentation only"
        @click="detailStore.setViewMode('format')"
      >
        Format
      </button>
      <button
        class="btn btn-sm"
        :class="detailStore.viewMode === 'compact' ? 'btn-primary' : 'btn-ghost'"
        data-testid="detail-compact-btn"
        :disabled="detailStore.status !== 'ready'"
        title="Compact (minified) — presentation only"
        @click="detailStore.setViewMode('compact')"
      >
        Compact
      </button>
      <button
        class="btn btn-sm btn-ghost ml-auto"
        data-testid="detail-copy-btn"
        :disabled="detailStore.status !== 'ready' || copying"
        title="Copy the full text of this row"
        @click="copyRow()"
      >
        {{ copying ? '…' : 'Copy' }}
      </button>
      <button
        class="btn btn-sm btn-ghost"
        data-testid="detail-raw-btn"
        title="Open the virtualized raw view of the current (filtered) rows"
        @click="rawOpen = true"
      >
        Raw
      </button>
      <span class="text-xs text-base-content/50">
        <template v-if="detailStore.status === 'ready'">
          Line {{ detailStore.lineId }} · {{ formatBytes(detailStore.byteLength) }}
        </template>
        <template v-else-if="detailStore.status === 'loading'">Loading…</template>
      </span>
    </div>

    <!-- No active row -->
    <div v-if="detailStore.status === 'idle'" class="flex-1 overflow-auto p-4">
      <div class="text-center text-base-content/50 py-12" data-testid="detail-placeholder">
        <svg class="w-16 h-16 mx-auto mb-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="1.5"
            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
          />
        </svg>
        <p class="text-base">Select a row to view JSON</p>
        <p class="text-sm mt-1">Click a row in the left panel</p>
      </div>
    </div>

    <!-- RPC failure (typed worker error) -->
    <div v-else-if="detailStore.status === 'error'" class="flex-1 overflow-auto p-4" role="alert" data-testid="detail-error">
      <p class="text-error text-sm mb-2">Failed to load row: {{ detailStore.loadError }}</p>
    </div>

    <!-- Loading (a getLine is in flight) -->
    <div v-else-if="detailStore.status === 'loading'" class="flex-1 overflow-auto p-4" data-testid="detail-loading">
      <p class="text-base-content/50 text-sm animate-pulse">Loading row…</p>
    </div>

    <!-- Ready: one of tree / invalid-raw / large-raw -->
    <div v-else class="flex-1 overflow-auto p-4">
      <!-- Valid JSON: the collapsible tree -->
      <JsonTree v-if="showTree" :value="detailStore.parsed!.value!" />

      <!-- Invalid JSON: banner + raw text -->
      <template v-else-if="showInvalidRaw">
        <div class="alert alert-warning text-sm mb-3" role="alert" data-testid="detail-invalid-banner">
          <svg class="shrink-0" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span>
            Not valid JSON ({{ detailStore.parsed?.error }}) — showing raw text.
          </span>
        </div>
        <pre class="whitespace-pre-wrap break-all font-mono text-sm bg-base-200 rounded p-3" data-testid="detail-raw">{{ detailStore.text }}</pre>
      </template>

      <!-- Large row: raw by default, confirm before parsing the tree -->
      <template v-else-if="showLargeRaw">
        <div class="alert alert-info text-sm mb-3" role="alert" data-testid="detail-large-confirm">
          <span>
            This row is {{ formatBytes(detailStore.byteLength) }} — above the
            {{ formatBytes(ENGINE_DEFAULTS.largeRowDetailThreshold) }} parse threshold.
            Showing raw text; confirm to parse and render the JSON tree (this may
            be slow).
          </span>
          <button class="btn btn-primary btn-xs" data-testid="detail-large-confirm-btn" @click="confirmTree">
            View as JSON tree
          </button>
        </div>
        <pre class="whitespace-pre-wrap break-all font-mono text-sm bg-base-200 rounded p-3 max-h-96 overflow-auto" data-testid="detail-raw">{{ detailStore.text }}</pre>
      </template>
    </div>
  </section>

  <!-- Virtualized raw view of the current filtered dataset (bounded
       DOM/memory; never concatenates the dataset). -->
  <RawModal v-model="rawOpen" />
</template>
