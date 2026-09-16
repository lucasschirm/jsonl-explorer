---
title: Embedding & Handover
description: Use postMessage API to load JSONL data into an embedded explorer
---

# Embedding & Handover

JSONL Explorer can be embedded in other applications via iframe or `window.open` and receive data through a secure postMessage protocol.

## Embedding

### Iframe

```html
<iframe
  src="https://jsonlexplorer.lucasschirm.com/explorer"
  style="width: 100%; height: 800px; border: none;"
  allow="clipboard-read clipboard-write"
></iframe>
```

### Window Open

```javascript
const explorer = window.open('https://jsonlexplorer.lucasschirm.com/explorer', 'jsonl-explorer', 'width=1200,height=800')
```

## Handover Protocol

After the explorer loads and announces readiness, send data via postMessage:

```javascript
// 1. Listen for ready signal
window.addEventListener('message', (event) => {
  if (event.data.ns === 'jsonl-explorer' && event.data.type === 'ready') {
    // 2. Send data
    explorer.postMessage({
      ns: 'jsonl-explorer',
      v: 1,
      type: 'load',
      name: 'data.jsonl',
      payload: jsonlString // or ArrayBuffer (transferable)
    }, 'https://jsonlexplorer.lucasschirm.com')
  }
})
```

### Message Types

| Direction | Type | Purpose |
|-----------|------|---------|
| Explorer → Parent | `ready` | Explorer initialized, ready for data |
| Parent → Explorer | `load` | Send JSONL data (string or ArrayBuffer) |
| Explorer → Parent | `loaded` | Data loaded successfully ({ lines: number }) |
| Explorer → Parent | `error` | Load failed ({ message: string }) |

### Security

- Validates `event.origin` AND `event.source` (opener or parent)
- Allowlist configured at build time (`VITE_HANDOVER_ALLOWED_ORIGINS`)
- Payload capped at 100 MiB (use URL loading for larger files)
- 30-second timeout for load after ready
- Duplicate load messages rejected
- Replies only to validated source and exact origin

## URL Bootstrap Alternative

For public URLs without headers, use the `?url=` parameter:

```
https://jsonlexplorer.lucasschirm.com/explorer?url=https://example.com/data.jsonl
```

This is simpler but doesn't support custom headers.

## CSP & Sandbox

If embedding in an iframe with CSP/sandbox, ensure:

```html
<iframe
  src="https://jsonlexplorer.lucasschirm.com/explorer"
  sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
  csp="script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' https:;"
></iframe>
```

Required permissions:
- `allow-scripts` — JavaScript execution
- `allow-same-origin` — Origin preservation for postMessage
- `allow-forms` — File input (if using file picker)
- `allow-popups` — For any popup workflows
- CSP: `wasm-unsafe-eval` for jq-web, `blob:` for workers