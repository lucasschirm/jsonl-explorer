/**
 * Keyboard focus policy helpers (TSK0036).
 *
 * Global shortcuts (Ctrl/Cmd+F, Enter-on-list) must NEVER hijack keys
 * from a control that owns them: a focused input, textarea, select, or
 * contenteditable keeps its native behavior, full stop.
 */

/** True when `target` is a control that owns its own keys. */
export function isEditableEventTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  )
}

/**
 * True while a daisyUI modal is open. Dialogs own their keys (Escape
 * closes them, Tab cycles within them); a page-level shortcut focusing
 * a control BEHIND an open dialog would move focus off the dialog.
 */
export function isModalOpen(): boolean {
  return document.querySelector('.modal-open') !== null
}
