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

### Header Security

Custom headers are kept in memory only and are never:
- Logged to the console
- Sent to analytics
- Included in error reports
- Stored in browser history

Headers that look like credentials (e.g. `Authorization`) are masked by default and flagged with a notice; duplicate, forbidden, or line-break-injecting header names are rejected with an inline error.

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