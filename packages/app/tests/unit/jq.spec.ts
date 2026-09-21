/**
 * jq backend (TSK0027) against the REAL pinned jq-web WASM build
 * (`jq-web/jq.wasm.js` + `jq.wasm.wasm`) — the production backend.
 *
 * - Truthiness: any output except false/null matches; empty output does not.
 * - Multiple outputs; compile (parse) errors are typed; runtime errors are
 *   isolated row-by-row with per-row error counts.
 * - Batch bounds (row count / bytes) and cooperative cancellation.
 * - 64-bit return paths (`.i % 2`) — the asm.js bundle's fatal defect —
 *   are exercised here and must not throw.
 *
 * The emscripten glue fetches its binary; tests/helpers/jqWasmShim.ts
 * (installed via vitest setupFiles) serves the package's real bytes, so
 * this runs the same WASM the production worker loads.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import {
  JqRuntime,
  JqCompileError,
  wrapVerdict,
  jqErrorText,
  isJqParseError,
  JQ_BATCH_MAX_ROWS,
  getJqRuntime,
} from '~/engine/jq'
import { FilterCancelledError } from '~/engine/filter'

type JqModule = {
  raw(input: string, filter: string, flags?: string[]): string
  onInitialized: { addListener(cb: () => void): void }
}

let jq: JqModule

beforeAll(async () => {
  const mod = await import('jq-web/jq.wasm.js')
  jq = (mod as { default?: JqModule }).default ?? (mod as unknown as JqModule)
  await new Promise<void>((resolve) => jq.onInitialized.addListener(() => resolve()))
})

afterEach(() => {
  vi.restoreAllMocks()
})

function runtime(): JqRuntime {
  return new JqRuntime(jq)
}

describe('wrapVerdict (TSK0027)', () => {
  it('emits exactly one boolean line per input', () => {
    const out = jq.raw('1 2 3', wrapVerdict('. > 1'), ['-c'])
    expect(out.split('\n')).toEqual(['false', 'true', 'true'])
  })

  it('applies the truthiness rule: false/null/empty do not match', () => {
    const cases: [string, boolean][] = [
      ['true', true],
      ['false', false],
      ['null', false],
      ['empty', false],
      ['0', true], // 0 is a value, not false/null
      ['""', true], // empty string is a value
      ['[]', true], // empty array is a value
      ['false, true', true], // one truthy output suffices
      ['false, null', false], // all outputs are false/null
      ['null, empty', false],
      ['.a == 1', false], // on input below: .a is undefined
    ]
    for (const [filter, expected] of cases) {
      const out = jq.raw('{}', wrapVerdict(filter), ['-c'])
      expect(out, `filter: ${filter}`).toBe(expected ? 'true' : 'false')
    }
  })
})

describe('JqRuntime.compile (TSK0027)', () => {
  it('accepts a valid filter and returns the verdict program', async () => {
    const program = await runtime().compile('.tag == "x"')
    expect(program).toBe(wrapVerdict('.tag == "x"'))
  })

  it('throws a typed JqCompileError for a filter that does not parse', async () => {
    await expect(runtime().compile('.a..')).rejects.toThrow(JqCompileError)
    await expect(runtime().compile('.a..')).rejects.toThrow(/syntax error/)
  })

  it('does NOT treat a runtime error on the null probe as a compile error', async () => {
    // Valid program; errors only when applied to null.
    const program = await runtime().compile('1 + .')
    expect(program).toBe(wrapVerdict('1 + .'))
  })

  it('the getJqRuntime singleton returns a working backend', async () => {
    const a = await getJqRuntime()
    const b = await getJqRuntime()
    expect(a).toBe(b)
    const res = await a.runVerdicts(wrapVerdict('true'), ['{"a":1}'], () => false)
    expect(res.verdicts).toEqual([true])
    expect(res.errorCount).toBe(0)
  })
})

describe('JqRuntime.runVerdicts truthiness (TSK0027)', () => {
  it('matches per-row against real row texts', async () => {
    const rows = ['{"tag":"x"}', '{"tag":"y"}', '{"tag":"x"}', '{"other":1}']
    const res = await runtime().runVerdicts(wrapVerdict('.tag == "x"'), rows, () => false)
    expect(res.verdicts).toEqual([true, false, true, false])
    expect(res.errorCount).toBe(0)
    expect(res.firstError).toBeUndefined()
  })

  it('a row with multiple outputs matches if any output is truthy', async () => {
    const res = await runtime().runVerdicts(wrapVerdict('.a, .b'), ['{"a":false,"b":null}'], () => false)
    expect(res.verdicts).toEqual([false])
    const res2 = await runtime().runVerdicts(wrapVerdict('.a, .b'), ['{"a":false,"b":1}'], () => false)
    expect(res2.verdicts).toEqual([true])
  })

  it('counts invalid-JSON rows as errors without failing the batch', async () => {
    const rows = ['{"tag":"x"}', 'not json at all', '{"tag":"y"}']
    const res = await runtime().runVerdicts(wrapVerdict('.tag == "x"'), rows, () => false)
    expect(res.verdicts).toEqual([true, false, false])
    expect(res.errorCount).toBe(1)
    expect(res.firstError).toMatch(/parse error|Expected|invalid/i)
  })

  it('counts blank rows as errors (they carry no JSON input)', async () => {
    const res = await runtime().runVerdicts(wrapVerdict('true'), ['', '   ', '{"a":1}'], () => false)
    expect(res.verdicts).toEqual([false, false, true])
    expect(res.errorCount).toBe(2)
    expect(res.firstError).toMatch(/empty row/i)
  })

  it('isolates a runtime error to its row (batch fallback)', async () => {
    // Middle row triggers a jq runtime error; neighbours keep their verdicts.
    const rows = ['{"n":1}', '{"n":2}', '{"n":3}']
    const res = await runtime().runVerdicts(
      wrapVerdict('if .n == 2 then error("boom") else .n end'),
      rows,
      () => false,
    )
    expect(res.verdicts).toEqual([true, false, true])
    expect(res.errorCount).toBe(1)
    expect(res.firstError).toContain('boom')
  })

  it('cancellation before the first batch throws FilterCancelledError', async () => {
    await expect(
      runtime().runVerdicts(wrapVerdict('true'), ['{"a":1}'], () => true),
    ).rejects.toThrow(FilterCancelledError)
  })

  it('cancellation between batches throws after the first batch', async () => {
    const rows = Array.from({ length: JQ_BATCH_MAX_ROWS + 10 }, (_, i) => `{"i":${i}}`)
    const original = jq.raw
    let calls = 0
    vi.spyOn(jq, 'raw').mockImplementation((input, filter, flags) => {
      calls++
      return original(input, filter, flags)
    })
    await expect(
      runtime().runVerdicts(wrapVerdict('true'), rows, () => calls >= 1),
    ).rejects.toThrow(FilterCancelledError)
    expect(calls).toBeGreaterThanOrEqual(1)
  })
})

describe('JqRuntime batch bounds (TSK0027)', () => {
  it('splits large row sets into multiple bounded calls', async () => {
    const rows = Array.from({ length: JQ_BATCH_MAX_ROWS * 2 + 100 }, (_, i) => `{"i":${i}}`)
    const callSpy = vi.spyOn(jq, 'raw')
    const res = await runtime().runVerdicts(wrapVerdict('.i % 2 == 0'), rows, () => false)
    expect(res.verdicts.filter((v) => v).length).toBe(rows.length / 2)
    expect(res.errorCount).toBe(0)
    // 2048*2+100 rows need at least 3 bounded calls (plus the compile probe
    // is a separate runtime; this spy only counts runVerdicts batches).
    expect(callSpy.mock.calls.length).toBeGreaterThanOrEqual(3)
  })
})

describe('jq error normalization (TSK0027)', () => {
  it('recovers the full stderr text from the mangled Error', () => {
    try {
      jq.raw('{}', '.a.', ['-c'])
      expect.unreachable('expected a parse error')
    } catch (error) {
      const text = jqErrorText(error)
      expect(text).toContain('syntax error')
      expect(isJqParseError(error)).toBe(true)
    }
  })

  it('classifies runtime errors distinctly from parse errors', () => {
    try {
      jq.raw('{}', 'error("boom")', ['-c'])
      expect.unreachable('expected a runtime error')
    } catch (error) {
      const text = jqErrorText(error)
      expect(text).toContain('boom')
      expect(isJqParseError(error)).toBe(false)
    }
  })

  it('falls back to message/string for non-jq errors', () => {
    expect(jqErrorText(new Error('plain'))).toBe('plain')
    expect(jqErrorText('str')).toBe('str')
    expect(isJqParseError(new Error('plain'))).toBe(false)
  })
})
