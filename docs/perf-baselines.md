# Performance baselines

Non-gating reference numbers for the filter pipeline, measured with the
**real in-process worker** (indexer + `FilterEngine` + memory source +
jq-web WASM) under vitest/happy-dom on the dev machine
(2025-09, Node 24). These are NOT performance budgets — they are the
baseline that future budgets must be compared against (TSK0029).

## How to re-measure

```sh
pnpm --filter ./packages/app test:unit -- filter-perf
```

The spec (`packages/app/tests/unit/filter-perf.spec.ts`) prints a table
after the text and jq runs. Only correctness is asserted; the timing
rows are for humans. Update the table below when you observe a
significant regression (rule of thumb: >2×).

## Fixture

- 100,000 rows of log-shaped JSON, ~130 bytes/row (~13 MiB total).
- 10% of rows carry `"status":"error"` (10,000 matches).
- Memory source (in-process worker test harness).

## Baseline numbers (dev machine, happy-dom)

| Operation                        | Total  | µs/row |
| -------------------------------- | -----: | -----: |
| Index 100k rows                  |  62.7 ms |    1 |
| Text filter `"status":"error"`   |  77.5 ms |    1 |
| jq `.status == "error"`          | 2218.7 ms |  22 |

### Notes

- **Text ≈ raw byte scan.** One `readRange` per row + `includes`; no
  JSON parsing (verified by test — the text path never calls
  `JSON.parse`).
- **jq end-to-end (22 µs/row)** includes, per row: `readRange` +
  JS `JSON.parse` pre-validation (mandatory — jq-web poisoning
  defense, TSK0027) + batched WASM verdicts (batches of 2048 rows).
  The pure-WASM microbenchmark (TSK0027) measured 11 µs/row; the
  difference is the pre-validation + per-row read overhead.
- happy-dom adds overhead vs. a real browser worker; expect similar or
  better numbers in production. Browsers also read from OPFS spool
  instead of in-memory, which adds range-read latency for cold rows.
- Numbers vary ±20% run-to-run; re-measure three times before
  declaring a regression.
