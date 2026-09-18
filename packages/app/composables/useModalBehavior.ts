/**
 * Shared modal-dialog a11y behavior (TSK0052).
 *
 * One implementation of: initial focus, focus trap, Escape-to-close,
 * background scroll lock, and focus restoration. Used by Modal.vue and
 * UrlOpenModal.vue so the behavior is identical and never duplicated.
 *
 * Stacked dialogs: when several role=dialog elements are open at once
 * (e.g. the OPFS-fallback consent over the URL modal, TSK0047), only the
 * TOPMOST one — the last in DOM order — reacts to Escape. The others
 * stay open underneath.
 */
import { onMounted, onUnmounted, watch, nextTick, ref, type Ref } from 'vue'

const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

export interface ModalBehaviorOptions {
  /** When false, Escape is ignored (e.g. while an in-flight load runs
   *  and the modal's own Cancel control is disabled). */
  canEscape?: () => boolean
}

/**
 * Number of currently engaged modal behaviors. The scroll lock is shared:
 * stacked modals must not release it while another modal is still open.
 */
let engagedCount = 0
let previousOverflow = ''

export function useModalBehavior(
  isOpen: () => boolean,
  onEscape: () => void,
  options: ModalBehaviorOptions = {},
): { modalRef: Ref<HTMLElement | null> } {
  const modalRef = ref<HTMLElement | null>(null)
  let previousActiveElement: HTMLElement | null = null

  function focusable(): HTMLElement[] {
    return Array.from(
      modalRef.value?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [],
    )
  }

  /** True when this dialog is the topmost open dialog (last in DOM order). */
  function isTopmost(): boolean {
    const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'))
    return dialogs[dialogs.length - 1] === modalRef.value
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      if (!isTopmost()) return
      if (options.canEscape !== undefined && !options.canEscape()) return
      onEscape()
      return
    }
    if (event.key !== 'Tab') return
    // The trap only constrains focus while it is inside THIS dialog; a
    // dialog stacked on top owns the trap while focus is in it.
    const elements = focusable()
    if (elements.length === 0) return
    const first = elements[0]!
    const last = elements[elements.length - 1]!
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  function engage(): void {
    previousActiveElement = (document.activeElement as HTMLElement | null) ?? null
    document.addEventListener('keydown', handleKeydown)
    engagedCount++
    if (engagedCount === 1) {
      previousOverflow = document.body.style.overflow || ''
      // setProperty (not the `style.overflow =` setter): happy-dom
      // corrupts the style object when an inline property is CLEARED
      // ('' / removeProperty) and re-assigned — a latent test-env trap.
      document.body.style.setProperty('overflow', 'hidden')
    }
    void nextTick(() => focusable()[0]?.focus())
  }

  function disengage(): void {
    document.removeEventListener('keydown', handleKeydown)
    engagedCount = Math.max(0, engagedCount - 1)
    if (engagedCount === 0) {
      document.body.style.setProperty('overflow', previousOverflow || 'visible')
    }
    previousActiveElement?.focus()
  }

  watch(isOpen, (open) => (open ? engage() : disengage()))
  onMounted(() => {
    if (isOpen()) engage()
  })
  onUnmounted(() => {
    if (isOpen()) disengage()
  })

  return { modalRef }
}
