# Contributing to JSONL Explorer

Thanks for helping. This repo is a pnpm monorepo: `packages/app` (Nuxt 3 SPA),
`packages/cli` (`jsonlex`), `packages/shared` (handover protocol + CSP).

## Setup

- Node.js ≥ 20.19.0 (the dev toolchain — vite 7 — needs it; CI runs Node 22
  LTS), pnpm ≥ 9.0.0 (`corepack enable` picks up the pinned
  `packageManager: pnpm@9.4.0`).
- `pnpm install`, then `pnpm dev` for the app (http://localhost:3000).

The full local gate is one command:

```bash
pnpm gate   # lint → typecheck → docs check → credits check → unit → build → e2e
```

CI runs the same checks on every PR (plus a scheduled workflow for the WebKit
smoke, the 100 MiB perf suite, and the multi-GB soak).

## Testing guide

| Layer             | Command                                             | Notes                                                                                                                                                                                                                        |
| ----------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit (Vitest)     | `pnpm test`                                         | shared 68 / app 755 / cli 77. Engine logic (scanner, indexer, filter, spool) is tested against fakes — but anything that touches the OPFS spool per-row at scale also needs a real-browser check (see perf below).           |
| E2E (Playwright)  | `pnpm test:e2e`                                     | Runs the **built** app (`pnpm build` first). Served by `packages/app/scripts/e2e-server.mjs`, which fronts the real nitro server and adds same-origin fixtures + true-streaming data endpoints. Chromium is the per-PR gate. |
| Perf budgets      | `E2E_INCLUDE_PERF=1 pnpm test:e2e`                  | 100 MiB index/filter/DOM/heap/export invariants (hard gates)                                                                                                                                                                 |
| Multi-GB soak     | `pnpm --filter jsonl-explorer-app perf:soak`        | Default 2 GiB, JSON artifact under `packages/app/artifacts/` (gitignored)                                                                                                                                                    |
| Production output | `pnpm --filter jsonl-explorer-app check:production` | `nuxi generate` → writes+validates the Cloudflare Pages output → restores the nitro server                                                                                                                                   |

**Build before you test, in this order:** `shared → app → cli`. After
touching `packages/shared` (protocol/CSP), rebuild it before app typecheck or
e2e — stale artifacts are the #1 source of "works on my machine".

## Code rules

1. **No silent failures.** Every async boundary (fetch, file read, worker RPC,
   `jq` compile/run, `JSON.parse`, export) must convert failures into a typed
   error (`{ code, message }`) that the UI renders as a toast (or the CLI
   prints as an actionable message + non-zero exit). A `catch {}` that swallows
   is a review blocker. If a failure is _intentionally_ non-fatal (e.g. browser
   auto-open in headless CI), log an explicit, user-visible reason.
2. **The worker owns data.** Nothing that scales with file size may become
   reactive (Pinia holds UI state/metadata only). Row data crosses the
   postMessage boundary as bounded, versioned chunks with request/operation IDs
   and generation guards.
3. **Small files, single responsibility.** Functions stay short (≤ ~20 lines);
   one file does one job; no duplicated functionality — if two places compute
   the same policy (CSP, cache rules, protocol), the policy lives in
   `packages/shared` and both import it.
4. **Bytes, not strings, below the decode boundary.** Source/index APIs use
   byte offsets and `Uint8Array`; decode only complete row ranges.
5. **Cleanup is part of the feature.** Workers, object URLs, writable handles,
   in-flight fetches, and OPFS artifacts must be disposed on reset, failure,
   abort, and page hide — and startup must clean stale artifacts from crashed
   sessions.
6. **Style:** Prettier (`pnpm format`) + ESLint; TypeScript strict
   (`noImplicitOverride`, `noUncheckedIndexedAccess`,
   `noPropertyAccessFromIndexSignature`).

## Pull requests

Use the PR template checklist. Before requesting review:

- `pnpm gate` is green locally;
- new/changed behavior has tests at the right layer (unit for logic, e2e for
  browser/protocol/security flows);
- user-visible failures are typed and actionable (rule 1 above);
- docs affected by the change (guides in `packages/app/content/docs/`,
  README, `docs/`) are updated in the same change;
- no temporary debug logs, no committed build output, no secrets.

## Where things live

- Guides (user docs): `packages/app/content/docs/` — one markdown file per
  page; `pnpm --filter jsonl-explorer-app check:docs` validates frontmatter and
  internal links; screenshots are captured by `pnpm screenshots` (deterministic
  fixtures — do not hand-edit `public/screenshots/`).
- Perf baselines and budgets: `docs/perf-baselines.md`.
- npm releases (tag flow, rollback/deprecation): `docs/releasing.md`.
- Architecture decisions: `packages/app/engine/config/adr.ts`.
- Worker protocol: `packages/shared/src/protocol.ts` (+ the in-app engine
  types). Handover (postMessage) protocol: `packages/shared/src/handover.ts`.
- CSP: `packages/shared/src/csp.ts` — the single source for nitro, the static
  `_headers`, and the CLI `--local` server.
