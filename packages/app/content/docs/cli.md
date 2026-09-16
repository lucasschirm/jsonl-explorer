---
title: CLI (jsonlex)
description: Install and use the jsonlex CLI to serve local files securely
---

# CLI (jsonlex)

The `jsonlex` CLI serves local JSONL files via a secure local server and opens the explorer in your browser.

## Installation

```bash
# One-off use
npx jsonlex data.jsonl

# Global install
npm install -g jsonlex
jsonlex data.jsonl
```

## Modes

### Remote Mode (Default)

```bash
jsonlex data.jsonl
```

- Binds to `127.0.0.1` on an ephemeral port
- Generates a cryptographically random capability token
- Serves only `/{capability}/file.jsonl` with strict CORS
- Opens `https://jsonlexplorer.lucasschirm.com/?url=...` in browser

**Security**: The capability token prevents any website from reading your local file. Only the exact hosted origin can access the file.

### Local Mode

```bash
jsonlex data.jsonl --local
```

- Serves the bundled static site + file from the same origin
- Opens `http://127.0.0.1:{port}/?url=...` (relative URL)
- Works in Safari (no Private Network Access issues)
- No external network requests

## Options

| Option | Description |
|--------|-------------|
| `--port <n>` | Bind to specific port (default: ephemeral) |
| `--host <h>` | Bind to specific host (default: 127.0.0.1) |
| `--no-open` | Don't open browser automatically |
| `--local` | Serve static site locally (same-origin) |
| `--help` | Show help |
| `--version` | Show version |

## Security

- **Capability token**: 256-bit random path, unguessable
- **CORS**: Only `https://jsonlexplorer.lucasschirm.com` allowed
- **PNA Header**: `Access-Control-Allow-Private-Network: true` for Chrome
- **Host validation**: Rejects non-loopback Host headers
- **No-store**: `Cache-Control: no-store` on all responses
- **Clean shutdown**: SIGINT/SIGTERM handled gracefully

## Requirements

- Node.js 20.11.0+
- File must exist and be readable