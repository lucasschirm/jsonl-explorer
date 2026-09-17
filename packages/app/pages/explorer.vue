<script setup lang="ts">
import { onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useFileStore } from '~/stores/file'
import { useToastStore } from '~/stores/toasts'
import { useUrlRecovery } from '~/composables/useUrlRecovery'
import { decideUrlInput } from '~/utils/urlIntake'

const router = useRouter()
const route = useRoute()
const fileStore = useFileStore()
const toastStore = useToastStore()
const recovery = useUrlRecovery()

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

function onSearch() {
  toastStore.info('Search functionality coming soon', 'Not implemented')
}

function clearSearch() {
  toastStore.info('Search cleared', 'Search')
}

async function resetFile() {
  fileStore.reset()
  await router.push('/')
}
</script>

<template>
  <div class="min-h-screen flex flex-col">
    <!-- Header -->
    <header class="navbar bg-base-100 border-b border-base-300 px-4">
      <div class="navbar-start">
        <span class="text-lg font-semibold text-base-content">JSONL Explorer</span>
      </div>
      <div class="navbar-center hidden md:flex">
        <!-- Search bar will go here -->
      </div>
      <div class="navbar-end gap-2">
        <nuxt-link to="/docs" class="btn btn-ghost btn-sm">Docs</nuxt-link>
        <button class="btn btn-primary btn-sm" @click="resetFile">Upload another file</button>
      </div>
    </header>

    <!-- Main content -->
    <main class="flex-1 flex overflow-hidden">
      <!-- Left panel - Row list -->
      <aside class="w-96 border-r border-base-300 flex flex-col overflow-hidden bg-base-100">
        <!-- Search bar -->
        <div class="p-3 border-b border-base-300 bg-base-200">
          <div class="flex items-center gap-2">
            <label for="search-input" class="sr-only">Search</label>
            <svg class="w-5 h-5 text-base-content/50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              id="search-input"
              type="text"
              class="input input-bordered flex-1"
              placeholder="Search (Enter to filter)..."
              @keyup.enter="onSearch"
            />
            <button class="btn btn-ghost btn-sm" @click="onSearch" title="Search">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </button>
            <button class="btn btn-ghost btn-sm" @click="clearSearch" title="Clear search">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <!-- Row list - placeholder -->
        <div class="flex-1 overflow-y-auto p-3">
          <div class="text-center text-base-content/50 py-8">
            <svg class="w-12 h-12 mx-auto mb-2 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <p class="text-sm">Row list will appear here</p>
            <p class="text-xs mt-1">Select a file to begin exploring</p>
          </div>
        </div>

        <!-- Status bar -->
        <div class="p-3 border-t border-base-300 bg-base-200 text-xs text-base-content/70">
          <div class="flex items-center justify-between">
            <span>Total: <span class="font-mono">0</span> rows</span>
            <span>Filtered: <span class="font-mono">0</span> rows</span>
          </div>
        </div>
      </aside>

      <!-- Right panel - JSON view -->
      <aside class="flex-1 flex flex-col overflow-hidden bg-base-100">
        <!-- Toolbar -->
        <div class="p-3 border-b border-base-300 bg-base-200 flex items-center gap-2 flex-wrap">
          <button class="btn btn-ghost btn-sm" title="Format (pretty-print)">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
            </svg>
            Format
          </button>
          <button class="btn btn-ghost btn-sm" title="Compact (minify)">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
            </svg>
            Compact
          </button>
          <div class="divider divider-vertical"></div>
          <input
            type="text"
            class="input input-bordered w-48"
            placeholder="Search in document..."
          />
          <button class="btn btn-ghost btn-sm" title="Reset line">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Reset
          </button>
        </div>

        <!-- JSON view - placeholder -->
        <div class="flex-1 overflow-auto p-4">
          <div class="text-center text-base-content/50 py-12">
            <svg class="w-16 h-16 mx-auto mb-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <p class="text-base">Select a row to view JSON</p>
            <p class="text-sm mt-1">Click a row in the left panel</p>
          </div>
        </div>
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
  </div>
</template>