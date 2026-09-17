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
The package is self-contained: the server and the explorer site (`--local`
mode) are bundled, so installing it pulls **no runtime dependencies**.

## Modes

### Remote Mode (Default)

```bash
jsonlex data.jsonl
```

- Binds to `127.0.0.1` on an ephemeral port
- Generates a cryptographically random 256-bit capability token per run
- Serves only `/{capability}/file.jsonl` (GET/HEAD, RFC 7233 ranges)
- Opens `https://jsonlexplorer.lucasschirm.com/?url=...` in the browser
- If no browser can be opened (headless environments), the CLI warns and
  keeps serving — the URL above is still usable

**Security**: The capability token is the authorization — a wrong token is
just an unknown route (404, no metadata, no timing side channel). CORS on
top of it is convenience for the hosted page, never the protection:

- remote mode: only the exact hosted explorer Origin may read the file;
  an absent Origin (non-browser clients) is denied;
- `--local` mode: the same-origin page is allowed (its plain GET carries
  no Origin); a present Origin must be exactly the loopback origin;
- the Host header must be a loopback hostname (exact match —
  `127.0.0.1.evil.com` does not pass);
- responses never use a wildcard `Access-Control-Allow-Origin`, always
  send `Vary: Origin`, and rejected requests get 403 without CORS headers;
- Chrome's Private Network Access header
  (`Access-Control-Allow-Private-Network: true`) is sent in remote mode,
  where a less-private page talks to the loopback server.

**Output hygiene**: the capability is a read credential. Routine log lines
redact it (`[capability]`); it is printed in full only where intentional —
the `Opening:` line in default mode, or both URLs with `--no-open` (where
you need them).

### Local Mode

```bash
jsonlex data.jsonl --local
```

- Serves the bundled static site (staged from the app build at package
  time) + file from the same origin
- Opens `http://127.0.0.1:{port}/?url=...` (same-origin bootstrap)
- Works in Safari (no Private Network Access issues)
- No external network requests
- Hashed site assets are served `immutable` (cached per installed
  version); document entries revalidate, so a CLI upgrade cannot serve a
  stale `index.html`. No directory listings, no dotfiles.

## Options

| Option | Description |
|--------|-------------|
| `--port <n>` | Bind to specific port (default: ephemeral) |
| `--host <h>` | Bind to specific host (default: 127.0.0.1) |
| `--no-open` | Don't open browser automatically (both URLs are printed) |
| `--local` | Serve static site locally (same-origin) |
| `--insecure-local-network` | Required together with `--local` for a non-loopback `--host`: acknowledges that other devices on your network can now reach the server (the capability URL still guards the file) |
| `--help` | Show help |
| `--version` | Show version |

### Argument behavior

- Exactly one positional (the file); extra arguments are a typed error.
- `--` ends option parsing, so dash-prefixed names work:
  `jsonlex -- -weird.jsonl`.
- Duplicate options: the last occurrence wins.
- Unknown options are a typed, actionable error (with a `--help` hint).

## Security

- **Capability token**: 256-bit random path segment, unguessable; the file
  is readability-checked before the server listens
- **CORS**: see the mode notes above (exact origins only, never wildcard)
- **PNA header**: `Access-Control-Allow-Private-Network: true` (remote mode)
- **Host validation**: loopback hostnames only, exact match
- **Ranges**: RFC 7233 single ranges (`start-end`, `start-`, `-N`);
  over-long ends clamp, unsatisfiable → 416, multi-range/garbage → 416
- **Methods**: GET/HEAD only; anything else on the file route is 404
  (methods are not advertised)
- **No-store**: `Cache-Control: no-store` on the file and document responses
- **Clean shutdown**: SIGINT/SIGTERM handled gracefully (open connections
  are closed, exit 0); a busy port exits 1 with an actionable message

## Requirements

- Node.js 20.11.0+
- The file must exist and be a regular, readable file (validated before the
  server starts; failures are one-line typed errors)