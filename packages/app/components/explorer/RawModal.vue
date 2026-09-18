<script setup lang="ts">
/**
 * Virtualized Raw view (TSK0025).
 *
 * Shows the CURRENT FILTERED dataset as raw rows without ever
 * concatenating the dataset into one string: a virtualized scroller
 * (same @tanstack/vue-virtual pattern as the row list) over the same
 * bounded row windows/cache. DOM and memory stay bounded by the
 * viewport regardless of how many filtered rows exist.
 *
 * Row text uses the exact list semantics: byte-capped, C0/DEL-escaped,
 * single line. The per-row Copy button fetches the FULL text
 * (getLine) and copies it, surfacing errors via toast.
 *
 * Accessibility comes from Modal (focus trap, Escape, backdrop close,
 * role=dialog aria-modal).
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useVirtualizer, type Virtualizer } from '@tanstack/vue-virtual'
import Modal from '~/components/ui/Modal.vue'
import { useRowStore } from '~/stores/rows'
import { useToastStore } from '~/stores/toasts'
import { copyText } from '~/utils/clipboard'

const props = withDefaults(
  defineProps<{
    modelValue: boolean
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
const emit = defineEmits<{ (e: 'update:modelValue', value: boolean): void }>()

/** Rows rendered beyond the visible range on each side. */
const OVERSCAN = 8

const rowStore = useRowStore()
const toastStore = useToastStore()

const scrollRef = ref<HTMLElement | null>(null)
const copyingLineId = ref<number | null>(null)

const count = computed(() => rowStore.totalFiltered)
const hasRows = computed(() => count.value > 0)

// Fixed initialRect => fixed viewport: override element rect observation
// (deterministic for tests/embeds) — same contract as the row list.
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

/** Fetch the overscanned window the virtualizer currently shows. The
 *  store coalesces duplicates and drops stale responses by generation. */
function requestWindow(instance: Virtualizer): void {
  const items = instance.getVirtualItems()
  if (items.length > 0) {
    rowStore.ensureWindow(items[0]!.index, items[items.length - 1]!.index)
  }
}

// Options must be a ref: the wrapper only unrefs the top level.
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

// The store's re-render signal (placeholders flip to content when rows
// arrive or evict — display->line is a plain Map in the store).
const cacheVersion = computed(() => rowStore.version)

function rowFor(index: number) {
  return rowStore.rowForDisplay(index)
}

// Count/generation changes with an unchanged viewport never notify the
// virtualizer core: re-derive the window explicitly (cheap no-op when
// the rows are already cached).
watch(
  [() => rowStore.totalFiltered, () => rowStore.generation],
  () => {
    if (rowStore.generation === 0 && rowStore.totalFiltered === 0) return
    void nextTick(() => requestWindow(virtualizer.value))
  },
)

/** Copy the FULL text of one raw row (fetches on demand). Errors are
 *  surfaced, never silent. */
async function copyRow(lineId: number): Promise<void> {
  copyingLineId.value = lineId
  try {
    const full = await rowStore.getFullText(lineId)
    if (full === null) throw new Error('The source was closed while copying')
    await copyText(full.text)
    toastStore.success('Full row text copied', 'Copied')
  } catch (error) {
    toastStore.error(error instanceof Error ? error.message : 'Copy failed', 'Copy failed')
  } finally {
    copyingLineId.value = null
  }
}
</script>

<template>
  <Modal :model-value="modelValue" title="Raw view" size="xl" @update:model-value="emit('update:modelValue', $event)">
    <div data-testid="raw-modal-body" class="flex flex-col gap-2">
      <p v-if="!hasRows" data-testid="raw-empty" class="text-sm text-base-content/70 py-6 text-center">
        No rows in the current view.
      </p>

      <!-- Bounded DOM: only viewport + overscan rows exist, whatever the
           filtered dataset size. -->
      <div
        v-else
        ref="scrollRef"
        data-testid="raw-scroll"
        role="list"
        aria-label="Raw rows"
        class="h-96 overflow-y-auto border border-base-300 rounded-box bg-base-100"
      >
        <div
          :data-cache-version="cacheVersion"
          :style="{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }"
        >
          <div
            v-for="item in virtualizer.getVirtualItems()"
            :key="item.key"
            role="listitem"
            data-testid="raw-item"
            class="absolute left-0 right-0 flex items-center gap-2 px-2 border-b border-base-300/40 font-mono text-xs"
            :style="{
              transform: `translateY(${item.start}px)`,
              height: `${props.rowHeight}px`,
            }"
          >
            <template v-if="rowFor(item.index) === null">
              <span class="w-16 shrink-0" />
              <span
                data-testid="raw-placeholder"
                class="block h-2 w-2/3 rounded bg-base-300/70 animate-pulse"
              />
            </template>
            <template v-else>
              <span class="w-16 shrink-0 text-right text-base-content/70 tabular-nums">
                {{ rowFor(item.index)!.lineId }}
              </span>
              <!-- Same escaped, byte-capped preview as the list. -->
              <span class="flex-1 truncate text-base-content/90">
                {{ rowFor(item.index)!.text }}
              </span>
              <button
                class="btn btn-ghost btn-xs shrink-0"
                data-testid="raw-copy-btn"
                :disabled="copyingLineId === rowFor(item.index)!.lineId"
                :aria-label="`Copy full text of row ${rowFor(item.index)!.lineId}`"
                @click="copyRow(rowFor(item.index)!.lineId)"
              >
                {{ copyingLineId === rowFor(item.index)!.lineId ? '…' : 'Copy' }}
              </button>
            </template>
          </div>
        </div>
      </div>

      <p v-if="hasRows" class="text-xs text-base-content/70" data-testid="raw-footer">
        {{ rowStore.totalFiltered }} rows in the current (filtered) view. Previews match the
        list (byte-capped, control characters escaped); Copy fetches the full row text.
      </p>
    </div>
  </Modal>
</template>
