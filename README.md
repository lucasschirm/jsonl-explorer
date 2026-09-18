# JSONL Explorer

A 100% client-side web app to open, explore, filter, edit and export multi-GB
JSONL files in the browser — plus a zero-runtime-dependency CLI (`jsonlex`)
that serves local files to the app.

**Live site:** https://jsonlexplorer.lucasschirm.com

## Features

- **Multi-GB support** — streaming byte-offset indexing in a Web Worker; the
  file is never parsed into memory (O(1) memory per rendered row)
- **Fast filtering** — literal text search and real `jq:` programs (jq-web
  WASM), with progress and cancellation
- **JSON editing** — inline primitive value editing with type coercion and
  per-line reset (edits are stable-ID keyed and flow into filters/counts/export)
- **Export** — filtered rows including edits, via File System Access API with
  ACK-backpressured worker chunks, or a consented Blob fallback
- **URL loading** — HTTP(S) with custom headers, streamed into OPFS with
  quota checks and cleanup; `Content-Length`/gzip semantics handled
- **Handover protocol** — embed via `window.open`/iframe with an origin- and
  source-validated postMessage protocol, or a scrubbed `?url=` bootstrap
- **CLI** — `npx jsonlex file.jsonl` (remote mode) or `--local` (bundled site)
- **100% client-side** — no backend, no upload, no analytics

## Quick start

Requirements: **Node.js ≥ 20.11.0**, **pnpm ≥ 9.0.0** (repo pins `pnpm@9.4.0`
via `packageManager`).

```bash
pnpm install        # frozen lockfile install of the workspace

pnpm dev            # Nuxt dev server for the app (http://localhost:3000)
pnpm build          # build shared → app (nuxi build) → cli (tsup + staged site)
pnpm preview        # serve the built app (run `pnpm build` first)

pnpm test           # all unit tests (shared, app, cli)
pnpm test:e2e       # Playwright e2e — builds are exercised, not dev mode
pnpm gate         # the full local gate: lint, typecheck, docs, credits,
                    # unit, build, e2e — same checks as CI
```

## Project structure

```
/
├─ package.json               # workspace root + gate scripts (incl. `pnpm gate`)
├─ pnpm-workspace.yaml
├─ packages/
│  ├─ app/                    # Nuxt 3 SPA (`ssr: false`, `nuxi generate` output)
│  │  ├─ pages/               # / (landing), /explorer, /about, /docs, /docs/:slug
│  │  ├─ engine/              # scanner, indexer, filter, jq, sources, spool (OPFS)
│  │  ├─ workers/             # jsonl.worker.ts — owns the file, indexes, filters
│  │  ├─ stores/  composables/  components/
│  │  ├─ content/docs/*.md    # guides (Nuxt Content)
│  │  ├─ e2e/                 # Playwright suites + same-origin fixtures
│  │  └─ scripts/             # e2e-server, screenshots, credits, perf soak,
│  │                          # production finalize/validate, post-deploy smoke
│  ├─ cli/                    # jsonlex — fastify server + bundled site (tsup)
│  └─ shared/                 # handover protocol + CSP source of truth
├─ docs/                      # internal notes (perf baselines)
└─ .github/workflows/         # ci.yml, ci-scheduled.yml, deploy.yml
```

## Architecture

The engine is **worker-owned**: the main thread never holds the dataset.

- A `JsonlSource` (File / URL / Memory) is structured-cloned or fetched inside
  the worker; URL bytes are spooled incrementally to **OPFS** (consented
  paged-RAM fallback) and indexed as they arrive.
- Indexing scans fixed byte chunks for line starts and stores offsets in
  geometrically grown `BigUint64Array` blocks (hi/lo Uint32 fallback). Only
  complete row ranges are decoded (UTF-8 safe across chunk boundaries);
  CRLF, trailing-newline, blank-row, and invalid-UTF-8 semantics are explicit
  and tested.
- **Pinia holds UI state and metadata only** — nothing that scales with file
  size is reactive. The UI pulls row windows imperatively over a versioned
  `postMessage` RPC (request IDs, operation IDs for cancellation, generation
  counters for stale-result guards) and renders a virtualized, fixed-height
  row list with a byte-bounded LRU.
- Filtering (text / `jq:`) scans source bytes sequentially in the worker,
  honors edit overrides, posts progress, and commits atomically; exports are
  a bounded start/next/ACK chunk stream.

Key decisions live in [`packages/app/engine/config/adr.ts`](packages/app/engine/config/adr.ts);
the original plan (deployment choice, R1–R24 gap resolutions) is in
[`tmp/PLAN.md`](tmp/PLAN.md).

## CLI

```bash
npx jsonlex data.jsonl             # remote mode: loopback server with a random
                                   # capability path, opens the hosted app
npx jsonlex data.jsonl --local     # serves the bundled static site + file from
                                   # the same origin (Safari fallback)
npx jsonlex data.jsonl --port 8080 --no-open
```

Remote mode is deliberately conservative: loopback-only binding (non-loopback
needs an explicit acknowledgement), a cryptographically random per-run
capability in the URL, CORS granted only to the exact hosted origin (with
Chrome's `Access-Control-Allow-Private-Network` preflight support), strict
Host/Origin checks, `no-store`, and clean `SIGINT`/`SIGTERM` shutdown. The
package is a single bundled file with **zero runtime dependencies** — the
packed tarball (site included) is what the tests and `npx` users get.

To try a local build instead of the published package (after `pnpm build`):

```bash
node packages/cli/dist/index.mjs data.jsonl --local --no-open
```

## Development

| Command                                             | What it does                                                                                                                                                                 |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint`                                         | ESLint (flat config, `vue` + TS)                                                                                                                                             |
| `pnpm format`                                       | Prettier over the repo                                                                                                                                                       |
| `pnpm typecheck`                                    | strict `tsc` over app, cli, shared (incl. test configs)                                                                                                                      |
| `pnpm test` / `pnpm test:unit`                      | Vitest unit suites (shared 68 / app 755 / cli 77)                                                                                                                            |
| `pnpm test:e2e`                                     | Playwright (Chromium) against the **built** app                                                                                                                              |
| `pnpm screenshots`                                  | re-capture the docs screenshots (Playwright, deterministic)                                                                                                                  |
| `pnpm --filter jsonl-explorer-app perf:soak`        | multi-GB soak (default 2 GiB, JSON artifact)                                                                                                                                 |
| `pnpm --filter jsonl-explorer-app check:production` | `nuxi generate` → write+validate the Cloudflare Pages output (writes `_headers`, checks routes/links/worker/WASM/404s) → restores the nitro server for e2e                   |
| `pnpm gate`                                           | the PR gate in one command: lint → typecheck → docs → credits → unit → build → `check:production` → e2e (everything CI runs, minus the scheduled soak/WebKit/perf additions) |

E2E runs against the built output fronted by
[`packages/app/scripts/e2e-server.mjs`](packages/app/scripts/e2e-server.mjs),
which adds same-origin fixtures (`/e2e-host/*`) and true-streaming generated
data endpoints (`/e2e-fixture/*` — slow/chunked/gzip streams, misleading
content-length, redirects, errors). Nothing large is committed. See
[`docs/perf-baselines.md`](docs/perf-baselines.md) for measured numbers, the
provisional budgets, and the hard invariants (DOM bounds, heap bounds, exact
export bytes).

## Browser support & degradation

Supported: **Chromium/Edge ≥ 119, Firefox ≥ 120, Safari ≥ 17.2** (tested on
Chromium in CI; a WebKit **smoke** subset runs in the scheduled workflow —
WebKit is not part of the per-PR gate).

Everything degrades by **feature detection, never UA sniffing**:

| Feature                | When missing                      | Behavior                                                                                                                                    |
| ---------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| OPFS                   | Safari privacy modes, some embeds | Paged in-RAM source after an explicit consent dialog (large/unknown downloads warn about quota); multi-GB URL loading is then not supported |
| File System Access API | Firefox, Safari                   | Export falls back to a Blob download; above the 512 MiB estimate an explicit confirmation is required first                                 |
| `BigUint64Array`       | older engines                     | `{hi, lo}` Uint32 offset blocks — semantics unchanged                                                                                       |
| Private Network Access | Safari                            | Remote CLI mode may be blocked by the browser — use `jsonlex --local`                                                                       |

Accessibility: WCAG 2.0/2.1 A+AA (axe, zero violations in both themes),
keyboard-only flows are e2e-tested, `prefers-reduced-motion` is respected, and
a scroll-lock/focus-trap composable drives all modals.

## Security & privacy

- **No backend, no upload, no analytics, no telemetry.** Files are read by the
  page's own worker; URL-loaded bytes live in your browser's OPFS and are
  deleted on reset, failure, abort, and page hide (stale artifacts from
  crashed sessions are cleaned on next startup).
- **Custom request headers** (URL loading) are memory-only: never serialized
  into URLs, history, logs, errors, or routes; `credentials: 'omit'` by default.
- **CLI remote mode** protects the local file with a random capability path
  and exact Origin/Host/CORS/PNA policy (see CLI section) — a website visiting
  the user's browser cannot read the served file.
- **Handover** validates `event.origin` **and** `event.source` (opener/parent),
  a versioned schema, and a payload cap; the `?url=` bootstrap is scrubbed from
  the address bar immediately after consumption and the site sends
  `Referrer-Policy: no-referrer`.
- **CSP** is a single generated source of truth
  (`packages/shared/src/csp.ts`) applied identically by nitro (dev/preview),
  the static host (`_headers` written at build time), and the CLI `--local`
  server: `default-src 'self'`, no inline scripts, `frame-ancestors` restricted,
  `nosniff`, `no-referrer`.

## Limitations (by design)

- **Value editing only** — structural JSON edits (add/remove/rename keys) are
  out of scope (PLAN.md stretch goal). Edits coerce with `JSON.parse` and fall
  back to strings.
- **No persistence** — state is per-session and in-memory; refreshing
  `/explorer` returns you to the landing page. Edits survive only until you
  close the tab (export to keep them). There is no undo stack — "Reset line"
  reverts a single row to its original text.
- **Text filter is literal** — case-sensitive substring (v1); use `jq:` for
  structured matching.
- **One file at a time** — opening a new file resets the session.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the dev loop, testing guide, and
the **no-silent-failure** rule that governs code review. Pull requests use the
checklist in [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md)
and must be green on CI (lint, typecheck, docs, credits, unit, build, e2e)
before merge.

## Deployment

Production target: **Cloudflare Pages** serving
https://jsonlexplorer.lucasschirm.com (one provider, one protected path).

**One-time manual setup** (repo owner, not automatable): create the Pages
project linked to this repo, add the custom domain (Cloudflare provisions
HTTPS), and create a protected environment named `production` in the repo
settings (the deploy job's approval gate).

**Every deploy** (`.github/workflows/deploy.yml`, automatic):

- triggers ONLY after a green CI run on `main` (`workflow_run`) or on manual
  dispatch — PRs never trigger it and never touch deploy credentials;
- `nuxi generate`s the static output, then
  `pnpm --filter jsonl-explorer-app finalize:production` writes the Cloudflare
  Pages `_headers` (generated from the shared CSP source) and validates the
  output the way Pages serves it: direct routes, generated-HTML broken-link
  check, worker + jq WASM assets, 404 semantics;
- uploads + deploys with OIDC (no Cloudflare token in secrets), then runs a
  **post-deploy smoke** against the live URL (routes, SPA fallback, 404,
  worker/WASM assets, exact CSP match, metadata).

Cache/security model on Pages: hashed `/_nuxt/*` assets are immutable
(1 year); HTML + the content API revalidate (`no-store`); every response
carries the app CSP, `Referrer-Policy: no-referrer`, and
`X-Content-Type-Options: nosniff`.

## License

MIT — runtime dependency licenses (including bundled transitives) are audited
at build time and listed on the in-app **About** page.
