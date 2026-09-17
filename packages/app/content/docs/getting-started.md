---
title: Getting Started
description: Learn how to open JSONL files using drag-and-drop, file picker, or URL with custom headers
---

# Getting Started

JSONL Explorer makes it easy to open and explore JSONL files. You can load files in three ways:

## Drag and Drop

Simply drag a `.jsonl`, `.json`, `.ndjson`, or `.txt` file onto the landing page drop zone. The file will be processed entirely in your browser.

## File Picker

Click the drop zone to open your system's file picker and select a file.

## Open from URL

Click "Open from URL" to load a JSONL file from a public HTTP/HTTPS endpoint. You can also specify custom headers (e.g., for authentication).

### URL rules

- Only `http://` and `https://` URLs are accepted.
- URLs with embedded credentials (`user:pass@host`) or fragments (`#...`) are rejected — put secrets in headers instead.
- If the fetch fails (network, CORS, non-2xx), the modal stays open with your URL so you can retry. Error messages never include header values.

### Deep link (`?url=` bootstrap)

Public URLs (and the CLI's capability URLs) can be opened directly:

```
https://jsonlexplorer.lucasschirm.com/explorer?url=https://example.com/data.jsonl
```

- The parameter is **consumed on page load, before anything else**, and is
  only accepted in its plain form — http/https, no embedded
  credentials, no fragments. **Headers are never supported from the
  query** (that would put secrets in the URL): for authenticated loads use
  the "Open from URL" modal.
- **Scrubbing**: as soon as the URL is validated, the query is removed
  from BOTH the address bar and the router state — before the load
  starts. A large file loads for minutes, and the (possibly signed) URL
  must not sit in the address bar or history meanwhile. An invalid value
  gets a toast and a safe return to the landing page.
- **Referrers**: the app sends a `no-referrer` policy, so the URL can
  never leak into an outgoing referrer header while it still exists.
- **Failure**: the load error is toasted and the URL is kept **in memory
  only** — the landing page reopens the modal prefilled for a one-click
  retry. Nothing is written to storage.
- **Refresh**: the session lives in memory only. Refreshing after the
  scrub loses the loaded file (the explorer returns you to the landing
  page). To reload the same data, open the original `?url=` link again —
  or use the prefilled retry while the tab is still open.

### Header Security

Custom headers are kept in memory only and are never:
- Logged to the console
- Sent to analytics
- Included in error reports
- Stored in browser history

Headers that look like credentials (e.g. `Authorization`) are masked by default and flagged with a notice; duplicate, forbidden, or line-break-injecting header names are rejected with an inline error.

## Loading and cancellation

- While a URL is loading, the modal shows **download** and **indexing** progress separately: the download bar is determinate when the server declares a plain (uncompressed) size, otherwise indeterminate; the index shows the committed row count as it grows.
- Local files are indexed in the background: you can enter the explorer immediately and rows appear as they are committed.
- **Cancel** targets the active operation only (its operation id); stale progress events from a previous operation are dropped, so a cancel or restart can never surface outdated percentages.
- After a cancelled or failed load you stay on landing with the form intact — retry in place.
- If the local disk cache (OPFS) is unavailable or its quota is exceeded, you are asked before the download falls back to **memory-only** pages: the dialog explains the trade-off (higher RAM use, no disk persistence, data lost on tab close) and you can cancel instead.

## Supported Formats

- **JSONL** (`.jsonl`, `.ndjson`) — One JSON object per line
- **JSON** (`.json`) — Arrays or newline-delimited objects
- **Text** (`.txt`) — Any text file with JSONL content

## Next Steps

Once a file is loaded, you'll be taken to the explorer view where you can:
- Browse rows with virtual scrolling
- Search and filter with text or jq
- View and edit JSON documents
- Export filtered results

See [Exploring Data](/docs/exploring-data) for more details.