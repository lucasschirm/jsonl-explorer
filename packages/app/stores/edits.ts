import { defineStore } from 'pinia'
import { ref, shallowRef } from 'vue'
import { useJsonlEngine } from '~/composables/useJsonlEngine'
import { ENGINE_DEFAULTS } from '~/engine/config/adr'

const encoder = new TextEncoder()

function byteLength(text: string): number {
  return encoder.encode(text).length
}

/** Typed edit failure: the text contains CR/LF (one row in, one row out). */
export class EditValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EditValidationError'
  }
}

/** Typed edit failure: the override exceeds the configured byte budget. */
export class EditBudgetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EditBudgetError'
  }
}

/**
 * Edit overrides (TSK0030) — main-thread mirror of the worker's
 * authoritative edit map, keyed by STABLE SOURCE LINE ID (never a display
 * position: filters reorder the view, line ids do not move).
 *
 * - The worker is authoritative: an override lands here only AFTER the
 *   worker accepted it (setEdit response), so filters, counts, selection,
 *   and export all see the same value (R3).
 * - The map is NON-deep-reactive on purpose: overrides can be large (up to
 *   the 1 MiB budget) and numerous; `shallowRef` swaps the Map reference
 *   and the `version` bump drives re-renders, without Vue walking every
 *   override's characters.
 * - Byte accounting: `usedBytes` mirrors the UTF-8 size of all overrides;
 *   `wouldExceedBudget` lets the editor UI warn before committing (PLAN:
 *   "warn before unusually large overrides").
 */
export const useEditsStore = defineStore('edits', () => {
  const engineApi = useJsonlEngine()

  /** 1-based lineId -> edited text (worker-accepted overrides only). */
  const overrides = shallowRef(new Map<number, string>())
  /** Bumped on every change: the reactivity signal for list/detail views. */
  const version = ref(0)
  /** UTF-8 bytes currently spent on overrides (budget accounting). */
  const usedBytes = ref(0)

  function validateText(text: string): void {
    if (text.includes('\r') || text.includes('\n')) {
      throw new EditValidationError(
        'An edit must remain a single line: newlines (CR/LF) are not allowed.',
      )
    }
  }

  /** True when committing `text` would exceed the single-override budget. */
  function wouldExceedBudget(lineId: number, text: string): boolean {
    return byteLength(text) > ENGINE_DEFAULTS.editMaxBytes
  }

  /**
   * Set an override for `lineId`. Validates locally (fast, typed), mirrors
   * to the worker (authoritative), and only on success updates the local
   * map — a rejected edit never leaks into the UI.
   */
  async function setEdit(lineId: number, text: string): Promise<void> {
    validateText(text)
    if (wouldExceedBudget(lineId, text)) {
      throw new EditBudgetError(
        `This edit exceeds the ${ENGINE_DEFAULTS.editMaxBytes / (1024 * 1024)} MiB budget. ` +
          'Shorten it or export instead.',
      )
    }
    const engine = engineApi.getEngine()
    await engine.setEdit(lineId, text)
    const next = new Map(overrides.value)
    next.set(lineId, text)
    overrides.value = next
    usedBytes.value = [...next.values()].reduce((sum, t) => sum + byteLength(t), 0)
    version.value += 1
  }

  /** Remove the override for `lineId` (reset to the source row). */
  async function resetEdit(lineId: number): Promise<void> {
    const engine = engineApi.getEngine()
    await engine.setEdit(lineId)
    if (overrides.value.has(lineId)) {
      const next = new Map(overrides.value)
      next.delete(lineId)
      overrides.value = next
      usedBytes.value = [...next.values()].reduce((sum, t) => sum + byteLength(t), 0)
      version.value += 1
    }
  }

  /** True when the row currently has an accepted override. */
  function isEdited(lineId: number): boolean {
    return overrides.value.has(lineId)
  }

  /** The accepted override text for a row (undefined when unedited). */
  function get(lineId: number): string | undefined {
    return overrides.value.get(lineId)
  }

  /** Drop every override (new source: line ids no longer refer to rows). */
  function resetEdits(): void {
    if (overrides.value.size === 0 && usedBytes.value === 0) return
    overrides.value = new Map()
    usedBytes.value = 0
    version.value += 1
  }

  return {
    overrides,
    version,
    usedBytes,
    setEdit,
    resetEdit,
    isEdited,
    get,
    wouldExceedBudget,
    resetEdits,
  }
})
