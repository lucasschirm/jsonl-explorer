/**
 * Save destinations (TSK0035): the shared pump and the two writers.
 *
 * - pumpExport: next → write → ack discipline, cancel stops, errors propagate.
 * - fsaExport: exact bytes into the writable, close on success, abort on
 *   cancel/failure (no partial file survives), picker-cancel is not an error.
 * - blobExport: exact Blob bytes/type, anchor click, object URL revoked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Mock } from 'vitest'
import type { ExportChunk, JsonlEngine } from '@jsonl-explorer/shared'
import { blobExport, fsaExport, pumpExport, supportsFsa } from '~/utils/exportSave'
import type { StartedExport } from '~/utils/exportSave'

const STARTED: StartedExport = { token: 'tok-1', totalRows: 3, estimatedBytes: 12 }

function chunk(data: string, done: boolean, rowsExported: number): ExportChunk {
  return { data: new TextEncoder().encode(data), done, rowsExported }
}

interface FakeEngine {
  engine: JsonlEngine
  nexts: string[]
  acks: string[]
  failNext?: (callIndex: number) => string | null
}

/** Fake engine answering exportNext/exportAck from a scripted chunk list. */
function makeEngine(chunks: ExportChunk[]): FakeEngine {
  const nexts: string[] = []
  const acks: string[] = []
  let i = 0
  const engine = {
    exportNext: async (token: string) => {
      nexts.push(token)
      const c = chunks[i]
      if (!c) throw new Error('no more scripted chunks')
      i += 1
      return c
    },
    exportAck: async (token: string) => {
      acks.push(token)
      return { acknowledged: true }
    },
  } as unknown as JsonlEngine
  return { engine, nexts, acks }
}

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('pumpExport', () => {
  it('pumps next → write → ack per chunk until done and totals the bytes', async () => {
    const { engine, nexts, acks } = makeEngine([
      chunk('a\n', false, 1),
      chunk('bb\n', false, 2),
      chunk('', true, 3),
    ])
    const seen: string[] = []
    const bytes = await pumpExport(engine, 'tok', {
      isCancelled: () => false,
      onChunk: (c) => {
        seen.push(new TextDecoder().decode(c.data))
      },
    })

    expect(bytes).toBe(5)
    expect(seen).toEqual(['a\n', 'bb\n']) // the empty done chunk is not written
    expect(nexts).toEqual(['tok', 'tok', 'tok'])
    // Every next is acked, in order, one at a time.
    expect(acks).toEqual(['tok', 'tok', 'tok'])
  })

  it('stops without error when isCancelled flips, returning partial bytes', async () => {
    let cancelled = false
    const { engine } = makeEngine([chunk('a\n', false, 1), chunk('b\n', false, 2), chunk('', true, 3)])
    const bytes = await pumpExport(engine, 'tok', {
      isCancelled: () => cancelled,
      onChunk: () => {
        cancelled = true // cancel after the first chunk
      },
    })
    expect(bytes).toBe(2)
  })

  it('propagates write failures (the chunk stays un-acked for the caller)', async () => {
    const { engine, acks } = makeEngine([chunk('a\n', false, 1), chunk('b\n', true, 2)])
    await expect(
      pumpExport(engine, 'tok', {
        isCancelled: () => false,
        onChunk: () => {
          throw new Error('disk full')
        },
      }),
    ).rejects.toThrow('disk full')
    expect(acks).toEqual([])
  })

  it('propagates RPC failures (e.g. EXPORT_TOKEN_INVALID after a cancel)', async () => {
    const engine = {
      exportNext: async () => {
        throw Object.assign(new Error('Invalid or expired export token'), { code: 'EXPORT_TOKEN_INVALID' })
      },
      exportAck: async () => ({ acknowledged: true }),
    } as unknown as JsonlEngine
    await expect(pumpExport(engine, 'tok', { isCancelled: () => false, onChunk: () => {} })).rejects.toThrow(
      'Invalid or expired export token',
    )
  })
})

describe('supportsFsa', () => {
  it('is false without the API and true when showSaveFilePicker exists', () => {
    expect(supportsFsa()).toBe(false)
    vi.stubGlobal('showSaveFilePicker', () => Promise.resolve({}))
    expect(supportsFsa()).toBe(true)
  })
})

interface FakeWritable {
  write: Mock<[Uint8Array], Promise<void>>
  close: Mock<[], Promise<void>>
  abort: Mock<[], Promise<void>>
  written: Uint8Array[]
}

function makeFakeWritable(): FakeWritable {
  const written: Uint8Array[] = []
  return {
    write: vi.fn(async (data: Uint8Array) => {
      written.push(data)
    }),
    close: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    written,
  }
}

function stubPicker(handle?: { createWritable: () => Promise<FakeWritable> }, pickerError?: Error): void {
  const picker = vi.fn(async () => {
    if (pickerError) throw pickerError
    if (!handle) throw new Error('no handle stubbed')
    return handle
  })
  vi.stubGlobal('showSaveFilePicker', picker)
}

const concat = (parts: Uint8Array[]): string => {
  const total = parts.reduce((n, p) => n + p.byteLength, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.byteLength
  }
  return new TextDecoder().decode(out)
}

describe('fsaExport', () => {
  it('writes the exact bytes and closes the writable on success', async () => {
    const writable = makeFakeWritable()
    stubPicker({ createWritable: async () => writable })
    const { engine } = makeEngine([chunk('a\n', false, 1), chunk('b\n', true, 2)])

    const outcome = await fsaExport(engine, STARTED, 'out.jsonl', () => false)

    expect(outcome).toEqual({ status: 'saved', bytes: 4 })
    expect(concat(writable.written)).toBe('a\nb\n')
    expect(writable.close).toHaveBeenCalledTimes(1)
    expect(writable.abort).not.toHaveBeenCalled()
  })

  it('treats a closed picker as a plain cancel (no writable, no error)', async () => {
    stubPicker(undefined, new DOMException('Aborted', 'AbortError'))
    const { engine } = makeEngine([chunk('a\n', true, 1)])

    const outcome = await fsaExport(engine, STARTED, 'out.jsonl', () => false)

    expect(outcome.status).toBe('cancelled')
    expect(outcome.bytes).toBe(0)
  })

  it('aborts the writable (discards the partial file) when the pump is cancelled', async () => {
    const writable = makeFakeWritable()
    stubPicker({ createWritable: async () => writable })
    let cancelled = false
    const { engine } = makeEngine([chunk('a\n', false, 1), chunk('b\n', true, 2)])

    const outcome = await fsaExport(engine, STARTED, 'out.jsonl', () => {
      if (writable.write.mock.calls.length >= 1) cancelled = true
      return cancelled
    })

    expect(outcome.status).toBe('cancelled')
    expect(writable.abort).toHaveBeenCalledTimes(1)
    expect(writable.close).not.toHaveBeenCalled()
  })

  it('aborts the writable and reports a typed failure when a write fails', async () => {
    const writable = makeFakeWritable()
    writable.write.mockImplementationOnce(async () => {
      throw new Error('NoSpace')
    })
    stubPicker({ createWritable: async () => writable })
    const { engine } = makeEngine([chunk('a\n', false, 1), chunk('b\n', true, 2)])

    const outcome = await fsaExport(engine, STARTED, 'out.jsonl', () => false)

    expect(outcome.status).toBe('failed')
    expect(outcome.message).toContain('NoSpace')
    expect(writable.abort).toHaveBeenCalledTimes(1)
    expect(writable.close).not.toHaveBeenCalled()
  })

  it('fails typed when the API is missing (no picker to open)', async () => {
    vi.stubGlobal('showSaveFilePicker', undefined)
    const { engine } = makeEngine([chunk('a\n', true, 1)])
    const outcome = await fsaExport(engine, STARTED, 'out.jsonl', () => false)
    expect(outcome.status).toBe('failed')
    expect(outcome.message).toContain('not supported')
  })
})

describe('blobExport', () => {
  it('builds a Blob with the exact bytes/type, clicks an anchor, and revokes the URL', async () => {
    vi.useFakeTimers()
    try {
      const created: string[] = []
      const revoked: string[] = []
      vi.spyOn(URL, 'createObjectURL').mockImplementation((obj: Blob | MediaSource) => {
        created.push((obj as Blob).type)
        return 'blob:mock'
      })
      const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => {
        revoked.push(url)
      })
      const click = vi.fn()
      const originalCreate = document.createElement.bind(document)
      const create = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
        const el = originalCreate(tag)
        if (tag === 'a') el.click = click
        return el
      })
      const { engine } = makeEngine([chunk('a\n', false, 1), chunk('b\n', true, 2)])

      const outcome = await blobExport(engine, STARTED, 'out.jsonl', () => false)

      expect(outcome).toEqual({ status: 'saved', bytes: 4 })
      expect(created).toEqual(['application/x-ndjson'])
      expect(click).toHaveBeenCalledTimes(1)
      expect(revoked).toEqual([]) // revoked after the delay, not synchronously
      vi.advanceTimersByTime(1000)
      expect(revoked).toEqual(['blob:mock'])
      create.mockRestore()
      void revoke
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not click or create a URL when cancelled mid-pump', async () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:mock')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    let cancelled = false
    const { engine } = makeEngine([chunk('a\n', false, 1), chunk('b\n', true, 2)])

    const outcome = await blobExport(engine, STARTED, 'out.jsonl', () => {
      if (cancelled) return true
      cancelled = true // cancel right after the first chunk is accumulated
      return false
    })

    expect(outcome.status).toBe('cancelled')
    expect(outcome.bytes).toBe(0)
    expect(create).not.toHaveBeenCalled()
    expect(revoke).not.toHaveBeenCalled()
  })

  it('reports a typed failure when an RPC fails mid-pump', async () => {
    let calls = 0
    const engine = {
      exportNext: async () => {
        calls += 1
        if (calls > 1) throw new Error('Export failed')
        return chunk('a\n', false, 1)
      },
      exportAck: async () => ({ acknowledged: true }),
    } as unknown as JsonlEngine
    const outcome = await blobExport(engine, STARTED, 'out.jsonl', () => false)
    expect(outcome.status).toBe('failed')
    expect(outcome.message).toContain('Export failed')
  })
})
