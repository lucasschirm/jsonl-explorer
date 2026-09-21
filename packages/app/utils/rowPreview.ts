/**
 * Row-preview helpers (TSK0021).
 *
 * List rows show a single-line, escaped PREVIEW (capped to a byte limit by
 * the worker); the full row is fetched separately via getLine and is never
 * escaped (the detail panel parses it as JSON).
 */

/**
 * Escape C0 control characters and DEL so a preview always renders as a
 * single line (PLAN 4.3: "single-line escaped/truncated"). Printable
 * characters — including Unicode — pass through unchanged.
 *
 * @param text decoded row text (may contain control characters)
 * @returns the same text with every C0/DEL char as a `\u00XX` escape
 */
export function escapeForSingleLine(text: string): string {
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    if (code < 0x20 || code === 0x7f) {
      out += `\\u${code.toString(16).padStart(4, '0')}`
    } else {
      out += ch
    }
  }
  return out
}
