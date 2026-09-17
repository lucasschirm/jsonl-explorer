/**
 * File intake decisions for local file picker / drag-and-drop.
 *
 * Pure functions, kept out of the component so every edge case (multiple
 * files, zero-byte, unusual extensions, directory / non-file drops) is
 * unit-testable without the DOM. The component only maps the returned
 * decisions onto toasts and the engine; no file bytes are read here or
 * anywhere outside the worker.
 */

/** A message the UI should surface while still (or instead of) opening. */
export interface IntakeNotice {
  kind: 'info' | 'warning'
  message: string
}

/** Extensions we recognize as text-like. Anything else is warned, never rejected. */
export const KNOWN_TEXT_EXTENSIONS = ['.jsonl', '.json', '.ndjson', '.txt'] as const

/** Lowercased extension including the dot, or '' when the name has none. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  // dot <= 0: no extension or a bare dotfile like ".env".
  return dot <= 0 ? '' : name.slice(dot).toLowerCase()
}

/** True when the name has an extension we do not recognize as text-like. */
export function isUnusualExtension(name: string): boolean {
  const ext = extensionOf(name)
  return ext !== '' && !(KNOWN_TEXT_EXTENSIONS as readonly string[]).includes(ext)
}

/** Outcome of normalizing a picked/dropped file list. */
export type FileIntake =
  | { kind: 'none' }
  | { kind: 'reject-empty'; file: File; notice: IntakeNotice }
  | { kind: 'ready'; file: File; notices: IntakeNotice[] }

/**
 * Picks the file to open from a (possibly multi-file) selection.
 *
 * - multiple files → first file wins, with a warning notice
 * - zero-byte file → rejected (cannot be indexed)
 * - unusual extension → warning notice, still opened
 */
export function decideFilePick(files: ArrayLike<File>): FileIntake {
  const file = files[0]
  if (!file) return { kind: 'none' }

  const notices: IntakeNotice[] = []
  if (files.length > 1) {
    notices.push({
      kind: 'warning',
      message: `Multiple files selected — using the first one (${file.name}).`,
    })
  }

  if (file.size === 0) {
    return {
      kind: 'reject-empty',
      file,
      notice: { kind: 'warning', message: `"${file.name}" is empty (0 bytes) and cannot be opened.` },
    }
  }

  if (isUnusualExtension(file.name)) {
    notices.push({
      kind: 'warning',
      message: `Extension "${extensionOf(file.name)}" is unusual for JSONL — opening anyway (content is checked while indexing).`,
    })
  }

  return { kind: 'ready', file, notices }
}

/** What a drop actually contained. */
export type DropIntake =
  | { kind: 'directory' }
  | { kind: 'non-file' }
  | { kind: 'files'; files: File[] }

/**
 * Classifies a drag-and-drop payload before any file is opened.
 *
 * Directory entries are detected via the (non-standard)
 * `DataTransferItem.webkitGetAsEntry`; drops with no file entries at all
 * (plain text, links) are `non-file`.
 */
export function decideDrop(items: ArrayLike<DataTransferItem> | null, files: ArrayLike<File> | null): DropIntake {
  if (items) {
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i]
      if (!item || item.kind !== 'file') continue
      const entry = (item as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry
        ?.()
      if (entry?.isDirectory) return { kind: 'directory' }
    }
  }
  if (!files || files.length === 0) return { kind: 'non-file' }
  return { kind: 'files', files: Array.from(files) }
}
