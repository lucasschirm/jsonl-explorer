# Performance baselines

Reference numbers for the indexing/filter pipeline. Two tiers:

1. **Unit tier** — vitest/happy-dom with the real in-process worker
   (fast, every run).
2. **Browser tier** — real Chromium against the BUILT app, data streamed
   from the e2e fixture server (100 MiB budget suite + multi-GB soak;
   scheduled CI + local only).

None of these are CI-gating gates yet: they are the baselines that
budgets are compared against, and the budgets themselves are
**provisional** (wide margins) until three stable scheduled-CI runs
shape tighter numbers (TSK0029, TSK0053).

## Unit tier (dev machine, happy-dom)

How to re-measure:

```sh
pnpm --filter ./packages/app test:unit -- filter-perf
```

The spec (`packages/app/tests/unit/filter-perf.spec.ts`) prints a table
after the text and jq runs. Only correctness is asserted; the timing
rows are for humans. Update the table below when you observe a
significant regression (rule of thumb: >2×).

Fixture:

- 100,000 rows of log-shaped JSON, ~130 bytes/row (~13 MiB total).
- 10% of rows carry `"status":"error"` (10,000 matches).
- Memory source (in-process worker test harness).

Numbers (dev machine, 2025-09, Node 24):

| Operation                        | Total   | µs/row |
| -------------------------------- | ------: | -----: |
| Index 100k rows                  |  62.7 ms |    1 |
| Text filter `"status":"error"`   |  77.5 ms |    1 |
| jq `.status == "error"`          | 2218.7 ms |  22 |

Notes:

- **Text ≈ raw byte scan.** The scan decodes rows and runs `includes`;
  no JSON parsing (verified by test — the text path never calls
  `JSON.parse`).
- **Chunked source reads (TSK0053).** Scans read the spool in aligned
  2 MiB spans, not one `readRange` per row. The per-row read mattered
  only on OPFS-backed sources (~0.3 ms round-trip each — a 400k-row
  text filter measured **141 s** before the fix vs **0.8 s** after; the
  in-memory unit source hid it because its reads are free).
- **jq end-to-end (22 µs/row)** includes, per row: chunked read +
  JS `JSON.parse` pre-validation (mandatory — jq-web poisoning defense,
  TSK0027) + batched WASM verdicts (batches of 2048 rows). The pure-WASM
  microbenchmark (TSK0027) measured 11 µs/row; the difference is the
  pre-validation + read overhead.
- happy-dom adds overhead vs. a real browser worker. Numbers vary ±20%
  run-to-run; re-measure three times before declaring a regression.

## Browser tier (real Chromium, built app, streamed data)

### What runs where

- **`e2e/perf-budgets.spec.ts`** — 100 MiB stream (409,600 rows @
  256 B) into the built app: index time, text filter (exactly 11,111
  matches — also a correctness check), DOM bounds while scrolling the
  whole list, main-thread heap, cancellation latency on a slow 600 MiB
  stream, and export backpressure (filtered view through a mocked FSA
  writable). Runs with `E2E_INCLUDE_PERF=1` (scheduled CI + local; not
  in the default PR run).
- **`scripts/perf-soak.mjs`** — the same exercise at multi-GB scale
  (default 2 GiB = 8,388,608 rows), plus `navigator.storage.estimate()`
  before/after and full OPFS cleanup. Writes a JSON artifact to
  `packages/app/artifacts/` (gitignored) and exits non-zero when a hard
  invariant fails. Scheduled CI uploads the artifact.

How to run:

```sh
# 100 MiB budget suite (needs the built app; the e2e server auto-starts)
E2E_INCLUDE_PERF=1 pnpm --filter jsonl-explorer-app test:e2e -- e2e/perf-budgets.spec.ts

# multi-GB soak (default 2 GiB; everything is streamed, nothing on disk)
pnpm --filter jsonl-explorer-app perf:soak
# scale knobs:
SOAK_BYTES=5368709120 SOAK_ROW_BYTES=256 pnpm --filter jsonl-explorer-app perf:soak
```

### Measured numbers (dev machine, headless Chromium 143 / Playwright 1.63, Node 24, Linux)

100 MiB (409,600 rows):

| Metric                        | Value            |
| ----------------------------- | ---------------: |
| Index (stream + 409,600 rows) | ~2.4 s           |
| Text filter (11,111 matches)  | ~0.8 s           |
| Export (11,111 rows, FSA)     | ~4 s             |
| Main-thread heap after index  | ~17 MiB          |
| Max rendered row items        | 43               |
| Cancellation (slow stream)    | ~80 ms           |

2 GiB (8,388,608 rows) soak:

| Metric                        | Value             |
| ----------------------------- | ----------------: |
| Index (stream + 8.4M rows)    | ~46 s             |
| Text filter (111,111 matches) | ~13.6 s           |
| Export (111,111 rows, FSA)    | ~46 s             |
| Main-thread heap after index  | ~169 MiB          |
| Max rendered row items        | 44                |
| Cancellation                  | ~60 ms            |
| OPFS usage (after index)      | ~2.15 GB / 12.9 GB quota |
| OPFS usage (after cleanup)    | 0                 |

### Provisional budgets

Hard invariants (a failure fails the run):

| Invariant                              | Limit      |
| -------------------------------------- | ---------: |
| Max rendered row items (virtualization)| ≤ 256 (e2e) / ≤ 512 (soak) |
| Main-thread heap after index           | < 1536 MiB |
| Export heap growth (e2e)               | < 512 MiB  |
| Export delivered bytes                 | exactly matchedRows × rowBytes |
| 100 MiB stream lands in OPFS (no in-memory-fallback consent) | n/a (fail fast) |

Wall-clock (provisional — wide margins until three stable CI runs):

| Metric              | e2e 100 MiB | soak 2 GiB |
| ------------------- | ----------: | ---------: |
| Index               | < 120 s     | < 900 s    |
| Text filter         | < 120 s     | < 600 s    |
| Export (filtered)   | < 120 s     | < 600 s    |
| Cancellation settle | < 10 s      | < 30 s     |

### Notes

- **Heap is MAIN-THREAD only.** `performance.memory` cannot see the
  worker heap, where the index and row buffers live. The invariant
  guards against main-thread bloat (e.g. an eager parsed dataset); it
  is not a measurement of total process memory.
- **The index is a compact offset table, not a parsed dataset.** At
  2 GiB the main-thread heap is ~169 MiB and OPFS holds the raw bytes —
  rows are decoded on demand (filter/export/detail), never all at once.
- **Export scales linearly** with the exported byte count (~0.6 MiB/s
  through the mocked-FSA chunk-ack pipeline in headless runs).
- **Variability:** expect ±30% on wall-clock numbers across machines
  (CI runners are much slower than a dev laptop; the budgets carry that
  margin). Re-measure three times before tightening a budget.
- **`waitForFunction` timeout trap (TSK0053):** this Playwright build
  clamps `page.waitForFunction` to 30 s regardless of the `timeout`
  option — the soak polls manually and the e2e spec uses `expect.poll`.
  Do not reintroduce `waitForFunction` for long waits.
