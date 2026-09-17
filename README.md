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

## License

MIT