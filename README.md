# JSONL Explorer

A 100% client-side web app to open, explore, filter, edit and export multi-GB JSONL files in the browser.

**Live Demo:** https://jsonlexplorer.lucasschirm.com

## Features

- **Multi-GB support**: Stream and index files without loading entirely into memory
- **Fast filtering**: Text search and jq queries with progress and cancellation
- **JSON editing**: Inline value editing with type coercion
- **Export**: Download filtered results with edits (File System Access API + Blob fallback)
- **URL loading**: Fetch from HTTP/HTTPS with custom headers, OPFS-backed streaming
- **Handover protocol**: Embed via iframe/window.open with postMessage
- **CLI**: `npx jsonlex file.jsonl` for local file serving
- **100% client-side**: No backend, no data upload

## Quick Start

```bash
# Install dependencies
pnpm install

# Development
pnpm dev

# Build for production
pnpm build

# Preview production build
pnpm preview

# Run tests
pnpm test
pnpm test:e2e
```

## Project Structure

```
/
├─ package.json              # Workspace root
├─ pnpm-workspace.yaml       # pnpm workspaces config
├─ packages/
│  ├─ app/                   # Nuxt 3 SSG app
│  ├─ cli/                   # jsonlex CLI (fastify + tsup)
│  └─ shared/                # Shared types & handover protocol
├─ e2e/                      # Playwright E2E tests
├─ docs/                     # Internal notes (perf baselines)
└─ .github/workflows/        # CI/CD
```

## Architecture

See [PLAN.md](./tmp/PLAN.md) for full architecture details.

Key decisions documented in [ADR](./packages/app/engine/config/adr.ts):
- Deployment: Cloudflare Pages
- Node 20.11.0, pnpm 9.4.0
- Browser: Chrome ≥119, Firefox ≥120, Safari ≥17.2
- Feature detection over UA sniffing
- Thresholds configurable via env vars

## CLI Usage

```bash
# Remote mode (default) - serves file via capability URL, opens hosted app
npx jsonlex data.jsonl

# Local mode - serves bundled static site + file from localhost
npx jsonlex data.jsonl --local

# Custom port
npx jsonlex data.jsonl --port 8080

# Don't open browser
npx jsonlex data.jsonl --no-open
```

## Development

### Requirements

- Node.js 20.11.0+
- pnpm 9.4.0+

### Commands

```bash
# Lint
pnpm lint

# Format
pnpm format

# Type check
pnpm typecheck

# Unit tests
pnpm test:unit

# E2E tests
pnpm test:e2e

# Generate screenshots for docs
pnpm screenshots
```

## E2E & CI

`pnpm test:e2e` runs the Playwright suite against the **built** app
(`pnpm build` first — the app and the CLI are both exercised from their
built artifacts). The suite is served by a thin front server
(`packages/app/scripts/e2e-server.mjs`) that fronts the real nitro
server and adds:

- same-origin fixtures under `/e2e-host/*` (handover host pages, data
  files with Referer recording);
- generated data endpoints under `/e2e-fixture/*` (slow/chunked/gzip
  JSONL streams, misleading content-length, redirects, header echo,
  typed errors) — nothing large is committed.

Projects: **Chromium** runs the whole suite (PR CI); a **WebKit smoke**
subset (`e2e/smoke.spec.ts`) runs in the scheduled/manual workflow
(`.github/workflows/ci-scheduled.yml`) via `E2E_INCLUDE_WEBKIT=1`. The
**100 MiB perf budget suite** (`e2e/perf-budgets.spec.ts`) runs there
too via `E2E_INCLUDE_PERF=1`, alongside the **multi-GB soak**
(`pnpm --filter jsonl-explorer-app perf:soak`, default 2 GiB, JSON
artifact) — see `docs/perf-baselines.md` for measured numbers and the
provisional budgets.

## Deployment

Production target: **Cloudflare Pages** serving
`https://jsonlexplorer.lucasschirm.com` (chosen in TSK0001, recorded in
`tmp/PLAN.md` R8 — one provider, implemented as one protected path).

**One-time manual setup** (repo owner, not automatable from here):

1. Create a Cloudflare Pages project linked to this repository
   (build command is unused — the workflow uploads prebuilt output via
   `actions/deploy-pages`, which uses OIDC; no Cloudflare token in
   secrets).
2. Add the custom domain `jsonlexplorer.lucasschirm.com` in the Pages
   project (Cloudflare provisions HTTPS automatically; if the apex
   `lucasschirm.com` zone is on Cloudflare the DNS CNAME is created for
   you, otherwise point `jsonlexplorer` → `<project>.pages.dev`).
3. Create a **protected environment** named `production` in the repo
   settings (required reviewers / deployment branches) — the deploy
   job runs under it.

**Every deploy** (`.github/workflows/deploy.yml`, automatic):

- triggers ONLY after a green `CI` run on `main` (`workflow_run`) or on
  manual dispatch — pull requests never trigger it, so they never touch
  deploy credentials;
- `nuxi generate`s the static output (prerendered routes + SPA shell +
  content API);
- runs `pnpm --filter jsonl-explorer-app check:production`, which writes
  the Cloudflare Pages `_headers` file (CSP + security + cache rules,
  generated from the ONE shared CSP source of truth —
  `packages/shared/src/csp.ts` — so nitro, static hosting, and the CLI
  `--local` server can't drift) and validates the output the way Pages
  serves it: direct routes, generated-HTML broken-link check, worker +
  jq WASM assets, 404 semantics;
- uploads + deploys the artifact, then runs a **post-deploy smoke**
  against the live URL (routes, SPA fallback, 404, worker/WASM assets,
  exact CSP match, metadata).

Cache/security model on Pages: hashed `/_nuxt/*` assets are immutable
(1 year); HTML + the content API revalidate; every response carries
CSP (frame-ancestors `'self'` + the app policy), `Referrer-Policy:
no-referrer`, and `X-Content-Type-Options: nosniff`.

## License

MIT