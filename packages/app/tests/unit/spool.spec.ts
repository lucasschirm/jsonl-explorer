/**
 * TSK0014 — OPFS spool storage and paged-memory fallback.
 *
 * Covers:
 * - `PagedMemoryStore` (page math, bounded memory, clamping, lifecycle)
 * - `OpfsSpool` (append/read round-trip, quota mapping, artifact removal)
 *   against a fake OPFS root (happy-dom has no OPFS)
 * - `estimateStorageQuota`
 * - spool session naming + `cleanupStaleSpools`
 * - `SpoolSource` adaptation
 * - `UrlDownloader` (backend selection, consent gate, R12 indeterminate
 *   progress, mid-stream quota re-fetch, abort/failure cleanup)
 * - worker `initUrl` integration (consent handshake over postMessage,
 *   operation-scoped cancel)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Mock } from 'vitest'

import { ENGINE_DEFAULTS } from '../../engine/config/adr.js'
import {
  FallbackDeclinedError,
  PagedMemoryStore,
  OpfsSpool,
  OPFS_PART_SIZE_BYTES,
  SpoolQuotaExceededError,
  SpoolDisposedError,
  SpoolSealedError,
  SpoolSource,
  UrlDownloader,
  UrlFetchError,
  cleanupStaleSpools,
  createSpoolSessionName,
  estimateStorageQuota,
  urlFileName,
  SPOOL_ARTIFACT_PREFIX,
} from '../../engine/spool/index.js'
import type {
  StorageEstimateProvider,
  UrlFallbackInfo,
} from '../../engine/spool/index.js'

import {
  FakeDirHandle,
  bytesEqual,
  encode,
  makeFakeStorage,
  makeFetch,
  patternBytes,
  splitBytes,
} from '../helpers/spoolFakes.js'

// ============================================================================
// PagedMemoryStore
// ============================================================================

describe('PagedMemoryStore', () => {
  it('appends across page boundaries and reads back exact bytes', async () => {
    const store = new PagedMemoryStore({ artifactName: 't', pageSizeBytes: 16 })
    const data = patternBytes(30)
    await store.append(data.slice(0, 5))
    await store.append(data.slice(5, 21))
    await store.append(data.slice(21))
    expect(await store.getSize()).toBe(30n)
    expect(bytesEqual(await store.readRange(0, 30), data)).toBe(true)
  })

  it('reads spanning multiple pages', async () => {
    const store = new PagedMemoryStore({ artifactName: 't', pageSizeBytes: 16 })
    const data = patternBytes(40)
    await store.append(data)
    expect(bytesEqual(await store.readRange(12, 8), data.slice(12, 20))).toBe(true)
    expect(bytesEqual(await store.readRange(24, 16), data.slice(24, 40))).toBe(true)
  })

  it('clamps reads at EOF and rejects negative offsets (source contract)', async () => {
    const store = new PagedMemoryStore({ artifactName: 't', pageSizeBytes: 8 })
    const data = patternBytes(20)
    await store.append(data)
    expect(bytesEqual(await store.readRange(18, 100), data.slice(18))).toBe(true)
    expect((await store.readRange(25, 10)).length).toBe(0)
    await expect(store.readRange(-5, 10)).rejects.toThrow(RangeError)
  })

  it('bounds memory by data plus at most one page (no concat)', async () => {
    const pageSize = 16
    const store = new PagedMemoryStore({ artifactName: 't', pageSizeBytes: pageSize })
    const total = 3000
    await store.append(patternBytes(total))
    expect(store.getMemoryBytes()).toBe(Math.ceil(total / pageSize) * pageSize)
    expect(store.getMemoryBytes() - total).toBeLessThanOrEqual(pageSize)
    // Appends across many small chunks stay bounded and byte-exact.
    const store2 = new PagedMemoryStore({ artifactName: 't2', pageSizeBytes: pageSize })
    const data = patternBytes(100)
    for (let i = 0; i < data.length; i += 3) await store2.append(data.slice(i, i + 3))
    expect(store2.getMemoryBytes()).toBe(Math.ceil(100 / pageSize) * pageSize)
    expect(bytesEqual(await store2.readRange(0, 100), data)).toBe(true)
  })

  it('uses the ADR default page size (256 KiB) when unspecified', () => {
    const store = new PagedMemoryStore({ artifactName: 't' })
    expect(store.pageSizeBytes).toBe(ENGINE_DEFAULTS.spoolPageSizeBytes)
    expect(ENGINE_DEFAULTS.spoolPageSizeBytes).toBe(256 * 1024)
  })

  it('rejects non-positive page sizes', () => {
    expect(() => new PagedMemoryStore({ artifactName: 't', pageSizeBytes: 0 })).toThrow(RangeError)
  })

  it('rejects appends after seal with SpoolSealedError', async () => {
    const store = new PagedMemoryStore({ artifactName: 't', pageSizeBytes: 8 })
    await store.append(patternBytes(4))
    await store.seal()
    await expect(store.seal()).resolves.toBeUndefined() // idempotent
    await expect(store.append(new Uint8Array(1))).rejects.toBeInstanceOf(SpoolSealedError)
  })

  it('guards operations after dispose with SpoolDisposedError (idempotent dispose)', async () => {
    const store = new PagedMemoryStore({ artifactName: 't' })
    await store.append(patternBytes(4))
    await store.dispose()
    await expect(store.dispose()).resolves.toBeUndefined()
    await expect(store.getSize()).rejects.toBeInstanceOf(SpoolDisposedError)
    await expect(store.readRange(0, 1)).rejects.toBeInstanceOf(SpoolDisposedError)
    await expect(store.append(new Uint8Array(1))).rejects.toBeInstanceOf(SpoolDisposedError)
  })

  it('ignores empty appends without growing pages', async () => {
    const store = new PagedMemoryStore({ artifactName: 't', pageSizeBytes: 8 })
    await store.append(new Uint8Array(0))
    expect(await store.getSize()).toBe(0n)
    expect(store.getMemoryBytes()).toBe(0)
  })
})

// ============================================================================
// OpfsSpool
// ============================================================================

describe('OpfsSpool', () => {
  const PART = OPFS_PART_SIZE_BYTES

  it('appends chunks, reports size, and reads back exact bytes', async () => {
    const { root } = makeFakeStorage()
    const spool = await OpfsSpool.create('spool-test.jsonl', {
      rootDirectory: root as unknown as FileSystemDirectoryHandle,
    })
    const data = patternBytes(1000)
    for (const chunk of splitBytes(data, [333, 333, 334])) {
      await spool.append(chunk)
    }
    expect(spool.kind).toBe('opfs')
    expect(await spool.getSize()).toBe(1000n)
    expect(bytesEqual(await spool.readRange(0, 1000), data)).toBe(true)
    expect(bytesEqual(await spool.readRange(333, 1), data.slice(333, 334))).toBe(true)
    // Below one part: nothing is flushed to disk yet (RAM pending).
    expect(root.entries.size).toBe(0)
    await spool.dispose()
  })

  it('mid-stream reads see every appended byte (RAM pending buffer)', async () => {
    // The indexer reads via readRange WHILE the URL download streams. Real
    // OPFS only exposes CLOSED writes through getFile(), so unflushed
    // bytes are served from the RAM pending buffer: every append is
    // immediately readable, before any seal (regression, TSK0039/TSK0046).
    const { root } = makeFakeStorage()
    const spool = await OpfsSpool.create('spool-midstream.jsonl', {
      rootDirectory: root as unknown as FileSystemDirectoryHandle,
    })
    const chunks = splitBytes(patternBytes(1000), [333, 333, 334])
    let offset = 0n
    for (const chunk of chunks) {
      await spool.append(chunk)
      // Read immediately, before any seal: the bytes must be visible.
      expect(await spool.getSize()).toBe(offset + BigInt(chunk.length))
      expect(bytesEqual(await spool.readRange(offset, chunk.length), chunk)).toBe(true)
      offset += BigInt(chunk.length)
    }
    expect(bytesEqual(await spool.readRange(0, 1000), patternBytes(1000))).toBe(true)
    await spool.dispose()
  })

  it('flushes 1 MiB part files and reads exact bytes across part + pending boundaries', async () => {
    // Regression (TSK0046): the old close-per-append design used
    // createWritable({ keepExistingData: true }), which in real OPFS
    // OVERWRITES at offset 0 — every append clobbered the file\'s
    // beginning and multi-chunk URL loads silently lost all but the last
    // chunk. Parts are written exactly once and never rewritten.
    const { root } = makeFakeStorage()
    const spool = await OpfsSpool.create('spool-parts.jsonl', {
      rootDirectory: root as unknown as FileSystemDirectoryHandle,
    })
    const data = patternBytes(2 * PART + 123_456)
    // 1 MiB chunks: each append fills exactly one part (last stays RAM).
    for (let off = 0; off < data.length; off += PART) {
      await spool.append(data.slice(off, Math.min(off + PART, data.length)))
    }
    expect(await spool.getSize()).toBe(BigInt(data.length))
    // Two parts on disk + the 123,456-byte tail in RAM.
    expect(root.entries.size).toBe(2)
    const partNames = [...root.entries.keys()].sort()
    expect(partNames).toEqual(['spool-parts.jsonl-p0', 'spool-parts.jsonl-p1'])
    // Each part file holds EXACTLY its slice, written once.
    const part0 = root.entries.get('spool-parts.jsonl-p0') as unknown as {
      data: Uint8Array
      closedWritables: number
    }
    const part1 = root.entries.get('spool-parts.jsonl-p1') as unknown as {
      data: Uint8Array
      closedWritables: number
    }
    expect(bytesEqual(part0.data, data.slice(0, PART))).toBe(true)
    expect(bytesEqual(part1.data, data.slice(PART, 2 * PART))).toBe(true)
    expect(part0.closedWritables).toBe(1)
    expect(part1.closedWritables).toBe(1)
    // Reads: within a part, across the part boundary, and into the RAM tail.
    expect(bytesEqual(await spool.readRange(0, PART), data.slice(0, PART))).toBe(true)
    // (offset, LENGTH — not an end offset)
    expect(
      bytesEqual(await spool.readRange(PART - 10, 20), data.slice(PART - 10, PART + 10)),
    ).toBe(true)
    expect(
      bytesEqual(
        await spool.readRange(2 * PART, 123_456),
        data.slice(2 * PART),
      ),
    ).toBe(true)
    expect(bytesEqual(await spool.readRange(0, data.length), data)).toBe(true)
    await spool.dispose()
  })

  it('a single chunk larger than one part produces multiple parts', async () => {
    const { root } = makeFakeStorage()
    const spool = await OpfsSpool.create('spool-big.jsonl', {
      rootDirectory: root as unknown as FileSystemDirectoryHandle,
    })
    const data = patternBytes(PART * 3 + 7)
    await spool.append(data)
    expect(root.entries.size).toBe(3)
    expect(await spool.getSize()).toBe(BigInt(data.length))
    expect(bytesEqual(await spool.readRange(0, data.length), data)).toBe(true)
    expect(
      bytesEqual(await spool.readRange(PART * 3, 7), data.slice(PART * 3)),
    ).toBe(true)
    await spool.dispose()
  })

  it('clamps reads at EOF and returns empty beyond size', async () => {
    const { root } = makeFakeStorage()
    const spool = await OpfsSpool.create('spool-clamp.jsonl', {
      rootDirectory: root as unknown as FileSystemDirectoryHandle,
    })
    const data = patternBytes(10)
    await spool.append(data)
    expect(bytesEqual(await spool.readRange(8, 100), data.slice(8))).toBe(true)
    expect((await spool.readRange(10, 5)).length).toBe(0)
    expect((await spool.readRange(99, 5)).length).toBe(0)
    await spool.dispose()
  })

  it('maps QuotaExceededError part flushes to SpoolQuotaExceededError and removes the partial part', async () => {
    const { root } = makeFakeStorage()
    root.quotaLimit = 10
    const spool = await OpfsSpool.create('spool-quota.jsonl', {
      rootDirectory: root as unknown as FileSystemDirectoryHandle,
    })
    // One full part triggers a flush; the fake quota (10 B) rejects it.
    await expect(spool.append(patternBytes(PART))).rejects.toBeInstanceOf(SpoolQuotaExceededError)
    // The failed append did not count toward the spool size, and no
    // partial part file is left behind.
    expect(await spool.getSize()).toBe(0n)
    expect(root.entries.size).toBe(0)
    await spool.dispose()
  })

  it('seal prevents further appends; seal is idempotent', async () => {
    const { root } = makeFakeStorage()
    const spool = await OpfsSpool.create('spool-seal.jsonl', {
      rootDirectory: root as unknown as FileSystemDirectoryHandle,
    })
    await spool.append(patternBytes(4))
    await spool.seal()
    await expect(spool.seal()).resolves.toBeUndefined() // idempotent
    await expect(spool.append(new Uint8Array(1))).rejects.toBeInstanceOf(SpoolSealedError)
    await spool.dispose()
  })

  it('dispose removes every part and is idempotent; ops after dispose reject', async () => {
    const { root } = makeFakeStorage()
    const spool = await OpfsSpool.create('spool-dipose.jsonl', {
      rootDirectory: root as unknown as FileSystemDirectoryHandle,
    })
    await spool.append(patternBytes(PART + 4)) // 1 part + RAM tail
    expect(root.entries.size).toBe(1)
    await spool.dispose()
    expect(root.entries.size).toBe(0)
    await expect(spool.dispose()).resolves.toBeUndefined()
    await expect(spool.getSize()).rejects.toBeInstanceOf(SpoolDisposedError)
    await expect(spool.readRange(0, 1)).rejects.toBeInstanceOf(SpoolDisposedError)
  })

  it('dispose tolerates a missing part (not-found)', async () => {
    const { root } = makeFakeStorage()
    const spool = await OpfsSpool.create('spool-missing.jsonl', {
      rootDirectory: root as unknown as FileSystemDirectoryHandle,
    })
    await spool.append(patternBytes(PART))
    root.entries.clear()
    await expect(spool.dispose()).resolves.toBeUndefined()
  })

  it('rejects when OPFS is unavailable and no root is injected', async () => {
    await expect(OpfsSpool.create('spool-x.jsonl')).rejects.toThrow(/OPFS is unavailable/)
  })
})

// ============================================================================
// estimateStorageQuota
// ============================================================================

describe('estimateStorageQuota', () => {
  it('computes available = quota - usage', async () => {
    const provider: StorageEstimateProvider = {
      estimate: async () => ({ usage: 2048, quota: 10 * 1024 * 1024 }),
    }
    const result = await estimateStorageQuota(provider)
    expect(result).not.toBeNull()
    expect(result!.usageBytes).toBe(2048n)
    expect(result!.quotaBytes).toBe(10n * 1024n * 1024n)
    expect(result!.availableBytes).toBe(10n * 1024n * 1024n - 2048n)
  })

  it('clamps available at zero when usage exceeds quota', async () => {
    const provider: StorageEstimateProvider = { estimate: async () => ({ usage: 100, quota: 50 }) }
    const result = await estimateStorageQuota(provider)
    expect(result!.availableBytes).toBe(0n)
  })

  it('returns null when the API is missing, throws, or reports no quota', async () => {
    expect(await estimateStorageQuota(null)).toBeNull()
    expect(await estimateStorageQuota(undefined)).toBeNull()
    const throwing: StorageEstimateProvider = {
      estimate: async () => {
        throw new Error('nope')
      },
    }
    expect(await estimateStorageQuota(throwing)).toBeNull()
    const zero: StorageEstimateProvider = { estimate: async () => ({ usage: 0, quota: 0 }) }
    expect(await estimateStorageQuota(zero)).toBeNull()
  })
})

// ============================================================================
// Session naming + stale cleanup
// ============================================================================

describe('spool sessions', () => {
  it('creates unique spool-<uuid>.jsonl artifact names', () => {
    const a = createSpoolSessionName()
    const b = createSpoolSessionName()
    expect(a).toMatch(/^spool-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/)
    expect(b).toMatch(/^spool-/)
    expect(a).not.toBe(b)
  })

  it('cleanupStaleSpools removes only spool-* entries', async () => {
    const { root } = makeFakeStorage()
    const dir = root as unknown as FileSystemDirectoryHandle
    await (dir as unknown as FakeDirHandle).getFileHandle('spool-old1.jsonl', { create: true })
    await (dir as unknown as FakeDirHandle).getFileHandle('spool-old2.jsonl', { create: true })
    await (dir as unknown as FakeDirHandle).getFileHandle('user-data.jsonl', { create: true })
    const removed = await cleanupStaleSpools(dir)
    expect(removed).toBe(2)
    expect((dir as unknown as FakeDirHandle).entries.has('user-data.jsonl')).toBe(true)
    expect((dir as unknown as FakeDirHandle).entries.has('spool-old1.jsonl')).toBe(false)
    expect((dir as unknown as FakeDirHandle).entries.has('spool-old2.jsonl')).toBe(false)
  })

  it('cleanupStaleSpools tolerates concurrent removal', async () => {
    const { root } = makeFakeStorage()
    const fake = root as unknown as FakeDirHandle
    await fake.getFileHandle('spool-gone.jsonl', { create: true })
    const origRemove = fake.removeEntry.bind(fake)
    fake.removeEntry = async (name: string) => {
      if (name === 'spool-gone.jsonl') throw new DOMException('locked', 'InvalidStateError')
      return origRemove(name)
    }
    expect(await cleanupStaleSpools(root as unknown as FileSystemDirectoryHandle)).toBe(0)
  })
})

// ============================================================================
// SpoolSource
// ============================================================================

describe('SpoolSource', () => {
  it('delegates size, range reads, and disposal to the spool', async () => {
    const store = new PagedMemoryStore({ artifactName: 't', pageSizeBytes: 8 })
    const data = patternBytes(12)
    await store.append(data)
    const source = new SpoolSource('remote.jsonl', store)
    expect(source.name).toBe('remote.jsonl')
    expect(await source.getSize()).toBe(12n)
    expect(bytesEqual(await source.readRange(2, 4), data.slice(2, 6))).toBe(true)
    let disposed = false
    const origDispose = store.dispose.bind(store)
    store.dispose = async () => {
      disposed = true
      await origDispose()
    }
    await source.dispose()
    expect(disposed).toBe(true)
    await expect(source.getSize()).rejects.toBeInstanceOf(SpoolDisposedError)
  })
})

// ============================================================================
// UrlDownloader
// ============================================================================

describe('UrlDownloader', () => {
  const DATA = '[{"id":1}]\n[{"id":2}]\n'
  const PAYLOAD = encode(DATA)

  function consentRecorder() {
    const infos: UrlFallbackInfo[] = []
    const onFallbackRequest = async (info: UrlFallbackInfo): Promise<boolean> => {
      infos.push(info)
      return true
    }
    return { infos, onFallbackRequest }
  }

  it('streams into an OPFS spool with determinate progress (R12)', async () => {
    const { root, storage } = makeFakeStorage({ quota: 10 * 1024 * 1024 })
    const { impl, calls } = makeFetch(PAYLOAD, { chunks: [8, 10, 100] })
    const progress: { receivedBytes: number; totalBytes?: number }[] = []
    const downloader = new UrlDownloader({
      fetchImpl: impl,
      storage,
      onProgress: (p) => {
        progress.push(p)
      },
    })
    const result = await downloader.download('https://example.com/a/b/data.jsonl')
    expect(calls.length).toBe(1)
    expect(result.name).toBe('data.jsonl')
    expect(result.spool.kind).toBe('opfs')
    expect(result.declaredBytes).toBe(BigInt(PAYLOAD.length))
    expect(await result.spool.getSize()).toBe(BigInt(PAYLOAD.length))
    expect(bytesEqual(await result.spool.readRange(0, PAYLOAD.length), PAYLOAD)).toBe(true)
    // Below one 1 MiB part: bytes live in the RAM pending buffer, so no
    // part file exists yet (parts appear only once 1 MiB is flushed).
    expect((root as unknown as FakeDirHandle).entries.size).toBe(0)
    // Progress: cumulative, determinate (Content-Length, no encoding).
    expect(progress).toEqual([
      { receivedBytes: 8, totalBytes: PAYLOAD.length },
      { receivedBytes: 18, totalBytes: PAYLOAD.length },
      { receivedBytes: PAYLOAD.length, totalBytes: PAYLOAD.length },
    ])
    // Spool is sealed: further appends reject.
    await expect(result.spool.append(new Uint8Array(1))).rejects.toBeInstanceOf(SpoolSealedError)
    await downloader.dispose()
    expect([...(root as unknown as FakeDirHandle).entries.keys()].length).toBe(0)
  })

  it('falls back to RAM when OPFS is unavailable (consent accepted)', async () => {
    const { onFallbackRequest, infos } = consentRecorder()
    const { impl } = makeFetch(PAYLOAD, { noContentLength: true, chunks: [10, 18] })
    const downloader = new UrlDownloader({
      fetchImpl: impl,
      storage: null,
      onFallbackRequest,
    })
    const result = await downloader.download('https://example.com/x.jsonl')
    expect(result.spool.kind).toBe('memory')
    expect(bytesEqual(await result.spool.readRange(0, PAYLOAD.length), PAYLOAD)).toBe(true)
    expect(infos).toEqual([{ reason: 'opfs-unavailable', declaredBytes: undefined, receivedBytes: 0 }])
    await downloader.dispose()
  })

  it('declines the RAM fallback when no consent callback is provided', async () => {
    const { impl } = makeFetch(PAYLOAD, { noContentLength: true })
    const downloader = new UrlDownloader({ fetchImpl: impl, storage: null })
    await expect(downloader.download('https://example.com/x.jsonl')).rejects.toBeInstanceOf(
      FallbackDeclinedError,
    )
  })

  it('declines when the user rejects the consent handshake', async () => {
    const { impl } = makeFetch(PAYLOAD, { noContentLength: true })
    const downloader = new UrlDownloader({
      fetchImpl: impl,
      storage: null,
      onFallbackRequest: async () => false,
    })
    await expect(downloader.download('https://example.com/x.jsonl')).rejects.toBeInstanceOf(
      FallbackDeclinedError,
    )
  })

  it('skips consent for small declared sizes over quota (under threshold)', async () => {
    // Declared 22 bytes << 100 MiB consent threshold: RAM fallback is safe
    // without a handshake even though the declared size exceeds the (tiny)
    // fake quota.
    const { impl } = makeFetch(PAYLOAD, { chunks: [PAYLOAD.length] })
    let consented = 0
    const downloader = new UrlDownloader({
      fetchImpl: impl,
      storage: makeFakeStorage({ quota: 16 }).storage,
      onFallbackRequest: async () => {
        consented++
        return true
      },
    })
    const result = await downloader.download('https://example.com/x.jsonl')
    expect(result.spool.kind).toBe('memory')
    expect(result.declaredBytes).toBe(BigInt(PAYLOAD.length))
    expect(consented).toBe(0)
    await downloader.dispose()
  })

  it('requires consent for declared sizes above the consent threshold', async () => {
    const { onFallbackRequest, infos } = consentRecorder()
    const { impl } = makeFetch(PAYLOAD, { chunks: [PAYLOAD.length] })
    const downloader = new UrlDownloader({
      fetchImpl: impl,
      storage: makeFakeStorage({ quota: 16 }).storage,
      fallbackConsentThresholdBytes: 10,
      onFallbackRequest,
    })
    const result = await downloader.download('https://example.com/x.jsonl')
    expect(result.spool.kind).toBe('memory')
    expect(infos).toEqual([
      { reason: 'declared-size-over-quota', declaredBytes: PAYLOAD.length, receivedBytes: 0 },
    ])
    await downloader.dispose()
  })

  it('R12: content-encoding makes the size indeterminate (no declaredBytes, no totalBytes)', async () => {
    const { onFallbackRequest, infos } = consentRecorder()
    const { impl } = makeFetch(PAYLOAD, {
      noContentLength: true,
      headers: { 'content-encoding': 'gzip', 'content-length': '9999' },
      chunks: [28],
    })
    const progress: { receivedBytes: number; totalBytes?: number }[] = []
    const downloader = new UrlDownloader({
      fetchImpl: impl,
      storage: null,
      onFallbackRequest,
      onProgress: (p) => {
        progress.push(p)
      },
    })
    const result = await downloader.download('https://example.com/x.jsonl')
    expect(result.declaredBytes).toBeUndefined()
    expect(result.spool.kind).toBe('memory')
    expect(infos[0]!.declaredBytes).toBeUndefined()
    expect(progress[0]).toEqual({ receivedBytes: PAYLOAD.length, totalBytes: undefined })
    await downloader.dispose()
  })

  // Mid-stream quota failures surface when a PART FLUSH fails (parts are
  // the only thing written to disk), so these tests use part-scale data.
  const BIG = patternBytes(OPFS_PART_SIZE_BYTES + 8) // 1 part + 8-byte tail

  it('re-fetches into paged RAM when OPFS quota is exceeded mid-stream', async () => {
    const { root, storage } = makeFakeStorage({ quota: 10 * 1024 * 1024 })
    root.quotaLimit = 10 // the 1 MiB part flush overflows immediately
    const { onFallbackRequest, infos } = consentRecorder()
    const { impl, calls } = makeFetch(BIG, { chunks: [BIG.length] })
    const downloader = new UrlDownloader({
      fetchImpl: impl,
      storage,
      onFallbackRequest,
    })
    const result = await downloader.download('https://example.com/x.jsonl')
    expect(calls.length).toBe(2) // original + re-fetch
    expect(result.spool.kind).toBe('memory')
    expect(bytesEqual(await result.spool.readRange(0, BIG.length), BIG)).toBe(true)
    // Declared size < consent threshold: RAM fallback is auto-accepted.
    expect(infos).toEqual([])
    // The partial OPFS part was removed; nothing left behind.
    expect([...(root as unknown as FakeDirHandle).entries.keys()].length).toBe(0)
    await downloader.dispose()
  })

  it('asks for consent on a mid-stream quota fallback when the size is unknown', async () => {
    const { root, storage } = makeFakeStorage({ quota: 10 * 1024 * 1024 })
    root.quotaLimit = 10
    const { onFallbackRequest, infos } = consentRecorder()
    const { impl, calls } = makeFetch(BIG, { noContentLength: true, chunks: [BIG.length] })
    const downloader = new UrlDownloader({
      fetchImpl: impl,
      storage,
      onFallbackRequest,
    })
    const result = await downloader.download('https://example.com/x.jsonl')
    expect(calls.length).toBe(2)
    expect(result.spool.kind).toBe('memory')
    expect(bytesEqual(await result.spool.readRange(0, BIG.length), BIG)).toBe(true)
    // The failed flush had not committed any part: 0 spooled bytes.
    expect(infos).toEqual([
      { reason: 'opfs-quota-exceeded', declaredBytes: undefined, receivedBytes: 0 },
    ])
    expect([...(root as unknown as FakeDirHandle).entries.keys()].length).toBe(0)
    await downloader.dispose()
  })

  it('propagates decline after a mid-stream quota failure and removes the partial part', async () => {
    const { root, storage } = makeFakeStorage({ quota: 10 * 1024 * 1024 })
    root.quotaLimit = 10
    const { impl, calls } = makeFetch(BIG, { noContentLength: true, chunks: [BIG.length] })
    const downloader = new UrlDownloader({
      fetchImpl: impl,
      storage,
      onFallbackRequest: async () => false,
    })
    await expect(downloader.download('https://example.com/x.jsonl')).rejects.toBeInstanceOf(
      FallbackDeclinedError,
    )
    expect(calls.length).toBe(1) // no re-fetch after decline
    expect([...(root as unknown as FakeDirHandle).entries.keys()].length).toBe(0)
  })

  it('aborts the stream and removes the partial artifact', async () => {
    const { root, storage } = makeFakeStorage()
    const controller = new AbortController()
    const { impl } = makeFetch(PAYLOAD, {
      chunks: [8, 10, 100],
      onRead: (index) => {
        if (index === 1) controller.abort()
      },
    })
    const downloader = new UrlDownloader({ fetchImpl: impl, storage, signal: controller.signal })
    await expect(downloader.download('https://example.com/x.jsonl')).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect([...(root as unknown as FakeDirHandle).entries.keys()].length).toBe(0)
  })

  it('wraps network failures in UrlFetchError and leaves no artifact', async () => {
    const { root, storage } = makeFakeStorage()
    const { impl } = makeFetch(PAYLOAD, { networkError: true })
    const downloader = new UrlDownloader({ fetchImpl: impl, storage })
    const promise = downloader.download('https://example.com/x.jsonl')
    await expect(promise).rejects.toBeInstanceOf(UrlFetchError)
    expect([...(root as unknown as FakeDirHandle).entries.keys()].length).toBe(0)
  })

  it('wraps HTTP errors in UrlFetchError with the status', async () => {
    const { root, storage } = makeFakeStorage()
    const { impl } = makeFetch(PAYLOAD, { status: 404 })
    const downloader = new UrlDownloader({ fetchImpl: impl, storage })
    await expect(downloader.download('https://example.com/x.jsonl')).rejects.toMatchObject({
      name: 'UrlFetchError',
      status: 404,
      code: 'URL_FETCH_FAILED',
    })
    expect([...(root as unknown as FakeDirHandle).entries.keys()].length).toBe(0)
  })

  it('sends custom headers and omits credentials', async () => {
    const { storage } = makeFakeStorage()
    const { impl, calls } = makeFetch(PAYLOAD, { chunks: [PAYLOAD.length] })
    const downloader = new UrlDownloader({
      fetchImpl: impl,
      storage,
      headers: { Authorization: 'Bearer tok' },
    })
    await downloader.download('https://example.com/x.jsonl')
    expect(calls[0]!.headers).toEqual({ Authorization: 'Bearer tok' })
  })

  it('urlFileName derives the name from the URL path', () => {
    expect(urlFileName('https://x.example/a/b/data.jsonl')).toBe('data.jsonl')
    expect(urlFileName('https://x.example/')).toBe('remote.jsonl')
    expect(urlFileName('not a url')).toBe('remote.jsonl')
  })
})

// ============================================================================
// Worker integration (initUrl consent handshake + cancel)
// ============================================================================

describe('jsonl.worker URL integration', () => {
  let postSpy: Mock

  beforeEach(() => {
    postSpy = vi.fn()
    vi.stubGlobal('postMessage', postSpy)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function posted(type: string) {
    return postSpy.mock.calls
      .map((c) => c[0] as { type?: string })
      .filter((m) => m && m.type === type)
  }

  function post(data: unknown): void | Promise<void> {
    const w = globalThis as unknown as { onmessage?: (e: MessageEvent) => void | Promise<void> }
    return w.onmessage?.({ data } as unknown as MessageEvent)
  }

  it('initUrl → urlFallbackConfirm handshake → urlProgress → initResponse', async () => {
    const payload = encode('[{"a":1}]\n[{"a":2}]\n')
    const { impl } = makeFetch(payload, { noContentLength: true, chunks: [10, 20] })
    vi.stubGlobal('fetch', impl)
    await import('../../workers/jsonl.worker.js')

    const initPromise = post({
      requestId: 'r-init',
      operationId: 'op-1',
      type: 'initUrl',
      url: 'https://example.com/deep/data.jsonl',
      headers: {},
    })

    // Worker asks for consent (OPFS absent in happy-dom → RAM fallback).
    await vi.waitFor(() => {
      expect(posted('urlFallbackConfirm')).toEqual([
        expect.objectContaining({
          operationId: 'op-1',
          url: 'https://example.com/deep/data.jsonl',
          reason: 'opfs-unavailable',
        }),
      ])
    })

    post({ requestId: 'r-confirm', type: 'urlFallbackConfirm', operationId: 'op-1', accept: true })
    await initPromise
    expect(posted('urlProgress').length).toBe(2)
    const p1 = posted('urlProgress')[0] as { receivedBytes: number }
    const p2 = posted('urlProgress')[1] as { receivedBytes: number }
    expect(p1.receivedBytes).toBe(10)
    expect(p2.receivedBytes).toBe(payload.length)

    const responses = postSpy.mock.calls
      .map((c) => c[0] as { type?: string; requestId?: string })
      .filter((m) => m['requestId'] === 'r-init')
    expect(responses).toHaveLength(1)
    expect(responses[0]).toMatchObject({ ok: true, requestId: 'r-init' })
    expect((responses[0] as { value: { name: string; size: number; type: string } }).value).toEqual({
      name: 'data.jsonl',
      size: payload.length,
      type: 'url',
    })
  })

  it('initUrl → declined consent → initResponse with URL_FALLBACK_DECLINED', async () => {
    const payload = encode('[{"a":1}]\n')
    const { impl } = makeFetch(payload, { noContentLength: true })
    vi.stubGlobal('fetch', impl)
    await import('../../workers/jsonl.worker.js')

    const initPromise = post({
      requestId: 'r-init-2',
      operationId: 'op-2',
      type: 'initUrl',
      url: 'https://example.com/data.jsonl',
      headers: {},
    })
    await vi.waitFor(() => {
      expect(posted('urlFallbackConfirm').length).toBe(1)
    })
    post({ requestId: 'r-confirm-2', type: 'urlFallbackConfirm', operationId: 'op-2', accept: false })
    await initPromise

    const responses = postSpy.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((m) => m['requestId'] === 'r-init-2')
    expect(responses).toHaveLength(1)
    expect(responses[0]).toMatchObject({ ok: false })
    expect((responses[0] as { error: { code: string } }).error.code).toBe('URL_FALLBACK_DECLINED')
  })

  it('cancel with matching operationId aborts the download → CANCELLED', async () => {
    const payload = patternBytes(300)
    let releaseGate: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    const { impl } = makeFetch(payload, {
      noContentLength: true,
      chunks: [10, 290],
      onRead: async (index) => {
        if (index === 1) await gate
      },
    })
    vi.stubGlobal('fetch', impl)
    await import('../../workers/jsonl.worker.js')

    const initPromise = post({
      requestId: 'r-init-3',
      operationId: 'op-3',
      type: 'initUrl',
      url: 'https://example.com/big.jsonl',
      headers: {},
    })
    // RAM fallback (no OPFS in happy-dom): accept consent to start the fetch.
    await vi.waitFor(() => expect(posted('urlFallbackConfirm').length).toBe(1))
    post({ requestId: 'r-confirm-3', type: 'urlFallbackConfirm', operationId: 'op-3', accept: true })
    // First chunk received; second read is gated.
    await vi.waitFor(() => expect(posted('urlProgress').length).toBe(1))
    post({ requestId: 'r-cancel', operationId: 'op-3', type: 'cancel' })
    releaseGate()
    await initPromise

    const responses = postSpy.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((m) => m['requestId'] === 'r-init-3')
    expect(responses).toHaveLength(1)
    expect((responses[0] as { error?: { code: string } }).error?.code).toBe('CANCELLED')
    // The cancel acknowledgement itself.
    expect(
      postSpy.mock.calls.map((c) => c[0]).some((m: { requestId?: string }) => m.requestId === 'r-cancel'),
    ).toBe(true)
  })

  it('a second initUrl after a URL init resets state and succeeds', async () => {
    const p1 = encode('{"x":1}\n')
    const p2 = encode('{"x":2}\n{"x":3}\n')
    const f1 = makeFetch(p1, { noContentLength: true })
    const f2 = makeFetch(p2, { noContentLength: true })
    vi.stubGlobal('fetch', f1.impl)
    await import('../../workers/jsonl.worker.js')

    const first = post({
      requestId: 'r-a',
      operationId: 'op-a',
      type: 'initUrl',
      url: 'https://example.com/one.jsonl',
      headers: {},
    })
    await vi.waitFor(() => expect(posted('urlFallbackConfirm').length).toBeGreaterThanOrEqual(1))
    post({ requestId: 'r-ac', type: 'urlFallbackConfirm', operationId: 'op-a', accept: true })
    await first
    expect(postSpy.mock.calls.map((c) => c[0]).filter((m: { requestId?: string }) => m.requestId === 'r-a')).toHaveLength(1)

    vi.stubGlobal('fetch', f2.impl)
    const second = post({
      requestId: 'r-b',
      operationId: 'op-b',
      type: 'initUrl',
      url: 'https://example.com/two.jsonl',
      headers: {},
    })
    await vi.waitFor(() => {
      const confirms = posted('urlFallbackConfirm') as { operationId: string }[]
      expect(confirms.some((c) => c.operationId === 'op-b')).toBe(true)
    })
    post({ requestId: 'r-bc', type: 'urlFallbackConfirm', operationId: 'op-b', accept: true })
    await second
    const initB = postSpy.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .find((m) => m['requestId'] === 'r-b')
    expect((initB as { value: { name: string; size: number; type: string } }).value).toEqual({
      name: 'two.jsonl',
      size: p2.length,
      type: 'url',
    })
  })

  it('makes rows queryable while the download is still streaming', async () => {
    // Three 10-byte rows; the first streams immediately, the rest wait on a
    // single gate promise so the download can be paused after chunk 1.
    const payload = encode('[{"n":1}]\n[{"n":2}]\n[{"n":3}]\n')
    expect(payload.length).toBe(30)
    let releaseGate: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    const { impl } = makeFetch(payload, {
      chunks: [10, 10, 10],
      onRead: (index) => (index === 0 ? undefined : gate),
    })
    vi.stubGlobal('fetch', impl)
    await import('../../workers/jsonl.worker.js')

    const initPromise = post({
      requestId: 'r-stream',
      operationId: 'op-stream',
      type: 'initUrl',
      url: 'https://example.com/rows.jsonl',
      headers: {},
    })

    // Determinate size (Content-Length): no consent needed; first chunk in.
    await vi.waitFor(() => expect(posted('urlProgress')).toHaveLength(1))
    const progress1 = posted('urlProgress')[0] as {
      receivedBytes: number
      totalBytes?: number
    }
    expect(progress1).toMatchObject({ receivedBytes: 10, totalBytes: 30 })

    // The first indexed chunk produced a determinate indexProgress.
    const idxProgress = posted('indexProgress') as { committedRows: number; totalBytes?: number }[]
    expect(idxProgress.length).toBeGreaterThanOrEqual(1)
    expect(idxProgress.at(-1)).toMatchObject({ committedRows: 1, totalBytes: 30 })

    // Rows are queryable while the download is still in flight: an
    // empty text query matches every committed row.
    post({ requestId: 'r-f', operationId: 'op-stream', type: 'filter', kind: 'text', query: '' })
    await vi.waitFor(() => {
      expect(
        postSpy.mock.calls.map((c) => c[0]).some((m: { requestId?: string }) => m.requestId === 'r-f'),
      ).toBe(true)
    })
    const filterResp = postSpy.mock.calls
      .map((c) => c[0] as { requestId?: string; ok?: boolean; value?: { totalRows: number } })
      .find((m) => m.requestId === 'r-f')
    expect(filterResp?.ok).toBe(true)
    expect(filterResp?.value?.totalRows).toBe(1)

    post({ requestId: 'r-rows', operationId: 'op-stream', type: 'getRows', start: 0, count: 10 })
    await vi.waitFor(() => {
      expect(
        postSpy.mock.calls.map((c) => c[0]).some((m: { requestId?: string }) => m.requestId === 'r-rows'),
      ).toBe(true)
    })
    const rowsResp = postSpy.mock.calls
      .map((c) => c[0] as {
        requestId?: string
        ok?: boolean
        value?: {
          rows: { lineId: number; displayIndex: number; text: string; isEdited: boolean; byteLength: number }[]
          totalFiltered: number
        }
      })
      .find((m) => m.requestId === 'r-rows')
    expect(rowsResp?.ok).toBe(true)
    expect(rowsResp?.value?.totalFiltered).toBe(1)
    expect(rowsResp?.value?.rows).toEqual([
      { lineId: 1, displayIndex: 0, text: '[{"n":1}]', isEdited: false, byteLength: 9 },
    ])

    // Release the gate; the remaining chunks stream and the init completes
    // with the full index plus a single indexComplete.
    releaseGate()
    await initPromise
    const complete = posted('indexComplete') as { operationId: string; totalRows: number; totalBytes: number }[]
    expect(complete).toHaveLength(1)
    expect(complete[0]).toMatchObject({ operationId: 'op-stream', totalRows: 3, totalBytes: 30 })
    const initResp = postSpy.mock.calls
      .map((c) => c[0] as { requestId?: string; ok?: boolean; value?: { name: string; size: number; type: string } })
      .find((m) => m.requestId === 'r-stream')
    expect(initResp?.ok).toBe(true)
    expect(initResp?.value).toEqual({ name: 'rows.jsonl', size: 30, type: 'url' })
  })

  it('emits indeterminate indexProgress when Content-Length is absent', async () => {
    const payload = encode('[{"n":1}]\n[{"n":2}]\n')
    const { impl } = makeFetch(payload, { noContentLength: true, chunks: [10, 10] })
    vi.stubGlobal('fetch', impl)
    await import('../../workers/jsonl.worker.js')

    const initPromise = post({
      requestId: 'r-indet',
      operationId: 'op-indet',
      type: 'initUrl',
      url: 'https://example.com/indet.jsonl',
      headers: {},
    })
    await vi.waitFor(() => expect(posted('urlFallbackConfirm').length).toBe(1))
    post({ requestId: 'r-indet-c', type: 'urlFallbackConfirm', operationId: 'op-indet', accept: true })
    await vi.waitFor(() => expect(posted('urlProgress').length).toBeGreaterThanOrEqual(1))
    const first = posted('indexProgress')[0] as { progress: number; totalBytes?: number; committedRows: number }
    expect(first.totalBytes).toBeUndefined()
    expect(first.progress).toBe(0)
    expect(first.committedRows).toBe(1)
    await initPromise
  })
})
