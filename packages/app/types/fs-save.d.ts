/**
 * TS 5.9's lib.dom declares the File System API handles
 * (`FileSystemFileHandle`, `createWritable`, `FileSystemWritableFileStream`)
 * but NOT `showSaveFilePicker` — the File System ACCESS entry point. Chrome
 * ≥119/Edge ship it; Firefox and Safari do not (they take the Blob
 * fallback — TSK0001 support policy). This declaration matches the shipped
 * signature so the FSA path typechecks without `any`.
 */

declare global {
  interface Window {
    /**
     * Prompts the user to choose a file path and returns its handle.
     * Rejects with an `AbortError` when the user cancels the picker.
     * `undefined` in browsers without the File System Access API.
     */
    showSaveFilePicker?: (options?: {
      suggestedName?: string
      types?: Array<{
        description?: string
        accept: Record<string, string[]>
      }>
    }) => Promise<FileSystemFileHandle>
  }
}

export {}
