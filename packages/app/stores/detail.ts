import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { useRowStore } from '~/stores/rows'
import { useSelectionStore } from '~/stores/selection'
import { useToastStore } from '~/stores/toasts'
import { ENGINE_DEFAULTS } from '~/engine/config/adr'
import { parseJsonText, type JsonParseResult } from '~/utils/jsonTree'

export type DetailStatus = 'idle' | 'loading' | 'ready' | 'error'
export type DetailViewMode = 'format' | 'compact'

/**
 * Detail loader (TSK0024): the full text of the ACTIVE row, loaded on
 * demand through the worker (`getLine`) — list previews are byte-capped,
 * the detail is exact.
 *
 * Concurrency: rapid selection bumps a load token; a response that no
 * longer matches the token (or the active id) is dropped, so slow
 * getLine answers can never render a row the user has already left.
 *
 * Large rows: above the configured parse/render threshold a row defaults
 * to RAW mode (no parse, no tree) until the user confirms — a single
 * giant row must not freeze the UI automatically.
 *
 * Presentation: `viewMode` (format/compact) is presentation-only. It
 * never posts setEdit and never mutates the worker's text.
 */
export const useDetailStore = defineStore('detail', () => {
  const rowStore = useRowStore()
  const selectionStore = useSelectionStore()
  const toastStore = useToastStore()

  const lineId = ref<number | null>(null)
  /** Full, unescaped row text (null until loaded). */
  const text = ref<string | null>(null)
  /** Full byte length of the row (worker-reported when cached). */
  const byteLength = ref(0)
  const status = ref<DetailStatus>('idle')
  const loadError = ref<string | null>(null)
  const viewMode = ref<DetailViewMode>('format')
  /** Row exceeds the parse threshold: raw until confirmedTreeView(). */
  const needsConfirm = ref(false)
  let loadToken = 0
  /** Non-duplicating invalid-JSON toast: one per (row, context). */
  let lastInvalidToastLineId: number | null = null

  const parsed = computed<JsonParseResult | null>(() => {
    if (status.value !== 'ready' || text.value === null || needsConfirm.value) return null
    return parseJsonText(text.value)
  })

  const isLarge = computed(() => byteLength.value > ENGINE_DEFAULTS.largeRowDetailThreshold)

  /** Parse (or re-parse after confirmation) for display. */
  function confirmTreeView(): void {
    needsConfirm.value = false
  }

  /** Presentation-only mode switch (never an edit, never an RPC). */
  function setViewMode(mode: DetailViewMode): void {
    viewMode.value = mode
  }

  function resetDetail(): void {
    loadToken += 1 // any in-flight answer becomes stale
    lineId.value = null
    text.value = null
    byteLength.value = 0
    status.value = 'idle'
    loadError.value = null
    needsConfirm.value = false
    viewMode.value = 'format'
    lastInvalidToastLineId = null // new context: re-toasting is allowed again
  }

  async function load(id: number): Promise<void> {
    const token = ++loadToken
    lineId.value = id
    status.value = 'loading'
    loadError.value = null
    needsConfirm.value = false
    try {
      const full = await rowStore.getFullText(id)
      if (token !== loadToken || selectionStore.activeLineId !== id) return // stale
      if (full === null) {
        // No source (disposed/reset while in flight).
        status.value = 'idle'
        text.value = null
        return
      }
      const cached = rowStore.rows.get(id)
      text.value = full.text
      // Byte-exact: the window cache carries the row's byte length (the
      // override's, when edited); otherwise measure the loaded text.
      byteLength.value =
        cached?.byteLength ?? new TextEncoder().encode(full.text).length
      if (byteLength.value > ENGINE_DEFAULTS.largeRowDetailThreshold) {
        needsConfirm.value = true // raw until the user confirms the tree
      } else if (parseJsonText(full.text).ok === false) {
        // Non-duplicating policy: the banner is always visible; the toast
        // fires once per invalid row (re-selecting the SAME row after
        // leaving it does not re-toast; a different row does).
        if (id !== lastInvalidToastLineId) {
          lastInvalidToastLineId = id
          toastStore.error('Row is not valid JSON — showing raw text', 'Invalid JSON')
        }
      }
      status.value = 'ready'
    } catch (error) {
      if (token !== loadToken) return // superseded by a newer selection
      status.value = 'error'
      loadError.value = error instanceof Error ? error.message : 'Failed to load row'
    }
  }

  // Follow the active row (selection transitions, keyboard, clicks).
  watch(
    () => selectionStore.activeLineId,
    async (id) => {
      if (id === null) {
        resetDetail()
        return
      }
      await load(id)
    },
    { immediate: true },
  )

  return {
    lineId,
    text,
    byteLength,
    status,
    loadError,
    viewMode,
    needsConfirm,
    isLarge,
    parsed,
    confirmTreeView,
    setViewMode,
    resetDetail,
  }
})
