/**
 * jq execution backend (TSK0027).
 *
 * This is the ONLY module that imports `jq-web`. The worker wires it into
 * FilterEngine through the `JqRuntimeLike` interface, so the backend stays
 * replaceable (a faster WASM build or a native binding can be swapped in
 * without touching the engine or the UI — the UI never imports jq).
 *
 * jq-web 0.5.x exposes no compiled-program handle: every call re-enters
 * jq's main() and re-parses the filter (measured ~40 ms per row). To make
 * jq filtering viable we therefore:
 *
 *  (build note: the WASM build `jq.wasm.js` + `jq.wasm.wasm` is used — see
 *  the Build choice section at the bottom of this comment)
 *
 *  - wrap the user filter in a VERDICT program that emits exactly one
 *    boolean per input (`true` when at least one output is neither false
 *    nor null — the documented truthiness rule; `false` otherwise, which
 *    also covers the `empty` output);
 *  - feed batches of row texts through one call, so the per-call overhead
 *    is amortized (measured ~47 µs/row in 2048-row batches);
 *  - PRE-VALIDATE every row with JSON.parse before it reaches jq.
 *    jq-web 0.5.1 has a library defect: a malformed JSON INPUT silently
 *    kills the whole module (no throw; every later call returns ""),
 *    while jq's own errors (filter parse / runtime) throw and leave the
 *    module usable. Invalid rows are therefore counted on the JS side and
 *    never fed to the runtime;
 *  - fall back to row-by-row execution when a batch aborts (a runtime
 *    error in one row kills the whole jq stream), so a single bad row is
 *    counted and skipped instead of failing the filter.
 *
 * Build choice (validated in this spike): the WASM build
 * (`jq-web/jq.wasm.js` glue + `jq.wasm.wasm` binary, the README-recommended
 * "best" build) is used. It fixes a fatal defect in the asm.js bundle and
 * measures ~11 µs/row in 2048-row batches vs ~47 µs/row for the bundle.
 *
 *  - The asm.js BUNDLE (`jq-web`'s main export, `jq.asm.bundle.min.js`,
 *    ~1.75 MB) crashes on filters that reach 64-bit return paths (e.g.
 *    `.i % 2`): its glue reads `env.getTempRet0`, which the asm.js
 *    environment never provides (`TypeError: wA is not a function` —
 *    uncatchable from user code, and it terminates the worker process).
 *  - The malformed-INPUT poisoning defect above exists in BOTH builds
 *    (same jq C core), which is why pre-validation is not optional.
 *  - The glue fetches `jq.wasm.wasm` next to its own script URL
 *    (`scriptDirectory + 'jq.wasm.wasm'`). In the production worker the
 *    chunk lives in `/_nuxt/`, so nuxt.config.ts copies the binary to
 *    `/_nuxt/jq.wasm.wasm` at build time and serves it in dev. The CSP
 *    already allows it (`wasm-unsafe-eval`, `connect-src 'self'`).
 *  - Tests (vitest/happy-dom) install a fetch shim that serves the
 *    package's real binary bytes (tests/helpers/jqWasmShim.ts).
 *
 * Both builds' sizes are recorded in JQ_CONFIG (engine/config/adr.ts).
 */

import { FilterCancelledError } from './filter.js'

/** Max rows per batch (responsiveness: cancel/progress between batches). */
export const JQ_BATCH_MAX_ROWS = 2048
/** Max decoded bytes per batch (a huge row still gets its own batch). */
export const JQ_BATCH_MAX_BYTES = 256 * 1024

/**
 * One verdict per input row: true = the row matches (at least one output
 * that is neither false nor null), false = no match or the row is
 * invalid/errored (counted in errorCount). `errorRows` flags the exact
 * rows that errored (pre-validation failures and isolated runtime errors),
 * letting callers keep per-row error state (edit re-evaluation, TSK0030).
 */
export interface JqVerdicts {
  verdicts: boolean[]
  errorRows: boolean[]
  errorCount: number
  firstError?: string
}

/** The replaceable jq backend surface (implemented by JqRuntime). */
export interface JqRuntimeLike {
  /**
   * Validates the filter (a probe run; parse errors are fatal) and returns
   * the opaque program used by runVerdicts.
   */
  compile(query: string): Promise<string>
  /** Runs the program over a batch of row texts (one verdict per text). */
  runVerdicts(
    program: string,
    rows: string[],
    isAborted: () => boolean,
  ): Promise<JqVerdicts>
  /**
   * Runs the program against ONE JSON document and returns every output
   * in emission order (may be empty). Unlike runVerdicts the program is
   * NOT verdict-wrapped — local jq search shows the raw outputs. A parse
   * or runtime error propagates to the caller (classify with
   * isJqParseError / jqErrorText).
   */
  runOutputs(program: string, text: string): Promise<unknown[]>
}

/** Typed user-facing error: the jq filter does not parse. */
export class JqCompileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JqCompileError'
  }
}

/** Minimal jq-web module surface (see workers/worker.d.ts for the full one). */
export interface JqWebLike {
  onInitialized: { addListener(cb: () => void): void }
  raw(input: string, filter: string, flags?: string[]): string
}

/**
 * Wraps a user filter so each input yields exactly one compact boolean:
 * `true` iff the filter produced at least one output that is neither
 * `false` nor `null`. `empty` output and all-false/null output yield
 * `false`. The wrapper guarantees one output line per input, which is what
 * keeps batched execution attributable row-by-row.
 */
export function wrapVerdict(query: string): string {
  return `([ (${query}) | select(. != false and . != null) ] | length) > 0`
}

/**
 * jq-web destroys `Error.message` (it keeps only the last `:`-segment of
 * stderr) and stashes the FULL stderr text on `stack`. Only trust `stack`
 * when it actually reads like jq output — a genuine JS stack starts with
 * the constructor name, and a poisoned module throws FS errors whose
 * stack is the placeholder "<generic error, no stack>".
 */
export function jqErrorText(error: unknown): string {
  const stack = (error as { stack?: unknown } | null)?.stack
  if (typeof stack === 'string' && /^jq: error/.test(stack)) {
    return stack.trim().replace(/\s+/g, ' ')
  }
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return String(error)
}

/**
 * jq error classification: a PARSE (compile) error prints
 * `jq: error: syntax error, ...`; a RUNTIME error prints
 * `jq: error (at <stdin>:N): ...`. The presence of `(at` distinguishes
 * them.
 */
export function isJqParseError(error: unknown): boolean {
  const text = jqErrorText(error)
  return /jq: error:/.test(text) && !/jq: error \(at/.test(text)
}

/** The real backend, backed by the pinned jq-web build. */
export class JqRuntime implements JqRuntimeLike {
  constructor(private readonly jq: JqWebLike) {}

  async compile(query: string): Promise<string> {
    const program = wrapVerdict(query)
    try {
      // Probe run: a parse error means the filter is invalid. A runtime
      // error on the `null` probe is NOT fatal — the program may be valid
      // for real rows (e.g. `.a.b | length` errors on null).
      this.jq.raw('null', program, ['-c'])
    } catch (error) {
      if (isJqParseError(error)) throw new JqCompileError(jqErrorText(error))
    }
    return program
  }

  async runVerdicts(
    program: string,
    rows: string[],
    isAborted: () => boolean,
  ): Promise<JqVerdicts> {
    const verdicts = new Array<boolean>(rows.length).fill(false)
    const errorRows = new Array<boolean>(rows.length).fill(false)
    let errorCount = 0
    let firstError: string | undefined
    // Pre-validation: blank or unparseable rows are counted here and NEVER
    // reach jq (a malformed input silently kills the jq-web module — see
    // the module header). Only validated rows are batched below.
    const valid: { index: number; text: string }[] = []
    for (let k = 0; k < rows.length; k++) {
      const text = rows[k]
      if (text === undefined || text.trim() === '') {
        errorCount++
        errorRows[k] = true
        firstError ??= 'Invalid JSON (empty row)'
        continue
      }
      try {
        JSON.parse(text)
      } catch {
        errorCount++
        errorRows[k] = true
        firstError ??= 'Invalid JSON (row is not a JSON value)'
        continue
      }
      valid.push({ index: k, text })
    }
    for (const batch of this.batches(valid, isAborted)) {
      try {
        const out = this.jq.raw(batch.map((r) => r.text).join('\n'), program, ['-c'])
        const lines = out === '' ? [] : out.split('\n')
        if (lines.length !== batch.length) {
          // A valid batch can never produce empty/mismatched output; treat
          // it like an aborted stream and isolate row-by-row.
          throw new Error(`jq output desync: ${lines.length} lines for ${batch.length} inputs`)
        }
        for (let k = 0; k < batch.length; k++) {
          const row = batch[k]
          if (row === undefined) continue
          verdicts[row.index] = lines[k] === 'true'
        }
      } catch (error) {
        if (error instanceof FilterCancelledError) throw error
        // A jq runtime error aborts the whole stream (the module itself
        // survives). Re-run the batch row-by-row to isolate the offenders.
        const isolated = this.isolateBatch(program, batch, isAborted)
        for (let k = 0; k < batch.length; k++) {
          const row = batch[k]
          if (row === undefined) continue
          verdicts[row.index] = isolated.verdicts[k] === true
        }
        for (let k = 0; k < isolated.errorRows.length; k++) {
          if (isolated.errorRows[k]) {
            const row = batch[k]
            if (row !== undefined) errorRows[row.index] = true
          }
        }
        errorCount += isolated.errorCount
        firstError ??= isolated.firstError
      }
    }
    return { verdicts, errorRows, errorCount, firstError }
  }

  /**
   * Single-document execution (local jq search, TSK0033): one compact
   * output line per result, parsed back into values. The input is
   * expected to be validated JSON (the caller guards it — malformed input
   * silently kills the module, same rule as runVerdicts).
   */
  async runOutputs(program: string, text: string): Promise<unknown[]> {
    const out = this.jq.raw(text, program, ['-c'])
    if (out === '') return []
    return out.split('\n').map((line) => JSON.parse(line))
  }

  /**
   * Splits validated rows into batches bounded by row count and decoded
   * bytes. Cancellation is checked between batches (a single in-flight
   * call is synchronous and uninterruptible; batches stay small).
   */
  private *batches(
    valid: { index: number; text: string }[],
    isAborted: () => boolean,
  ): Generator<{ index: number; text: string }[]> {
    let i = 0
    while (i < valid.length) {
      if (isAborted()) throw new FilterCancelledError('Filter cancelled')
      let end = i
      let bytes = 0
      while (
        end < valid.length &&
        end - i < JQ_BATCH_MAX_ROWS &&
        bytes < JQ_BATCH_MAX_BYTES
      ) {
        const text = valid[end]?.text
        bytes += text?.length ?? 0
        end++
      }
      yield valid.slice(i, end)
      i = end
    }
  }

  /**
   * Row-by-row fallback over VALIDATED rows: isolates jq runtime errors
   * into per-row counts without failing the whole scan.
   */
  private isolateBatch(
    program: string,
    chunk: { index: number; text: string }[],
    isAborted: () => boolean,
  ): JqVerdicts {
    const verdicts = new Array<boolean>(chunk.length).fill(false)
    const errorRows = new Array<boolean>(chunk.length).fill(false)
    let errorCount = 0
    let firstError: string | undefined
    for (let k = 0; k < chunk.length; k++) {
      if (isAborted()) throw new FilterCancelledError('Filter cancelled')
      const text = chunk[k]?.text
      if (text === undefined) continue
      try {
        const out = this.jq.raw(text, program, ['-c'])
        verdicts[k] = out.trim() === 'true'
      } catch (error) {
        if (error instanceof FilterCancelledError) throw error
        errorCount++
        errorRows[k] = true
        firstError ??= jqErrorText(error)
      }
    }
    return { verdicts, errorRows, errorCount, firstError }
  }
}

let runtimePromise: Promise<JqRuntime> | null = null

/**
 * Lazily loads and initializes the jq backend (singleton). The dynamic
 * import keeps the WASM glue + binary out of every code path that never
 * runs a jq filter.
 */
export function getJqRuntime(): Promise<JqRuntime> {
  if (!runtimePromise) {
    runtimePromise = import('jq-web/jq.wasm.js').then((mod) => {
      const jq = ((mod as { default?: JqWebLike }).default ?? mod) as JqWebLike
      return new Promise<JqRuntime>((resolve) => {
        jq.onInitialized.addListener(() => resolve(new JqRuntime(jq)))
      })
    })
  }
  return runtimePromise
}
