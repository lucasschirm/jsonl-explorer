/**
 * FilterEngine unit tests (TSK0026): literal text filtering.
 *
 * - Matches agree with a reference (`text.includes(query)`) over UTF-8,
 *   CRLF, blank, and empty-query inputs.
 * - Edited rows match against their override text, never the source bytes.
 * - The match index is built off-to-side and swapped atomically: cancel or
 *   error keeps the previous view untouched.
 * - Token-scoped scans: a newer filter supersedes the in-flight one.
 * - Partial labeling while indexing is in flight.
 */
import { describe, it, expect, vi, type Mock } from 'vitest'
import { FilterEngine, FilterCancelledError } from '../../engine/filter'
import type { FilterIndexerLike, FilterSourceLike } from '../../engine/filter'
import type { JqRuntimeLike } from '../../engine/jq'
import type { FilterProgressEvent } from '@jsonl-explorer/shared'

const enc = new TextEncoder()

interface FakeLayout {
  bytes: Uint8Array
  indexer: FilterIndexerLike
  setCommitted(n: number): void
}

/**
 * Lays out rows joined by '\n' (optionally CRLF: each row stored as
 * `row + \r\n`; the display end strips the CR, exactly like the scanner's
 * getDisplayEnd). `committed` grows/shrinks to simulate incremental index.
 */
function makeLayout(rows: string[], crlf = false): FakeLayout {
  const starts: number[] = []
  const ends: number[] = []
  let offset = 0
  const chunks: number[][] = []
  for (const row of rows) {
    const rowBytes = [...enc.encode(row)]
    starts.push(offset)
    ends.push(offset + rowBytes.length - 1)
    chunks.push(rowBytes)
    offset += rowBytes.length + (crlf ? 2 : 1)
  }
  const bytes = new Uint8Array(Math.max(offset, 0))
  let pos = 0
  for (const chunk of chunks) {
    bytes.set(chunk, pos)
    pos += chunk.length + (crlf ? 2 : 1)
  }
  let committed = rows.length
  return {
    bytes,
    indexer: {
      getCommittedRows: () => committed,
      getLineStart: (i: number) => starts[i]!,
      getLineEnd: (i: number) => ends[i]!,
    },
    setCommitted: (n: number) => {
      committed = n
    },
  }
}

interface EngineHarness {
  engine: FilterEngine
  events: FilterProgressEvent[]
  readRange: Mock<[start: number, length: number], Promise<Uint8Array<ArrayBuffer>>>
  layout: FakeLayout
  setIndexComplete(v: boolean): void
}

function makeEngine(
  rows: string[],
  opts: {
    crlf?: boolean
    indexComplete?: boolean
    edits?: Map<number, string>
    readDelayMs?: number
  } = {},
): EngineHarness {
  const layout = makeLayout(rows, opts.crlf ?? false)
  const events: FilterProgressEvent[] = []
  const readRange = vi.fn(async (start: number, length: number) => {
    if (opts.readDelayMs) await new Promise((r) => setTimeout(r, opts.readDelayMs))
    return layout.bytes.slice(start, start + length)
  })
  const source: FilterSourceLike = { readRange }
  let indexComplete = opts.indexComplete ?? true
  const engine = new FilterEngine(layout.indexer, source, {
    postEvent: (event) => events.push(event),
    getEditOverride: (lineId) => opts.edits?.get(lineId) ?? null,
    isIndexComplete: () => indexComplete,
  })
  return {
    engine,
    events,
    readRange,
    layout,
    setIndexComplete: (v: boolean) => {
      indexComplete = v
    },
  }
}

/** Reference: matches computed from the decoded (CR-stripped) row texts. */
function referenceMatchIds(rows: string[], query: string, edits?: Map<number, string>): number[] {
  const ids: number[] = []
  rows.forEach((row, i) => {
    const text = edits?.get(i + 1) ?? row
    if (text.includes(query)) ids.push(i)
  })
  return ids
}

describe('FilterEngine text matching (TSK0026)', () => {
  it('matches agree with the reference for plain, UTF-8, and mixed rows', async () => {
    const rows = ['{"a":"hello"}', 'plain line no braces', '{"b":"wörld ☃"}', '{"c":"HÉLLÔ"}', '{"d":"plain"}']
    const { engine } = makeEngine(rows)

    for (const query of ['hello', 'wörld', '☃', 'HÉLLÔ', 'plain', 'zz-absent']) {
      const res = await engine.filter('text', query)
      const expected = referenceMatchIds(rows, query)
      expect(res.matchedRows).toBe(expected.length)
      expect(res.totalRows).toBe(rows.length)
      expect(engine.matchCount()).toBe(expected.length)
      const got: number[] = []
      for (let i = 0; i < engine.matchCount(); i++) got.push(engine.rowAt(i))
      expect(got).toEqual(expected)
      // positionOfLine inverts the mapping (and rejects unmatched rows).
      expected.forEach((rowId) => expect(engine.positionOfLine(rowId + 1)).toBe(got.indexOf(rowId)))
      rows
        .map((_, i) => i)
        .filter((i) => !expected.includes(i))
        .forEach((i) => expect(engine.positionOfLine(i + 1)).toBeNull())
    }
  })

  it('CRLF files: the CR is never part of the matchable text', async () => {
    const rows = ['alpha', 'beta', 'alpha']
    const { engine } = makeEngine(rows, { crlf: true })

    const res = await engine.filter('text', 'alpha')
    expect(res.matchedRows).toBe(2)
    expect(engine.rowAt(0)).toBe(0)
    expect(engine.rowAt(1)).toBe(2)

    // Searching for a bare CR must never match (delimiter bytes excluded).
    const cr = await engine.filter('text', '\r')
    expect(cr.matchedRows).toBe(0)
    const lf = await engine.filter('text', '\n')
    expect(lf.matchedRows).toBe(0)
  })

  it('blank rows are addressable and match the empty query only', async () => {
    const rows = ['x', '', 'y', '']
    const { engine } = makeEngine(rows)

    const blank = await engine.filter('text', '')
    expect(blank.matchedRows).toBe(4)
    const blankOnly = await engine.filter('text', 'x')
    expect(blankOnly.matchedRows).toBe(1)
    expect(engine.rowAt(0)).toBe(0)
  })

  it('is case-sensitive and never matches across line boundaries', async () => {
    const rows = ['ABC', 'def-ABC']
    const { engine } = makeEngine(rows)
    const lower = await engine.filter('text', 'abc')
    expect(lower.matchedRows).toBe(0)
    // A query spanning two rows must not match (per-row scanning).
    const span = await engine.filter('text', 'ABC\ndef')
    expect(span.matchedRows).toBe(0)
  })

  it('invalid UTF-8 rows decode with replacement and stay searchable', async () => {
    // Row 1 contains an invalid UTF-8 byte sequence (0xFF) inside text.
    const good = enc.encode('{"k":"ok"}')
    const bad = new Uint8Array([...enc.encode('{"k":"bad'), 0xff, ...enc.encode('"}')])
    const layoutBytes = new Uint8Array(good.length + bad.length + 1)
    layoutBytes.set(good, 0)
    layoutBytes.set(bad, good.length + 1)
    const indexer: FilterIndexerLike = {
      getCommittedRows: () => 2,
      getLineStart: (i: number) => (i === 0 ? 0 : good.length + 1),
      getLineEnd: (i: number) => (i === 0 ? good.length - 1 : layoutBytes.length - 1),
    }
    const source: FilterSourceLike = { readRange: async (s, l) => layoutBytes.slice(s, s + l) }
    const engine = new FilterEngine(indexer, source, {
      postEvent: () => {},
      getEditOverride: () => null,
      isIndexComplete: () => true,
    })

    const res = await engine.filter('text', 'bad')
    expect(res.matchedRows).toBe(1)
    expect(engine.rowAt(0)).toBe(1)
    const none = await engine.filter('text', 'nope')
    expect(none.matchedRows).toBe(0)
  })
})

describe('FilterEngine edit overrides (TSK0026)', () => {
  const rows = ['{"v":"original"}', '{"v":"other"}']

  it('edited rows match their edited text, not the source bytes', async () => {
    const edits = new Map<number, string>([[1, '{"v":"patched"}']])
    const { engine, readRange } = makeEngine(rows, { edits })

    const res = await engine.filter('text', 'patched')
    expect(res.matchedRows).toBe(1)
    expect(engine.rowAt(0)).toBe(0)
    // Row 1 never hit the source (override decided the match).
    expect(readRange).toHaveBeenCalledTimes(1)
    expect(readRange.mock.calls[0]![0]).toBeGreaterThan(0)

    // The original text no longer matches row 1 (override replaces it).
    const original = await engine.filter('text', 'original')
    expect(original.matchedRows).toBe(0)

    // Unedited rows still match source text.
    const other = await engine.filter('text', 'other')
    expect(other.matchedRows).toBe(1)
    expect(engine.rowAt(0)).toBe(1)
  })

  it('an override that removes the needle drops the row from the view', async () => {
    const edits = new Map<number, string>([[1, '{"v":"renamed"}']])
    const { engine } = makeEngine(rows, { edits })
    const res = await engine.filter('text', 'original')
    expect(res.matchedRows).toBe(0)
    const res2 = await engine.filter('text', 'renamed')
    expect(res2.matchedRows).toBe(1)
    expect(engine.rowAt(0)).toBe(0)
  })

  it('edits flip row membership across reruns, in both directions (TSK0029)', async () => {
    const src = ['{"k":"base"}', '{"k":"base"}']
    const edits = new Map<number, string>() // mutated across reruns
    const { engine } = makeEngine(src, { edits })

    // No edits: the needle matches nothing.
    let res = await engine.filter('text', 'needle')
    expect(res.matchedRows).toBe(0)

    // Edit row 1 in: the rerun admits it.
    edits.set(1, '{"k":"needle"}')
    res = await engine.filter('text', 'needle')
    expect(res.matchedRows).toBe(1)
    expect(engine.rowAt(0)).toBe(0)

    // Edit row 2 in as well: both, in source order.
    edits.set(2, '{"k":"needle-2"}')
    res = await engine.filter('text', 'needle')
    expect(res.matchedRows).toBe(2)
    expect(engine.rowAt(0)).toBe(0)
    expect(engine.rowAt(1)).toBe(1)

    // Remove row 1's edit (back to source text): it leaves the view,
    // and the survivor keeps a stable source lineId.
    edits.delete(1)
    res = await engine.filter('text', 'needle')
    expect(res.matchedRows).toBe(1)
    expect(engine.rowAt(0)).toBe(1)
  })
})

describe('FilterEngine atomic swap and cancellation (TSK0026)', () => {
  const MANY = Array.from({ length: 1500 }, (_, i) => (i % 3 === 0 ? '{"t":"x"}' : '{"t":"y"}'))

  it('a cancelled scan keeps the previous view untouched', async () => {
    const { engine } = makeEngine(MANY, { readDelayMs: 0.5 })

    const first = await engine.filter('text', 'x')
    const firstCount = first.matchedRows
    const firstMatched = engine.getMatchedRows().slice(0, firstCount)
    expect(firstCount).toBeGreaterThan(0)

    const pending = engine.filter('text', 'zz-absent')
    const rejected = expect(pending).rejects.toThrow(FilterCancelledError)
    // Let the new scan spin a few rows. The margin is deliberate: the
    // minimum scan duration here is ~1500 x 0.5ms = 750ms, so a cancel
    // within this window always lands mid-scan (cooperative check).
    await new Promise((r) => setTimeout(r, 25))
    engine.cancel()
    await rejected

    // Previous view fully intact.
    expect(engine.isFiltered()).toBe(true)
    expect(engine.matchCount()).toBe(firstCount)
    expect(engine.getMatchedRows().slice(0, firstCount)).toEqual(firstMatched)
    // A fresh run still works after the cancel.
    const again = await engine.filter('text', 'y')
    expect(again.matchedRows).toBe(MANY.length - firstCount)
  })

  it('a newer filter supersedes the in-flight one (stale operation)', async () => {
    const { engine } = makeEngine(MANY, { readDelayMs: 0.5 })
    await engine.filter('text', 'x')

    const stale = engine.filter('text', 'y')
    const rejected = expect(stale).rejects.toThrow(FilterCancelledError)
    await new Promise((r) => setTimeout(r, 5)) // let the stale scan start
    const fresh = await engine.filter('text', 'x')
    await rejected

    expect(fresh.matchedRows).toBe(MANY.length / 3)
    expect(engine.matchCount()).toBe(fresh.matchedRows)
    // The published view is the FRESH ('x') result, not the stale partial:
    // row 1 (lineId 1) is 'x' -> visible; row 2 (lineId 2) is 'y' -> not.
    expect(engine.positionOfLine(1)).toBe(0)
    expect(engine.positionOfLine(2)).toBeNull()
  })

  it('a scan error keeps the previous view (no half-replaced index)', async () => {
    const { engine } = makeEngine(['{"a":"hit"}'], {})
    await engine.filter('text', 'hit')
    expect(engine.matchCount()).toBe(1)

    // A source that is healthy at first, then fails mid-session.
    const goodBytes = enc.encode('{"a":"hit"}')
    let broken = false
    const flaky: FilterSourceLike = {
      readRange: async (s, l) => {
        if (broken) throw new Error('source gone')
        return goodBytes.slice(s, s + l)
      },
    }
    const failing = new FilterEngine(
      { getCommittedRows: () => 1, getLineStart: () => 0, getLineEnd: () => 12 },
      flaky,
      { postEvent: () => {}, getEditOverride: () => null, isIndexComplete: () => true },
    )
    await failing.filter('text', 'hit')
    expect(failing.matchCount()).toBe(1)
    const before = failing.getMatchedRows().slice(0, 1)
    broken = true
    await expect(failing.filter('text', 'x')).rejects.toThrow('source gone')
    // The failed scan left the previous view intact (atomic swap).
    expect(failing.matchCount()).toBe(1)
    expect(failing.getMatchedRows().slice(0, 1)).toEqual(before)
  })
})

describe('FilterEngine partial results and completion state (TSK0026)', () => {
  const rows = ['{"a":"1"}', '{"b":"2"}', '{"c":"3"}']

  it('labels results partial while indexing is in flight', async () => {
    const { engine, layout } = makeEngine(rows, { indexComplete: false })
    layout.setCommitted(2) // only two rows committed so far

    const res = await engine.filter('text', '"2"')
    expect(res.partial).toBe(true)
    expect(res.totalRows).toBe(2)
    expect(res.matchedRows).toBe(1)
    expect(engine.hasActiveQuery()).toBe(true)
    expect(engine.getActiveQuery()).toEqual({ kind: 'text', query: '"2"' })
  })

  it('reports non-partial once indexing completes and reruns cleanly', async () => {
    const { engine, layout, setIndexComplete } = makeEngine(rows, { indexComplete: false })
    layout.setCommitted(2)
    const partial = await engine.filter('text', '"2"')
    expect(partial.partial).toBe(true)

    // Indexing finishes: the SAME query reruns over the full row set.
    layout.setCommitted(3)
    setIndexComplete(true)
    const complete = await engine.filter('text', '"2"')
    expect(complete.partial).toBe(false)
    expect(complete.totalRows).toBe(3)
    expect(complete.matchedRows).toBe(1)
    expect(engine.matchCount()).toBe(1)
  })

  it('identity mode until a filter completes; hasActiveQuery gates reruns', () => {
    const { engine } = makeEngine(rows)
    expect(engine.isFiltered()).toBe(false)
    expect(engine.hasActiveQuery()).toBe(false)
    expect(engine.getActiveQuery()).toBeNull()
    expect(engine.matchCount()).toBe(3)
    expect(engine.rowAt(2)).toBe(2)
    expect(engine.positionOfLine(3)).toBe(2)
    expect(engine.positionOfLine(4)).toBeNull() // past committed rows
  })
})

describe('FilterEngine progress events (TSK0026)', () => {
  it('emits throttled progress with operationId and scan horizon', async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => `{"i":${i}}`)
    const { engine, events } = makeEngine(rows)
    engine.setOperationId('op-prog')

    // Deterministic clock: advance 100ms per read so every 1000-row tick
    // passes the 50ms throttle.
    let clock = 0
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => (clock += 100))
    try {
      const res = await engine.filter('text', '"i":')
      expect(res.matchedRows).toBe(2500)
    } finally {
      nowSpy.mockRestore()
    }

    expect(events.length).toBe(2) // ticks at 1000 and 2000
    for (const event of events) {
      expect(event.type).toBe('filterProgress')
      expect(event.operationId).toBe('op-prog')
      expect(event.totalRows).toBe(2500)
    }
    expect(events.map((e) => e.scannedRows)).toEqual([1000, 2000])
  })

  it('emits nothing without an operationId', async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => `{"i":${i}}`)
    const { engine, events } = makeEngine(rows)
    await engine.filter('text', '"i":')
    expect(events).toHaveLength(0)
  })
})

describe('FilterEngine jq row-error summary + clear (TSK0028)', () => {
  /**
   * Fake jq backend: rows that parse as JSON match (verdict true), invalid
   * JSON is a row error. The first error text is recorded, exactly like the
   * real backend's `firstError`.
   */
  function makeFakeJq() {
    return {
      compile: async (query: string) => `prog:${query}`,
      runVerdicts: async (program: string, rows: string[]) => {
        const verdicts = rows.map((row) => {
          try {
            JSON.parse(row)
            return true
          } catch {
            return false
          }
        })
        const errorRows = verdicts.map((v) => v === false)
        const errorCount = errorRows.filter(Boolean).length
        let firstError: string | undefined
        for (const row of rows) {
          try {
            JSON.parse(row)
          } catch (e) {
            firstError ??= `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`
            break
          }
        }
        return { verdicts, errorRows, errorCount, firstError }
      },
      // The filter engine never calls runOutputs (that is the local
      // search path, TSK0033) — a stub that fails loudly if it ever does.
      runOutputs: async () => {
        throw new Error('runOutputs is not used by the filter engine')
      },
    } satisfies JqRuntimeLike
  }

  function makeJqEngine(rows: string[], opts: { readDelayMs?: number } = {}) {
    const layout = makeLayout(rows)
    const readRange = async (start: number, length: number) => {
      if (opts.readDelayMs) await new Promise((r) => setTimeout(r, opts.readDelayMs))
      return layout.bytes.slice(start, start + length)
    }
    const engine = new FilterEngine(layout.indexer, { readRange }, {
      postEvent: () => {},
      getEditOverride: () => null,
      isIndexComplete: () => true,
      jq: makeFakeJq(),
    })
    return { engine, layout }
  }

  it('counts row errors and surfaces ONE first-error summary', async () => {
    const rows = ['{"n":1}', 'not json', '{"n":2}', 'still broken', '{"n":3}']
    const { engine } = makeJqEngine(rows)

    const res = await engine.filter('jq', '.n')
    expect(res.matchedRows).toBe(3)
    expect(res.totalRows).toBe(5)
    expect(res.errorCount).toBe(2)
    expect(typeof res.errorSummary).toBe('string')
    expect(res.errorSummary).toContain('not json') // the FIRST error, not all of them
  })

  it('a clean scan has no error summary', async () => {
    const rows = ['{"n":1}', '{"n":2}']
    const { engine } = makeJqEngine(rows)

    const res = await engine.filter('jq', '.n')
    expect(res.errorCount).toBe(0)
    expect(res.errorSummary).toBeUndefined()
  })

  it('clear() restores the identity view after a filter', async () => {
    const rows = ['a', 'b', 'a', 'c']
    const { engine } = makeEngine(rows)

    const res = await engine.filter('text', 'a')
    expect(res.matchedRows).toBe(2)
    expect(engine.isFiltered()).toBe(true)

    engine.clear()
    expect(engine.isFiltered()).toBe(false)
    expect(engine.matchCount()).toBe(4) // match-all: every committed row
    for (let i = 0; i < 4; i++) expect(engine.rowAt(i)).toBe(i)
    for (let lineId = 1; lineId <= 4; lineId++) expect(engine.positionOfLine(lineId)).toBe(lineId - 1)
    expect(engine.positionOfLine(5)).toBeNull()
    expect(engine.hasActiveQuery()).toBe(false)
    expect(engine.getActiveQuery()).toBeNull()

    // A fresh filter after the clear works normally.
    const again = await engine.filter('text', 'b')
    expect(again.matchedRows).toBe(1)
    expect(engine.rowAt(0)).toBe(1)
  })

  it('clear() aborts an in-flight scan; its swap never lands', async () => {
    const rows = Array.from({ length: 1500 }, (_, i) => (i % 3 === 0 ? 'x' : 'y'))
    const { engine } = makeJqEngine(rows, { readDelayMs: 0.5 })

    // A text scan is in flight (no filter has completed yet).
    const pending = engine.filter('text', 'x')
    const rejected = expect(pending).rejects.toThrow(FilterCancelledError)
    await new Promise((r) => setTimeout(r, 5)) // let the scan start
    engine.clear()
    await rejected

    // Identity view published; the aborted scan cannot swap in later.
    expect(engine.isFiltered()).toBe(false)
    expect(engine.matchCount()).toBe(1500)
    expect(engine.rowAt(0)).toBe(0)
    expect(engine.positionOfLine(1)).toBe(0)
  })
})

describe('FilterEngine.applyEdit single-row re-evaluation (TSK0030)', () => {
  /** The LIVE match index (only [0, matchedCount) of the buffer is real). */
  function liveIndex(engine: FilterEngine): number[] {
    return Array.from(engine.getMatchedRows().slice(0, engine.matchCount()))
  }

  function makeJqEngine(
    rows: string[],
    opts: { edits?: Map<number, string>; readDelayMs?: number } = {},
  ) {
    const layout = makeLayout(rows)
    const readRange = async (start: number, length: number) => {
      if (opts.readDelayMs) await new Promise((r) => setTimeout(r, opts.readDelayMs))
      return layout.bytes.slice(start, start + length)
    }
    const engine = new FilterEngine(layout.indexer, { readRange }, {
      postEvent: () => {},
      getEditOverride: (lineId) => opts.edits?.get(lineId) ?? null,
      isIndexComplete: () => true,
      jq: {
        compile: async (query: string) => `prog:${query}`,
        runVerdicts: async (_program: string, input: string[]) => {
          const verdicts = input.map((row) => {
            try {
              JSON.parse(row)
              return true
            } catch {
              return false
            }
          })
          const errorRows = verdicts.map((v) => v === false)
          const errorCount = errorRows.filter(Boolean).length
          let firstError: string | undefined
          if (errorCount > 0) firstError = 'Invalid JSON (row is not a JSON value)'
          return { verdicts, errorRows, errorCount, firstError }
        },
        runOutputs: async () => {
          throw new Error('runOutputs is not used by the filter engine')
        },
      } satisfies JqRuntimeLike,
    })
    return { engine, layout }
  }

  it('text kind: insert, remove, keep, and no-op all land on the right display index', async () => {
    // lineId: 1='x' 2='y' 3='x' 4='z' 5='x'; filter 'x' -> lines 1, 3, 5.
    const rows = ['x', 'y', 'x', 'z', 'x']
    const edits = new Map<number, string>()
    const { engine } = makeEngine(rows, { edits })
    await engine.filter('text', 'x')
    expect(liveIndex(engine)).toEqual([0, 2, 4])

    // No-op: line 4 ('z') edited to still not contain the query.
    edits.set(4, 'no query here')
    expect((await engine.applyEdit(4)).filteredIndex).toBeNull()
    expect(liveIndex(engine)).toEqual([0, 2, 4])

    // Insert: line 4 now matches -> display index 2 (between lines 3 and 5).
    edits.set(4, 'x now')
    expect((await engine.applyEdit(4)).filteredIndex).toBe(2)
    expect(liveIndex(engine)).toEqual([0, 2, 3, 4])

    // Keep: an already-matching row edited to still match keeps its slot.
    edits.set(1, 'xx')
    expect((await engine.applyEdit(1)).filteredIndex).toBe(0)
    expect(liveIndex(engine)).toEqual([0, 2, 3, 4])

    // Remove: line 1 loses the query -> later rows shift left, index null.
    edits.set(1, 'y again')
    expect((await engine.applyEdit(1)).filteredIndex).toBeNull()
    expect(liveIndex(engine)).toEqual([2, 3, 4])

    // Text kind never errors.
    expect((await engine.applyEdit(2)).errorCount).toBe(0)
  })

  it('identity view: applyEdit reports the row index without any state', async () => {
    const { engine } = makeEngine(['a', 'b'])
    const res = await engine.applyEdit(2)
    expect(res).toEqual({ filteredIndex: 1, errorCount: 0, errorSummary: null })
    // A row beyond the committed set is out of the view.
    expect((await engine.applyEdit(3)).filteredIndex).toBeNull()
  })

  it('jq kind: fixing a row error drops the count, breaking a match adds one', async () => {
    const rows = ['{"n":1}', 'broken', '{"n":2}']
    const edits = new Map<number, string>()
    const { engine } = makeJqEngine(rows, { edits })
    const scan = await engine.filter('jq', '.n')
    expect(scan.matchedRows).toBe(2)
    expect(scan.errorCount).toBe(1)

    // Fix row 2 (the broken one): valid JSON -> matches, error cleared.
    edits.set(2, '{"n":3}')
    const fixed = await engine.applyEdit(2)
    expect(fixed.filteredIndex).toBe(1)
    expect(fixed.errorCount).toBe(0)
    expect(fixed.errorSummary).toBeNull()
    expect(liveIndex(engine)).toEqual([0, 1, 2])

    // Break row 1: invalid JSON -> row error, out of the view.
    edits.set(1, 'nope')
    const broken = await engine.applyEdit(1)
    expect(broken.filteredIndex).toBeNull()
    expect(broken.errorCount).toBe(1)
    expect(typeof broken.errorSummary).toBe('string')
    expect(liveIndex(engine)).toEqual([1, 2])

    // clear() resets the error accounting along with the view.
    engine.clear()
    expect(engine.matchCount()).toBe(3)
  })

  it('a scan that commits during the verdict await wins: no torn index', async () => {
    const rows = ['{"t":"a"}', '{"t":"b"}', '{"t":"a"}', '{"t":"c"}']
    const edits = new Map<number, string>()
    let verdictDelayMs = 0
    const layout = makeLayout(rows)
    const readRange = async (start: number, length: number) => {
      await new Promise((r) => setTimeout(r, 1))
      return layout.bytes.slice(start, start + length)
    }
    const jq: JqRuntimeLike = {
      compile: async (query: string) => `prog:${query}`,
      runVerdicts: async (_program: string, input: string[]) => {
        if (verdictDelayMs) await new Promise((r) => setTimeout(r, verdictDelayMs))
        const verdicts = input.map((row) => {
          try {
            JSON.parse(row)
            return true
          } catch {
            return false
          }
        })
        return { verdicts, errorRows: verdicts.map((v) => v === false), errorCount: 0 }
      },
      runOutputs: async () => {
        throw new Error('runOutputs is not used by the filter engine')
      },
    }
    const engine = new FilterEngine(layout.indexer, { readRange }, {
      postEvent: () => {},
      getEditOverride: (lineId) => edits.get(lineId) ?? null,
      isIndexComplete: () => true,
      jq,
    })

    // Pre-filter with fast verdicts (all rows are valid JSON -> match).
    await engine.filter('jq', '.t')
    expect(engine.matchCount()).toBe(4)
    // Now verdicts are SLOW: applyEdit's single-row verdict will straddle
    // the next scan's commit (the scan needs ~4 ms of reads).
    verdictDelayMs = 40
    const pending = engine.filter('text', 'b') // only row 1
    await new Promise((r) => setTimeout(r, 2))
    const applied = engine.applyEdit(3) // line 3 = row 2, no 'b'
    const scan = await pending
    expect(scan.matchedRows).toBe(1)
    const res = await applied

    // Whichever guard fired, the outcome is the NEW index (the fresh scan
    // already judged row 2 against the source text) — never a mutation of
    // the superseded one.
    expect(res.filteredIndex).toBeNull()
    expect(liveIndex(engine)).toEqual([1])
    expect(engine.positionOfLine(2)).toBe(0)
    expect(engine.positionOfLine(3)).toBeNull()
  })
})

