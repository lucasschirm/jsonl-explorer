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
(`.github/workflows/ci-scheduled.yml`) via `E2E_INCLUDE_WEBKIT=1`. On
failure, traces and screenshots are uploaded as `test-results/`
artifacts.

## License

MIT