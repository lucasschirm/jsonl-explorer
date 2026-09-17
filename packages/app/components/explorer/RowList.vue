<script setup lang="ts">
/**
 * Virtualized row list (TSK0022).
 *
 * Fixed-height rows (single-line escaped previews) rendered through
 * @tanstack/vue-virtual. The virtualizer's visible range (viewport +
 * overscan) is handed to the row store via ensureWindow(), which
 * coalesces it into at most one in-flight getRows RPC. Rows that are not
 * cached yet render as placeholders until their window arrives; the DOM
 * node count is bounded by viewport height regardless of file size.
 *
 * Identity: rows are keyed by lineId (stable source id). Highlight and
 * selection follow the lineId, so a filter changing display indices never
 * drifts the selection.
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useVirtualizer, type Virtualizer } from '@tanstack/vue-virtual'
import { useRowStore } from '~/stores/rows'
import { useSelectionStore } from '~/stores/selection'

const props = withDefaults(
  defineProps<{
    /** Fixed row height in px (previews are single-line). */
    rowHeight?: number
    /**
     * Deterministic initial viewport rect. Production leaves this unset
     * (the live element is measured); tests/embeds may fix it.
     */
    initialRect?: { height?: number; width?: number }
  }>(),
  { rowHeight: 28, initialRect: undefined },
)

/** Rows rendered beyond the visible range on each side. */
const OVERSCAN = 8

const rowStore = useRowStore()
const selectionStore = useSelectionStore()

const scrollRef = ref<HTMLElement | null>(null)

const count = computed(() => rowStore.totalFiltered)
const hasRows = computed(() => count.value > 0)

// A fixed initialRect means a fixed viewport: override the element rect
// observation with it (deterministic for tests/embeds). Without it the
// live element is measured as usual (ResizeObserver in browsers).
const fixedRect = props.initialRect
const fixedRectObserver = fixedRect
  ? (
      _instance: unknown,
      cb: (rect: { width: number; height: number }) => void,
    ): void => {
      cb({ width: fixedRect.width ?? 0, height: fixedRect.height ?? 0 })
      return () => {}
    }
  : undefined

/** Fetch the overscanned window a virtualizer instance currently shows
 *  (getVirtualItems includes overscan; the raw range does not). The store
 *  coalesces duplicates and drops stale responses by generation (TSK0021). */
function requestWindow(instance: Virtualizer): void {
  const items = instance.getVirtualItems()
  if (items.length > 0) {
    rowStore.ensureWindow(items[0]!.index, items[items.length - 1]!.index)
  }
}

// The options object itself must be a ref: useVirtualizer only unrefs the
// top level, so reactive values (count) must be unwrapped inside a computed.
const virtualizer = useVirtualizer(
  computed(() => ({
    count: count.value,
    estimateSize: () => props.rowHeight,
    overscan: OVERSCAN,
    getScrollElement: () => scrollRef.value,
    initialRect: fixedRect,
    ...(fixedRect ? { observeElementRect: fixedRectObserver } : {}),
    onChange: requestWindow,
  })),
)

/** The store's re-render signal (display->line cache is a plain Map;
 *  reading this makes the list re-render when rows arrive or evict, so
 *  placeholders flip to content). */
const cacheVersion = computed(() => rowStore.version)

/** The cached row for a display index (null while its window is pending). */
function rowFor(index: number) {
  return rowStore.rowForDisplay(index)
}

// onChange (above) covers scroll-driven range changes. This watch covers
// count/generation changes with an unchanged viewport — the core never
// notifies for those — so placeholders never stay pending after a filter
// or an index commit.
watch(
  [() => rowStore.totalFiltered, () => rowStore.generation],
  () => {
    // The core only notifies on element/rect/scroll events, so a change in
    // count (index commit, filter result) or generation (cache cleared) with
    // an unchanged viewport would never re-request through onChange. This
    // watch covers both; re-deriving the window is a cheap no-op when the
    // rows are already cached. gen 0 + count 0 is a full reset: the count
    // will drive the first window of the next source.
    if (rowStore.generation === 0 && rowStore.totalFiltered === 0) return
    // nextTick: the virtualizer's own options watch (same flush) must have
    // applied the new count before we re-derive its window.
    void nextTick(() => requestWindow(virtualizer.value))
  },
)

/** Re-requests the currently visible window after a fetch failure. */
function retryWindow(): void {
  requestWindow(virtualizer.value)
}

/** Highlight follows the STABLE lineId, never a display index. */
function isSelected(index: number): boolean {
  const row = rowStore.rowForDisplay(index)
  return row !== null && selectionStore.activeLineId === row.lineId
}

function onRowClick(index: number): void {
  const row = rowStore.rowForDisplay(index)
  if (!row) return
  selectionStore.activate(row.lineId, index)
  scrollRef.value?.focus() // arrow keys work right after a click
}

/** Keyboard focus guard: never hijack keys from text editors (TSK0023). */
function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  )
}

/** Keyboard cursor waiting for its (uncached) row to arrive. */
let pendingCursor: number | null = null

/** ArrowUp/ArrowDown: move the active row, scroll it into view, clamp at
 *  the view boundaries (no wrap). One row is fetched on demand when the
 *  target is not cached yet; activation lands when it arrives. */
function onKeydown(event: KeyboardEvent): void {
  if (isEditable(event.target)) return
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  event.preventDefault()
  const total = rowStore.totalFiltered
  if (total === 0) return

  const base = selectionStore.activeDisplayIndex
  const step = event.key === 'ArrowDown' ? 1 : -1
  const target = Math.min(Math.max((base ?? (step > 0 ? -1 : 1)) + step, 0), total - 1)

  virtualizer.value.scrollToIndex(target, { align: 'auto' })
  const row = rowStore.rowForDisplay(target)
  if (row) {
    selectionStore.activate(row.lineId, target)
    return
  }
  // Not cached yet: fetch exactly that row and activate when it lands.
  pendingCursor = target
  rowStore.ensureWindow(target, target)
}

// The row the keyboard cursor is waiting for arrived.
watch(
  () => rowStore.version,
  () => {
    if (pendingCursor === null) return
    const row = rowStore.rowForDisplay(pendingCursor)
    if (row) {
      selectionStore.activate(row.lineId, pendingCursor)
      pendingCursor = null
    }
  },
)

// The store resolved/changed the active row (filter transitions, auto-
// select): keep it on screen.
watch(
  () => selectionStore.activeDisplayIndex,
  (index) => {
    if (index !== null && rowStore.totalFiltered > 0) {
      virtualizer.value.scrollToIndex(index, { align: 'auto' })
    }
  },
)
</script>

<template>
  <div class="flex-1 min-h-0 flex flex-col">
    <!-- Window fetch failure: typed message + retry (no silent hang on
         placeholders). Worker-death errors are fatal elsewhere; this is
         for transient per-RPC failures. -->
    <div
      v-if="rowStore.loadError"
      data-testid="row-list-error"
      role="alert"
      class="flex items-center justify-between gap-2 px-3 py-2 border-b border-error/30 bg-error/10 text-xs text-error"
    >
      <span>Failed to load rows: {{ rowStore.loadError }}</span>
      <button class="btn btn-error btn-xs shrink-0" data-testid="row-list-retry" @click="retryWindow">
        Retry
      </button>
    </div>

    <!-- Zero rows (empty file, or nothing committed yet): a clean state,
         not an empty scroller. -->
    <div
      v-if="!hasRows"
      data-testid="row-list-empty"
      class="flex-1 flex items-center justify-center p-6 text-center text-sm text-base-content/50"
    >
      <p>No rows to show.</p>
      <p class="text-xs mt-1 text-base-content/40">Rows appear as the index commits.</p>
    </div>

    <!-- Bounded DOM: only viewport + overscan rows exist in the tree. -->
    <div
      v-else
      ref="scrollRef"
      data-testid="row-list-scroll"
      role="list"
      aria-label="Rows"
      tabindex="0"
      class="flex-1 min-h-0 overflow-y-auto focus:outline-none focus:ring-1 focus:ring-primary/50"
      @keydown="onKeydown"
    >
      <div
        :data-cache-version="cacheVersion"
        :style="{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }"
      >
        <div
          v-for="item in virtualizer.getVirtualItems()"
          :key="item.key"
          role="listitem"
          data-testid="row-item"
          class="absolute left-0 right-0 flex items-center gap-2 px-2 border-b border-base-300/40 font-mono text-xs cursor-pointer select-none"
          :class="{ 'bg-primary/10': isSelected(item.index) }"
          :style="{
            transform: `translateY(${item.start}px)`,
            height: `${props.rowHeight}px`,
          }"
          @click="onRowClick(item.index)"
        >
          <!-- Placeholder while the window is in flight (bounded, honest). -->
          <template v-if="rowFor(item.index) === null">
            <span class="w-14 shrink-0" />
            <span
              data-testid="row-placeholder"
              class="block h-2 w-2/3 rounded bg-base-300/70 animate-pulse"
            />
          </template>
          <template v-else>
            <span class="w-14 shrink-0 text-right text-base-content/50 tabular-nums">
              {{ rowFor(item.index)!.lineId }}
            </span>
            <!-- Preview is pre-escaped (C0/DEL) and capped: always one line. -->
            <span class="truncate text-base-content/90" :data-line-id="rowFor(item.index)!.lineId">
              {{ rowFor(item.index)!.text }}
            </span>
            <!-- TSK0030: the row text is a local edit override, not the source. -->
            <span
              v-if="rowFor(item.index)!.isEdited"
              data-testid="row-edited-badge"
              class="badge badge-xs badge-outline badge-warning shrink-0 font-sans"
            >
              edited
            </span>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>
