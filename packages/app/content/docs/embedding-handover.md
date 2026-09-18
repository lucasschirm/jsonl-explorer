---
title: Embedding & Handover
description: Use postMessage API to load JSONL data into an embedded explorer
---

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

After the explorer loads and announces readiness, send data via postMessage.
**Validate on the sender side too**: exact origin AND exact window — the
same trust boundary the explorer applies to you.

```javascript
const EXPLORER_ORIGIN = 'https://jsonlexplorer.lucasschirm.com'
const explorer = window.open(
  EXPLORER_ORIGIN + '/explorer', 'jsonl-explorer', 'width=1200,height=800')

// 1. Listen for the ready signal — from the exact window, on the exact origin
window.addEventListener('message', (event) => {
  if (event.origin !== EXPLORER_ORIGIN) return        // exact origin, never '*'
  if (event.source !== explorer) return               // exact window identity
  if (event.data?.ns !== 'jsonl-explorer' || event.data?.v !== 1) return
  if (event.data.type !== 'ready') return
  // 2. Send data (targetOrigin is exact — a wildcard would expose it to
  //    any window that can hear postMessage)
  explorer.postMessage({
    ns: 'jsonl-explorer',
    v: 1,
    type: 'load',
    name: 'data.jsonl',
    payload: jsonlString // or ArrayBuffer (transferred, zero-copy)
  }, EXPLORER_ORIGIN)
})
```

For an **iframe** embed the same rules apply with `iframe.contentWindow`
as the window and the iframe's `src` origin as `EXPLORER_ORIGIN`.

### Message Types

| Direction | Type | Purpose |
|-----------|------|---------|
| Explorer → Parent | `ready` | Explorer initialized, ready for data |
| Parent → Explorer | `load` | Send JSONL data (string or ArrayBuffer) |
| Explorer → Parent | `loaded` | Data loaded successfully ({ lines: number }) |
| Explorer → Parent | `error` | Load failed ({ message: string }) |

### Security

- Validates `event.origin` AND `event.source` — the source must be exactly
  the opener (`window.open`) or the embedding parent (iframe); any other
  window is ignored, even from an allowed origin.
- Allowlist configured at build time (`VITE_HANDOVER_ALLOWED_ORIGINS`,
  comma-separated exact origins). Defaults to same-origin. `*` is
  **rejected** (fail closed) — a wildcard target origin would let any
  window read the explorer's replies.
- Payload capped at 100 MiB in BYTES (UTF-8); oversized loads get an
  `error` reply and the handshake stays armed for a retry. Use URL
  loading for larger files.
- 30-second timeout: if no `load` arrives within 30 s of `ready`, the
  receiver is disarmed and the page stays usable (the drop zone remains
  for manual use). The host should time out on its side too.
- One session per page visit: the first SUCCESSFUL `load` takes ownership
  for good; duplicates are ignored silently (so a well-meaning retry
  cannot be mistaken for a failure). A FAILED load takes no ownership, so
  the host may retry within the timeout window.
- These behaviors are exercised by a real-browser harness (Playwright):
  `window.open` hosts, sandboxed iframes, and a hostile page on an
  unallowed origin (which can neither trigger a load nor receive any
  reply).
- Replies (`loaded`/`error`) go only to the validated source with the
  validated exact origin — never `*`.
- `loaded` is an **async completion notice**: it carries the row count,
  which only exists once the background index commits. Treat `load` as
  the handshake ack; don't block the host's UI on `loaded` (indexing a
  100 MiB file can take a while). An `error` reply means the load (or its
  index) failed — the explorer stays open for manual recovery.

## URL Bootstrap Alternative

For public URLs without headers, use the `?url=` parameter:

```text
https://jsonlexplorer.lucasschirm.com/explorer?url=https://example.com/data.jsonl
```

This is simpler but doesn't support custom headers.

## CSP & Sandbox

The explorer ships its own `Content-Security-Policy` header, so you do not
set one from the host page (an iframe's CSP cannot be set via an attribute):

```text
default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline';
style-src 'self' 'unsafe-inline'; worker-src 'self' blob:;
connect-src 'self' https:; font-src 'self' data:; img-src 'self' data:;
object-src 'none'; base-uri 'self'; form-action 'self';
frame-ancestors <handover allowlist>
```

The parts that matter for embedding:
- `frame-ancestors` — the ONLY framing policy (built from the same
  `VITE_HANDOVER_ALLOWED_ORIGINS` allowlist). An origin not on the
  allowlist gets a browser-level refusal to load the iframe at all.
- `worker-src 'self' blob:` — the Web Worker that indexes/filters/exports.
- `connect-src 'self' https:` — URL loading is a same-page `fetch`.
- `script-src … 'wasm-unsafe-eval'` — reserved for the WASM jq build.

If you want to SANDBOX the iframe, keep at least these flags (dropping
`allow-same-origin` changes the iframe's origin and breaks the postMessage
origin check on both sides):

```html
<iframe
  src="https://jsonlexplorer.lucasschirm.com/explorer"
  sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
  allow="clipboard-read clipboard-write"
></iframe>
```

- `allow-scripts` — JavaScript execution
- `allow-same-origin` — origin preservation for postMessage
- `allow-forms` — the file picker (manual loads inside the frame)
- `allow-popups` — `window.open` handover from inside the frame

When SELF-HOSTING a build of the explorer, keep the same CSP directives in
your server headers — especially `worker-src … blob:`, `connect-src` for
the origins your users load, and `frame-ancestors` for the origins allowed
to embed it (plus the matching `VITE_HANDOVER_ALLOWED_ORIGINS` at build
time).