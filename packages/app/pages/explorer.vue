<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useFileStore } from '~/stores/file'
import { useExporterStore } from '~/stores/exporter'
import { useToastStore } from '~/stores/toasts'
import { useUrlRecovery } from '~/composables/useUrlRecovery'
import { useJsonlEngine } from '~/composables/useJsonlEngine'
import { decideUrlInput } from '~/utils/urlIntake'
import { isEditableEventTarget, isModalOpen } from '~/utils/keyboard'
import LoadingPanel from '~/components/loading/LoadingPanel.vue'
import RowList from '~/components/explorer/RowList.vue'
import StatusBar from '~/components/explorer/StatusBar.vue'
import DetailPanel from '~/components/explorer/DetailPanel.vue'
import FilterBar from '~/components/explorer/FilterBar.vue'
import ExportStatus from '~/components/explorer/ExportStatus.vue'
import ExportConfirmModal from '~/components/explorer/ExportConfirmModal.vue'

const router = useRouter()
const route = useRoute()
const fileStore = useFileStore()
const toastStore = useToastStore()
const recovery = useUrlRecovery()
const engineApi = useJsonlEngine()
const exporterStore = useExporterStore()

// Background indexing (TSK0019): file/handover sources are indexed after
// init, so the explorer is entered while rows keep committing.
const progress = computed(() => engineApi.progress.value)
const indexState = computed(() => engineApi.indexState.value)
const indexing = computed(() => indexState.value === 'running')

// Export (TSK0035): FSA streams to a user-chosen file; the Blob fallback
// (Firefox/Safari) buffers and may ask for confirmation above the threshold.
function onExportClick() {
  if (exporterStore.hasFsa) void exporterStore.runFsa()
  else void exporterStore.prepareBlob()
}

async function cancelIndex() {
  await engineApi.cancelActive()
}

async function resumeIndex() {
  await engineApi.startIndex()
}

/**
 * Consume the `?url=` bootstrap (R5): scrub, load, then strip the param.
 * On failure the non-secret URL is kept in memory (useUrlRecovery) so the
 * landing page can offer an immediate retry.
 * @returns true when a `?url=` bootstrap was present (handled or failed).
 */
async function consumeUrlBootstrap(): Promise<boolean> {
  const urlParam = route.query.url
  if (!urlParam || typeof urlParam !== 'string') return false

  // route.query values are already decoded once by vue-router; do not
  // decode again (a second pass corrupts URLs containing literal '%').
  const intake = decideUrlInput(urlParam)
  if (intake.kind !== 'ready') {
    if (intake.kind === 'invalid') {
      toastStore.error(intake.message, 'Invalid URL parameter')
    }
    await router.push('/')
    return true
  }

  try {
    await fileStore.loadFromUrl(intake.url)
    // The URL (possibly with a query string) never stays in the address bar.
    if (import.meta.client) {
      history.replaceState({}, '', '/explorer')
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load from URL parameter'
    toastStore.error(message, 'URL load failed')
    recovery.setRecoveredUrl(intake.url)
    await router.push('/')
  }
  return true
}

onMounted(async () => {
  const hadBootstrap = await consumeUrlBootstrap()

  // Guard: redirect to landing if no file loaded (only when there was no
  // bootstrap to report on — a failed bootstrap already navigated + toasted).
  if (!hadBootstrap && !fileStore.hasFile) {
    toastStore.info('No file loaded. Please open a JSONL file first.', 'No file')
    await router.push('/')
  }
})

// ---------------------------------------------------------------------------
// Explorer keyboard policy (TSK0036)
//
// - Ctrl/Cmd+F — focus the filter input (the explorer's search).
// - Enter on the row list — move focus to the editor for the active row
//   (tree root value, or the raw editor for invalid rows).
//
// Neither shortcut may OVERRIDE a focused control: while an input,
// textarea, select, or contenteditable has focus its native keys win;
// while a modal is open the dialog owns the keys.
// ---------------------------------------------------------------------------
function onExplorerKeydown(event: KeyboardEvent): void {
  if (isEditableEventTarget(event.target)) return
  if (isModalOpen()) return

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
    event.preventDefault()
    document.querySelector<HTMLInputElement>('[data-testid="filter-input"]')?.focus()
    return
  }

  // Plain Enter (no modifiers) on the row list: focus the active row's
  // editor. The editor control only exists when a row is active and the
  // detail document is loaded, so a null query result is the no-op.
  if (event.key !== 'Enter' || event.ctrlKey || event.metaKey || event.altKey) return
  const target = event.target instanceof HTMLElement ? event.target : null
  if (!target?.closest('[data-testid="row-list-scroll"]')) return
  // Root container: the bracket (expanded) or the summary (collapsed) is
  // the edit affordance; invalid rows get the raw editor instead.
  const editor = document.querySelector<HTMLElement>(
    '[data-testid="json-edit-root-0"], [data-testid="json-count-root-0"], [data-testid="detail-raw-edit-btn"]',
  )
  if (editor) {
    event.preventDefault()
    editor.focus()
  }
}

onMounted(() => {
  window.addEventListener('keydown', onExplorerKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onExplorerKeydown)
})

/**
 * "Upload another file": fully dispose the engine (worker, spool, caches)
 * and return to landing. Awaited so the dispose RPC (worker-side spool
 * cleanup) is posted before we leave the page.
 */
async function resetFile() {
  await fileStore.reset()
  await router.push('/')
}
</script>

<template>
  <!--
    Explorer shell (TSK0020): the split layout targets a 1024px minimum
    viewport (ADR "Explorer shell and minimum viewport"); below that the
    root keeps its min width and the page scrolls horizontally instead of
    stacking the panels.
  -->
  <div class="min-h-screen min-w-[1024px] flex flex-col">
    <!-- Header: small (48px) and fixed — the panels scroll inside it, never it. -->
    <header class="navbar h-12 bg-base-100 border-b border-base-300 px-4">
      <div class="navbar-start">
        <span class="text-lg font-semibold text-base-content">JSONL Explorer</span>
      </div>
      <div class="navbar-center hidden md:flex">
        <!-- Search bar will go here -->
      </div>
      <div class="navbar-end gap-2">
        <nuxt-link to="/docs" class="btn btn-ghost btn-sm">Docs</nuxt-link>
        <!--
          Export (TSK0035): worker snapshot + backpressure pump to the
          browser's save destination. Disabled while nothing is loaded,
          while an export runs, or while a filter scan is settling.
        -->
        <button
          class="btn btn-ghost btn-sm"
          data-testid="export-button"
          :disabled="!exporterStore.canStart"
          title="Export the current view (filtered or full) as .jsonl"
          @click="onExportClick"
        >Export</button>
        <!--
          Upload another file (PLAN 4.3): back to landing; the engine is
          fully disposed (worker terminated, spool cleaned worker-side,
          caches gone with the worker) so nothing leaks across sources.
        -->
        <button
          class="btn btn-primary btn-sm"
          data-testid="upload-another"
          @click="resetFile"
        >Upload another file</button>
      </div>
    </header>

    <!-- Indexing status (TSK0019): rows commit while the scan continues; -->
    <!-- cancel is operation-scoped, resume restarts the scan.            -->
    <div
      v-if="fileStore.hasFile && (indexing || indexState !== 'idle')"
      class="px-4 py-2 border-b border-base-300 bg-base-200"
    >
      <LoadingPanel
        v-if="indexing"
        :source-name="fileStore.fileName"
        :download="null"
        :index="progress.index"
        :cancellable="true"
        @cancel="cancelIndex"
      />
      <div v-else-if="indexState === 'cancelled'" class="flex items-center justify-between gap-3 text-sm">
        <span class="text-base-content/80">
          Indexing was cancelled. Resume to index the file again.
        </span>
        <button class="btn btn-primary btn-sm" data-testid="index-resume" @click="resumeIndex">
          Resume
        </button>
      </div>
      <div v-else-if="indexState === 'failed'" role="alert" class="flex items-center justify-between gap-3 text-sm">
        <span class="text-error">Indexing failed: {{ engineApi.indexError }}</span>
        <button class="btn btn-primary btn-sm" data-testid="index-retry" @click="resumeIndex">
          Retry
        </button>
      </div>
    </div>

    <!-- Export progress (TSK0035): filename, row/byte progress, cancel. -->
    <ExportStatus v-if="exporterStore.isRunning" />

    <!-- Main content -->
    <main class="flex-1 flex overflow-hidden">
      <!-- Left panel - Row list -->
      <aside class="w-96 border-r border-base-300 flex flex-col overflow-hidden bg-base-100">
        <!-- Filter bar (TSK0028): literal text + jq, explicit run only. -->
        <FilterBar />

        <!-- Row list (TSK0022): virtualized, batched windows, bounded DOM -->
        <RowList />

        <!-- Status bar (TSK0023): counts agree with worker snapshots; -->
        <!-- indexing/filtering/partial states are always visible.        -->
        <StatusBar />
      </aside>

      <!-- Right panel - JSON detail (TSK0024): on-demand full text, -->
      <!-- collapsible tree, raw fallbacks, Format/Compact presentation -->
      <aside class="flex-1 flex flex-col overflow-hidden bg-base-100">
        <DetailPanel />
      </aside>
    </main>

    <!-- Raw view modal placeholder -->
    <div v-if="false" class="modal modal-open">
      <div class="modal-box max-w-4xl">
        <h3 class="font-bold text-lg mb-4">Raw View</h3>
        <pre class="whitespace-pre-wrap text-sm max-h-96 overflow-auto p-4 bg-base-200 rounded"></pre>
        <div class="modal-action">
          <button class="btn btn-primary">Close</button>
        </div>
      </div>
    </div>
    <!-- Blob fallback: over-threshold estimate needs explicit consent. -->
    <ExportConfirmModal />
  </div>
</template>