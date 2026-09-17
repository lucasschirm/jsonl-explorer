import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { useRowStore } from '~/stores/rows'
import { useSelectionStore } from '~/stores/selection'
import { useEditsStore } from '~/stores/edits'
import { useToastStore } from '~/stores/toasts'
import { ENGINE_DEFAULTS } from '~/engine/config/adr'
import { parseJsonText, type JsonParseResult } from '~/utils/jsonTree'
import {
  applyValueAtPath,
  coerceEdit,
  rawTokenForValue,
  readValueAtPath,
  serializeEdited,
  type EditPath,
} from '~/utils/jsonEdit'

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
 *
 * Two edit sessions (mutually exclusive by row state):
 * - TREE (TSK0031): valid rows — one node's value, path-based, implicit
 *   Enter/blur commit.
 * - RAW (TSK0032): invalid rows — the WHOLE row in a textarea with
 *   explicit Save/Cancel controls (no implicit commits: a multi-line
 *   draft must never save itself on a stray blur).
 * Both mirror through the edits store (one setEdit) and reload after.
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

  // --- Inline tree editing (TSK0031) -------------------------------------
  /** Path of the node currently in the inline editor (null = not editing). */
  const editingPath = ref<EditPath | null>(null)
  /** Raw editor input for `editingPath`. */
  const editDraft = ref('')
  /** True while an edit session is open. */
  const isEditing = computed(() => editingPath.value !== null)
  /** Swallows the blur that follows an Enter commit / Escape cancel, so
   *  one user action can never commit twice (or commit after a cancel). */
  let editSettled = false

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

  /**
   * Open the inline editor on the node at `path`. Only valid-JSON rows
   * have a tree, and the path came from the rendered tree, so the value
   * always exists; invalid state is still guarded (no session without a
   * parsed document).
   */
  function startEdit(path: EditPath): void {
    const doc = parsed.value
    if (doc === null || doc.ok !== true || lineId.value === null) return
    // The path came from the rendered tree, so the value exists; a
    // legitimate JSON `null` seeds the token `null` (JSON.stringify),
    // and a (UI-impossible) stale path would just commit-reject later.
    const value = readValueAtPath(doc.value, path)
    editingPath.value = path
    editDraft.value = rawTokenForValue(value)
    editSettled = false
  }

  /** Escape (or a selection change): discard the draft, no RPC. */
  function cancelEdit(): void {
    if (editingPath.value === null) return
    editingPath.value = null
    editDraft.value = ''
    editSettled = true // the unmount blur must not commit
  }

  /**
   * Enter or blur: coerce the draft (JSON.parse first, string fallback),
   * apply it immutably at the edit path, serialize the WHOLE document as
   * compact JSON, and mirror it with ONE setEdit. A stale path or a
   * rejected edit surfaces as exactly one toast — never a silent drop.
   */
  async function commitEdit(): Promise<void> {
    if (editingPath.value === null || editSettled) return
    editSettled = true
    const path = editingPath.value
    const draft = editDraft.value
    editingPath.value = null
    editDraft.value = ''
    const id = lineId.value
    const doc = parsed.value
    if (id === null || doc === null || doc.ok !== true) {
      toastStore.error('The row is no longer valid JSON — edit discarded', 'Edit failed')
      return
    }
    const next = applyValueAtPath(doc.value, path, coerceEdit(draft))
    if (next === null) {
      toastStore.error('This value can no longer be edited (the row changed)', 'Edit failed')
      return
    }
    try {
      await useEditsStore().setEdit(id, serializeEdited(next))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to apply the edit'
      toastStore.error(message, 'Edit failed')
      return
    }
    // Reload only when this row is STILL the active one: a row switch
    // during the RPC already started its own load, and this reload would
    // bump the token and steal the new selection's answer.
    if (selectionStore.activeLineId === id) {
      await load(id) // re-render: the tree now shows the edited document
    }
  }

  // --- Raw row editing (TSK0032) ------------------------------------------
  /** True while the raw (whole-row) editor is open — invalid rows only. */
  const rawEditing = ref(false)
  /** Raw editor input: the whole row, single line.
   *  NOTE: never commits implicitly (no blur handler) — a multi-line
   *  draft must not save itself on focus loss. */
  const rawDraft = ref('')

  /** Open the raw editor for an INVALID row. Valid rows edit through the
   *  tree instead (the two sessions are mutually exclusive by state). */
  function startRawEdit(): void {
    if (status.value !== 'ready' || text.value === null) return
    if (parsed.value?.ok !== false) return
    rawEditing.value = true
    rawDraft.value = text.value
  }

  /** Cancel control: discard the draft, no RPC. */
  function cancelRawEdit(): void {
    if (!rawEditing.value) return
    rawEditing.value = false
    rawDraft.value = ''
  }

  /**
   * Save control: the draft becomes the row's override (one whole-row
   *  setEdit). Local validation (CR/LF, byte budget) and worker
   *  rejections surface as ONE typed toast while the session STAYS open
   *  (the draft is kept) — nothing fails silently. A successful commit
   *  reloads the row: corrected-to-valid rows render the tree
   *  immediately, and the worker already re-evaluated the active filter
   *  membership for that line (stable ID).
   */
  async function commitRawEdit(): Promise<void> {
    if (!rawEditing.value) return
    const id = lineId.value
    if (id === null) return
    const draft = rawDraft.value
    try {
      await useEditsStore().setEdit(id, draft)
    } catch (error) {
      // Typed validation (EditValidationError / EditBudgetError) or a
      // worker rejection: keep the draft so the user can fix and retry.
      toastStore.error(
        error instanceof Error ? error.message : 'Failed to apply the edit',
        'Edit failed',
      )
      return
    }
    rawEditing.value = false
    rawDraft.value = ''
    // Same guard as commitEdit: never steal a newer selection's load.
    if (selectionStore.activeLineId === id) {
      await load(id) // re-render: tree if corrected, badge either way
    }
  }

  /**
   * Reset the active line: remove its override (worker-authoritative) and
   * reload the original source text. No-op when the line is not edited.
   */
  async function resetLine(): Promise<void> {
    const id = lineId.value
    if (id === null || !useEditsStore().isEdited(id)) return
    if (isEditing.value) cancelEdit()
    if (rawEditing.value) cancelRawEdit()
    try {
      await useEditsStore().resetEdit(id)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to reset the line'
      toastStore.error(message, 'Reset failed')
      return
    }
    if (selectionStore.activeLineId === id) {
      await load(id)
    }
  }

  function resetDetail(): void {
    loadToken += 1 // any in-flight answer becomes stale
    cancelEdit() // a selection change never carries a draft across rows
    cancelRawEdit()
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
    cancelEdit() // an open editor never carries across rows or reloads
    cancelRawEdit()
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
    editingPath,
    editDraft,
    isEditing,
    startEdit,
    cancelEdit,
    commitEdit,
    rawEditing,
    rawDraft,
    startRawEdit,
    cancelRawEdit,
    commitRawEdit,
    resetLine,
    resetDetail,
  }
})
