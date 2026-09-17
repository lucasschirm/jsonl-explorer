import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { useDetailStore } from '~/stores/detail'
import { useToastStore } from '~/stores/toasts'
import { useJsonlEngine } from '~/composables/useJsonlEngine'
import { EngineRpcError } from '~/engine/workerClient'
import { findTreeMatches, pathKey, ancestorKeys } from '~/utils/detailSearch'
import type { TreeMatch } from '~/utils/detailSearch'

export type DetailSearchMode = 'text' | 'jq'

/** State of the last (or in-flight) local jq run. */
export type JqRunState = 'idle' | 'running' | 'done' | 'error'

/**
 * Local document search (TSK0033): the right-toolbar search over the
 * SELECTED document only — never the left-side whole-file filter.
 *
 * - TEXT mode is fully local and synchronous: `findTreeMatches` walks the
 *   parsed tree (literal, case-sensitive; keys and primitive values) and
 *   navigation (next/prev, wrap-around) is index math. No RPC is ever
 *   posted, and nothing here touches the filter store or its counts.
 * - JQ mode runs the program in the WORKER (it owns the jq backend)
 *   against a SNAPSHOT of the document text. Staleness is guarded here:
 *   an execution sequence number plus the row id + text captured at send
 *   time — an answer that no longer refers to the current document is
 *   discarded silently (it is stale, not an error).
 * - Results clear on every selection change or document change (an edit
 *   reloads the text, which the watcher sees).
 * - Failures are typed and non-storming: a jq run is user-initiated (one
 *   Run click), so a failure posts exactly one toast.
 */
export const useDetailSearchStore = defineStore('detailSearch', () => {
  const detailStore = useDetailStore()
  const toastStore = useToastStore()
  const engineApi = useJsonlEngine()

  const mode = ref<DetailSearchMode>('text')
  const query = ref('')
  /** Bumped on every new run and on every reset: in-flight answers with
   *  an older sequence are stale and ignored. */
  let executionSeq = 0

  // ---- text mode (synchronous, local) ------------------------------------
  /** Matches for the current query against the current document (render
   *  order). Empty for non-tree rows (invalid / unconfirmed) or no query. */
  const matches = computed<TreeMatch[]>(() => {
    if (mode.value !== 'text' || query.value === '') return []
    const parsed = detailStore.parsed
    if (parsed === null || !parsed.ok) return []
    return findTreeMatches(parsed.value, query.value)
  })
  /** Set of path keys that should be highlighted. */
  const matchKeys = computed(() => new Set(matches.value.map((m) => pathKey(m.path))))
  /** Index of the match the navigation is pointing at (-1 = none yet). */
  const currentIndex = ref(-1)
  const currentMatch = computed<TreeMatch | null>(() => {
    if (currentIndex.value < 0) return null
    return matches.value[currentIndex.value] ?? null
  })
  /** Path key of the current match (null = nothing to highlight). */
  const currentKey = computed(() => (currentMatch.value ? pathKey(currentMatch.value.path) : null))
  /** Ancestor path keys the tree must auto-expand for the current match. */
  const expandKeys = computed(() =>
    currentMatch.value ? new Set(ancestorKeys(currentMatch.value.path)) : new Set<string>(),
  )

  function next(): void {
    if (matches.value.length === 0) return
    currentIndex.value = (currentIndex.value + 1) % matches.value.length
  }

  function prev(): void {
    const count = matches.value.length
    if (count === 0) return
    // No current match (-1) or already at the first: wrap to the last.
    currentIndex.value = currentIndex.value <= 0 ? count - 1 : currentIndex.value - 1
  }

  // ---- jq mode (async, worker) -------------------------------------------
  const jqState = ref<JqRunState>('idle')
  /** All outputs of the last completed run, in jq emission order. */
  const jqOutputs = ref<unknown[]>([])
  /** Human message of the last failed run (null when none). */
  const jqError = ref<string | null>(null)
  /** Collapsible output pane (opens on a successful run). */
  const jqPaneOpen = ref(false)

  /** Clear jq results and invalidate any in-flight run. */
  function resetJq(): void {
    executionSeq += 1
    jqState.value = 'idle'
    jqOutputs.value = []
    jqError.value = null
    jqPaneOpen.value = false
  }

  /**
   * Run the program against the selected document (user-initiated: the
   * Run control). One toast per failed run — never a storm.
   */
  async function runJq(): Promise<void> {
    const parsed = detailStore.parsed
    const lineId = detailStore.lineId
    const text = detailStore.text
    const program = query.value.trim()
    if (parsed === null || !parsed.ok || lineId === null || text === null || program === '') return

    const seq = ++executionSeq
    jqState.value = 'running'
    jqError.value = null
    try {
      const result = await engineApi.getEngine().runJq({ lineId, program, text })
      // Stale: a newer run started, or the selection/document changed
      // while the RPC was in flight — discard silently (not an error).
      if (
        seq !== executionSeq ||
        detailStore.lineId !== lineId ||
        detailStore.text !== text
      ) {
        return
      }
      jqOutputs.value = result.outputs
      jqState.value = 'done'
      jqPaneOpen.value = true
    } catch (error) {
      if (seq !== executionSeq) return // superseded: the newer run owns toasts
      jqState.value = 'error'
      const message =
        error instanceof EngineRpcError || error instanceof Error
          ? error.message
          : 'Failed to run jq'
      jqError.value = message
      toastStore.error(message, 'jq search failed')
    }
  }

  // ---- clearing on selection / document change ---------------------------
  /** A new row, a reloaded (edited) document, or an idle panel: both the
   *  navigation pointer and the jq results stop referring to what is on
   *  screen, so both are cleared. */
  watch(
    () => [detailStore.lineId, detailStore.text, detailStore.status],
    () => {
      currentIndex.value = -1
      resetJq()
    },
  )
  /** Editing the query invalidates the navigation pointer (the match list
   *  changes under the finger). */
  watch(query, () => {
    currentIndex.value = -1
  })

  return {
    mode,
    query,
    matches,
    matchKeys,
    currentIndex,
    currentMatch,
    currentKey,
    expandKeys,
    next,
    prev,
    jqState,
    jqOutputs,
    jqError,
    jqPaneOpen,
    runJq,
  }
})
