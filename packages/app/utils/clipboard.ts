/**
 * Clipboard helper (TSK0025): copy actions with surfaced errors.
 *
 * Uses the async Clipboard API when available (secure contexts); falls
 * back to a hidden textarea + execCommand otherwise. Both paths REJECT
 * on failure so callers can show a typed error toast — copying must
 * never fail silently.
 */

export async function copyText(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  const el = document.createElement('textarea')
  el.value = text
  el.style.position = 'fixed'
  el.style.opacity = '0'
  document.body.appendChild(el)
  el.select()
  const ok = document.execCommand('copy')
  document.body.removeChild(el)
  if (!ok) throw new Error('Copy failed: the browser blocked clipboard access')
}
