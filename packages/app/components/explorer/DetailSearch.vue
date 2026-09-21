<script setup lang="ts">
/**
 * Local document search (TSK0033): the right-toolbar search over the
 * SELECTED document only — text mode highlights matching keys/values in
 * the tree (count + prev/next, wrap-around, keyboard: Down/Up/Enter),
 * jq mode runs the program in the worker against this one document and
 * shows every output in a collapsible, copyable pane.
 *
 * This component NEVER touches the left-side filter (store or RPC): local
 * search and whole-file filtering are independent by design. Results
 * clear on selection/document change (the search store watches the
 * detail store), and stale jq answers are ignored there too.
 */
import { computed } from 'vue'
import { useDetailSearchStore } from '~/stores/detailSearch'
import { useToastStore } from '~/stores/toasts'
import { copyText } from '~/utils/clipboard'

const searchStore = useDetailSearchStore()
const toastStore = useToastStore()

/** Render cap for the output pane: a program like `.[]` over a huge array
 *  can emit thousands of outputs; the pane shows the first ones and
 *  "Copy all" copies every output (bounded by one document). */
const OUTPUT_RENDER_CAP = 200

const visibleOutputs = computed(() => searchStore.jqOutputs.slice(0, OUTPUT_RENDER_CAP))
const truncated = computed(() => searchStore.jqOutputs.length > OUTPUT_RENDER_CAP)

const countLabel = computed(() => {
  const total = searchStore.matches.length
  if (total === 0) return '0 results'
  if (searchStore.currentIndex < 0) return `${total} result${total === 1 ? '' : 's'}`
  return `${searchStore.currentIndex + 1} / ${total}`
})

/** Keyboard access for match navigation: Down/Next, Up/Previous,
 *  Enter (text: go to next; jq: run). */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    if (searchStore.mode === 'text') searchStore.next()
    else void searchStore.runJq()
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    searchStore.prev()
  } else if (event.key === 'Enter' && searchStore.mode === 'text') {
    event.preventDefault()
    searchStore.next()
  }
}

function outputText(output: unknown): string {
  return JSON.stringify(output) ?? 'undefined'
}

async function copyTextSafe(text: string, label: string): Promise<void> {
  try {
    await copyText(text)
    toastStore.success(label, 'Copied')
  } catch (error) {
    toastStore.error(error instanceof Error ? error.message : 'Copy failed', 'Copy failed')
  }
}

/** Copy every output (one compact JSON line each), not just the visible. */
function copyAll(): void {
  const text = searchStore.jqOutputs.map(outputText).join('\n')
  void copyTextSafe(text, `${searchStore.jqOutputs.length} output(s) copied`)
}
</script>

<template>
  <section class="border-b border-base-300 bg-base-100" data-testid="detail-search">
    <div class="px-3 py-2 flex items-center gap-2 flex-wrap">
      <!-- Mode toggle: text (tree highlight) vs jq (worker execution) -->
      <div class="join join-sm">
        <button
          type="button"
          class="join-item btn btn-xs"
          :class="searchStore.mode === 'text' ? 'btn-primary' : 'btn-ghost'"
          data-testid="detail-search-mode-text"
          title="Highlight matching keys and values in this document"
          @click="searchStore.mode = 'text'"
        >
          Text
        </button>
        <button
          type="button"
          class="join-item btn btn-xs"
          :class="searchStore.mode === 'jq' ? 'btn-primary' : 'btn-ghost'"
          data-testid="detail-search-mode-jq"
          title="Run a jq program against this document only"
          @click="searchStore.mode = 'jq'"
        >
          jq
        </button>
      </div>

      <input
        v-model="searchStore.query"
        type="text"
        class="input input-xs flex-1 min-w-40 max-w-80"
        :placeholder="searchStore.mode === 'text' ? 'Search this document (literal)…' : 'jq program, e.g. .items[].id'"
        :aria-label="searchStore.mode === 'text' ? 'Search the selected document' : 'jq program for the selected document'"
        spellcheck="false"
        autocomplete="off"
        data-testid="detail-search-input"
        @keydown="onKeydown"
      />

      <!-- Text mode: count + prev/next (keyboard: Down/Up/Enter) -->
      <template v-if="searchStore.mode === 'text'">
        <span class="text-xs text-base-content/70 tabular-nums" data-testid="detail-search-count">
          {{ countLabel }}
        </span>
        <button
          type="button"
          class="btn btn-ghost btn-xs"
          :disabled="searchStore.matches.length === 0"
          title="Previous match (Up arrow)"
          data-testid="detail-search-prev"
          @click="searchStore.prev()"
        >
          ↑
        </button>
        <button
          type="button"
          class="btn btn-ghost btn-xs"
          :disabled="searchStore.matches.length === 0"
          title="Next match (Down arrow)"
          data-testid="detail-search-next"
          @click="searchStore.next()"
        >
          ↓
        </button>
      </template>

      <!-- jq mode: explicit Run (Enter also runs) -->
      <button
        v-else
        type="button"
        class="btn btn-primary btn-xs"
        :disabled="searchStore.jqState === 'running' || searchStore.query.trim() === ''"
        title="Run the program against this document only"
        data-testid="detail-search-run"
        @click="void searchStore.runJq()"
      >
        {{ searchStore.jqState === 'running' ? 'Running…' : 'Run' }}
      </button>

      <button
        v-if="searchStore.query !== ''"
        type="button"
        class="btn btn-ghost btn-xs"
        title="Clear the query"
        data-testid="detail-search-clear"
        @click="searchStore.query = ''"
      >
        ×
      </button>
    </div>

    <!-- jq failure: one actionable line (the toast is the same message) -->
    <div
      v-if="searchStore.mode === 'jq' && searchStore.jqState === 'error'"
      class="px-3 pb-2 text-error text-xs"
      role="alert"
      data-testid="detail-search-jq-error"
    >
      {{ searchStore.jqError }}
    </div>

    <!-- Collapsible output pane (done or error states after a run) -->
    <div
      v-if="searchStore.mode === 'jq' && searchStore.jqState !== 'idle'"
      class="border-t border-base-300"
      data-testid="detail-search-jq-pane"
    >
      <button
        type="button"
        class="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-base-content/70 hover:bg-base-200"
        :aria-expanded="searchStore.jqPaneOpen"
        data-testid="detail-search-jq-toggle"
        @click="searchStore.jqPaneOpen = !searchStore.jqPaneOpen"
      >
        <svg
          class="w-3 h-3 transition-transform shrink-0"
          :class="searchStore.jqPaneOpen ? 'rotate-90' : ''"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        <span v-if="searchStore.jqState === 'done'">
          {{ searchStore.jqOutputs.length }} output(s)
        </span>
        <span v-else-if="searchStore.jqState === 'running'">running…</span>
        <span v-else>run failed</span>
        <span
          v-if="searchStore.jqState === 'done' && searchStore.jqOutputs.length > 0"
          class="ml-auto"
        >
          <button
            type="button"
            class="btn btn-ghost btn-xs"
            data-testid="detail-search-jq-copy"
            @click.stop="copyAll()"
          >
            Copy all
          </button>
        </span>
      </button>

      <div v-if="searchStore.jqPaneOpen" class="px-3 pb-2 max-h-80 overflow-auto font-mono text-xs">
        <p
          v-if="searchStore.jqState === 'done' && searchStore.jqOutputs.length === 0"
          class="text-base-content/70 italic py-1"
          data-testid="detail-search-jq-empty"
        >
          No output — the program produced nothing for this document.
        </p>
        <div
          v-for="(output, i) in visibleOutputs"
          :key="i"
          class="flex items-start gap-2 py-0.5 border-b border-base-300/50"
        >
          <code class="break-all flex-1" :data-testid="`detail-search-jq-output-${i}`">
            {{ outputText(output) }}
          </code>
          <button
            type="button"
            class="btn btn-ghost btn-xs shrink-0"
            :title="`Copy output ${i + 1}`"
            :data-testid="`detail-search-jq-copy-${i}`"
            @click="void copyTextSafe(outputText(output), `Output ${i + 1} copied`)"
          >
            Copy
          </button>
        </div>
        <p v-if="truncated" class="text-base-content/70 pt-1">
          …showing the first {{ OUTPUT_RENDER_CAP }} of {{ searchStore.jqOutputs.length }}
          outputs — “Copy all” copies every output.
        </p>
      </div>
    </div>
  </section>
</template>
