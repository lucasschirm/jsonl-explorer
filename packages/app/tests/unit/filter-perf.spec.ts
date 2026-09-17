/**
 * Filter performance baselines (TSK0029) — NON-GATING.
 *
 * Measures the real in-process worker (indexer + FilterEngine + sources +
 * jq WASM) on a representative 100k-row log fixture for both filter kinds
 * and prints a table. The only assertion is CORRECTNESS (matched counts);
 * timing numbers are recorded in `docs/perf-baselines.md` for later
 * performance budgets and must be re-measured (pnpm --filter ./packages/app
 * test:unit, watch the table) when that budget is enforced.
 */
import { describe, it, beforeAll, vi, expect } from 'vitest'

interface Envelope {
  type?: string
  requestId?: string
  ok?: boolean
  value?: unknown
  error?: { code?: string; message?: string }
}

const ROWS = 100_000
const ERROR_RATE = 0.1

function buildFixture(): string {
  // Representative log line: ~130 bytes of JSON per row, 10% "error".
  const parts: string[] = new Array(ROWS)
  for (let i = 0; i < ROWS; i += 1) {
    const status = i % 10 === 0 ? 'error' : 'ok'
    parts[i] =
      `{"ts":"2024-05-0${(i % 9) + 1}T1${i % 10}:23:4${i % 10}.123Z",` +
      `"status":"${status}","user":{"id":${i},"email":"user${i}@example.com"},` +
      `"msg":"request completed in ${i % 500}ms","trace":"${i.toString(16).padStart(8, '0')}"}`
  }
  return parts.join('\n') + '\n'
}

let postSpy: ReturnType<typeof vi.fn>

function post(data: unknown): void {
  const g = globalThis as unknown as { onmessage?: (e: MessageEvent) => void | Promise<void> }
  g.onmessage?.({ data } as unknown as MessageEvent)
}

async function waitForResponse(requestId: string): Promise<Envelope> {
  await vi.waitFor(
    () => {
      const responses = (postSpy.mock.calls as unknown[][])
        .map((c) => c[0] as Envelope)
        .filter((m) => m && m.requestId === requestId && m.ok !== undefined)
      expect(responses.length).toBeGreaterThan(0)
    },
    { timeout: 30_000 },
  )
  return (postSpy.mock.calls as unknown[][])
    .map((c) => c[0] as Envelope)
    .filter((m) => m && m.requestId === requestId && m.ok !== undefined)
    .at(-1)!
}

describe('filter performance baselines (TSK0029, non-gating)', () => {
  let fixture: string
  const results: { name: string; ms: number; msPerRow: number; matchedRows: number }[] = []

  beforeAll(async () => {
    vi.resetModules()
    postSpy = vi.fn()
    vi.stubGlobal('postMessage', postSpy)

    fixture = buildFixture()
    await import('../../workers/jsonl.worker.js')
    post({ requestId: 'r-init', operationId: 'op-init', type: 'initMemory', name: 'bench.jsonl', payload: fixture })
    expect((await waitForResponse('r-init')).ok).toBe(true)

    const t0 = performance.now()
    post({ requestId: 'r-index', operationId: 'op-index', type: 'index' })
    const index = await waitForResponse('r-index')
    expect(index.ok).toBe(true)
    const indexMs = performance.now() - t0
    results.push({
      name: 'index 100k rows',
      ms: indexMs,
      msPerRow: indexMs / ROWS,
      matchedRows: ROWS,
    })
  })

  function record(name: string, ms: number, res: Envelope, expectedMatches: number): void {
    const value = res.value as { matchedRows: number }
    expect(value.matchedRows).toBe(expectedMatches) // correctness gate only
    results.push({ name, ms, msPerRow: ms / ROWS, matchedRows: value.matchedRows })
  }

  it('text filter baseline (10% match rate)', async () => {
    // Warm the read path once (first readRange after index), then measure.
    post({ requestId: 'r-warm', operationId: 'op-warm', type: 'getRows', start: 0, count: 50, generation: 1 })
    await waitForResponse('r-warm')

    const t0 = performance.now()
    post({ requestId: 'r-text', operationId: 'op-text', type: 'filter', kind: 'text', query: '"status":"error"' })
    const res = await waitForResponse('r-text')
    record('text: "status":"error"', performance.now() - t0, res, Math.floor(ROWS * ERROR_RATE))
  })

  it('jq filter baseline (.status == "error")', async () => {
    // Warm up: load the wasm singleton + compile a trivial program so the
    // measured run covers scan + per-row verdicts, not wasm startup.
    post({ requestId: 'r-jqwarm', operationId: 'op-jqwarm', type: 'filter', kind: 'jq', query: 'length' })
    const warm = await waitForResponse('r-jqwarm')
    expect(warm.ok).toBe(true)

    const t0 = performance.now()
    post({ requestId: 'r-jq', operationId: 'op-jq', type: 'filter', kind: 'jq', query: '.status == "error"' })
    const res = await waitForResponse('r-jq')
    record('jq: .status == "error"', performance.now() - t0, res, Math.floor(ROWS * ERROR_RATE))
  })

  it('prints the baseline table (record in docs/perf-baselines.md)', () => {
    const table = results.map((r) => ({
      operation: r.name,
      'ms (total)': Math.round(r.ms * 10) / 10,
      'µs/row': Math.round(r.msPerRow * 1000),
      matchedRows: r.matchedRows,
    }))
    console.log('\n--- filter performance baselines (100k rows, ~130 B/row, non-gating) ---')
    for (const row of table) {
      console.log(
        `${row.operation.padEnd(28)} ${String(row['ms (total)']).padStart(9)} ms  ` +
          `${String(row['µs/row']).padStart(6)} µs/row`,
      )
    }
    console.log('---')
    expect(results.length).toBe(3)
  })
})
