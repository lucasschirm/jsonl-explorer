/**
 * TS 5.9's lib.dom does not declare the async-iteration API
 * (`entries`/`keys`/`values`/`[Symbol.asyncIterator]`) on
 * `FileSystemDirectoryHandle`, even though the File System Standard ships it
 * and every target browser (Chrome ≥119, Firefox ≥120, Safari ≥17.2)
 * implements it. This augmentation matches the spec signatures so
 * `for await (const entry of dir)` typechecks against real OPFS roots.
 */

declare global {
  interface FileSystemDirectoryHandle {
    /** Async iterator over the directory's entries. */
    values(): AsyncIterableIterator<FileSystemHandle>
  }
}

export {}
