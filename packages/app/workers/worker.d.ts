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

// jq-web declaration
declare module 'jq-web' {
  export function compile(query: string): Promise<(input: any) => any[]>
}

// Global performance.now() in worker
declare const performance: {
  now(): number
}