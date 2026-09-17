/**
 * JSONL Worker - Type declarations for browser APIs
 */

// OPFS types
interface FileSystemSyncAccessHandle {
  read(buffer: Uint8Array, options?: { at?: number }): number
  write(buffer: Uint8Array, options?: { at?: number }): number
  getSize(): number
  close(): void
  truncate(size: number): void
}

interface FileSystemFileHandle {
  createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle>
}

interface FileSystemDirectoryHandle {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle>
  removeEntry(name: string): Promise<void>
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FileSystemDirectoryHandle>
}

interface StorageManager {
  getDirectory(): Promise<FileSystemDirectoryHandle>
}

interface Navigator {
  storage: StorageManager
}

// jq-web 0.5.x WASM build (CJS UMD glue, jq.wasm.js + jq.wasm.wasm):
// the real module surface. See engine/jq.ts — the only module that
// imports it. The main export (asm.js bundle) is deliberately NOT used;
// see the TSK0027 build-choice notes in that file.
declare module 'jq-web/jq.wasm.js' {
  interface JqWebModule {
    /** Runs `filter` over `input`; returns one value, or an array when the filter emits multiple outputs. */
    json(input: unknown, filter: string): unknown
    /** Runs `filter` over a stream of JSON texts; returns the raw output (may be ''). */
    raw(input: string, filter: string, flags?: string[]): string
    onInitialized: { addListener(cb: () => void): void }
    promised: {
      json(input: unknown, filter: string): Promise<unknown>
      raw(input: string, filter: string, flags?: string[]): Promise<string>
    }
  }
  const jq: JqWebModule
  export default jq
}

// Global performance.now() in worker
declare const performance: {
  now(): number
}