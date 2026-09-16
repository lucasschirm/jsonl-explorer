---
title: Editing and Export
description: Edit JSON values, use format/compact modes, export filtered results
---

# Editing and Export

## Editing Values

Click any primitive value (string, number, boolean, null) in the JSON tree to edit it:

1. Click a value — inline editor appears
2. Type new value — try `JSON.parse` first (e.g., `42`, `true`, `{"a":1}`)
3. Press `Enter` or click away to commit
4. Press `Escape` to cancel

### Type Coercion

- Valid JSON → parsed as that type
- Invalid JSON → stored as string
- Numbers, booleans, null, arrays, objects all supported

### Reset Line

Click the "Reset" button in the toolbar to revert all edits on the current line.

## Format / Compact

- **Format** — Pretty-print with 2-space indentation
- **Compact** — Minified single-line output

These are view-only; they don't create edits.

## Export

Click "Export" to download filtered rows (including edits) as a `.jsonl` file:

- **File System Access API** — Native save dialog (preferred)
- **Blob fallback** — Confirmation required for files > 512 MiB
- Each row ends with exactly one `\n`
- Exports use a captured generation for consistency

## Right Panel Search

Search within the selected document only:

- Text mode — highlight matching keys/values, prev/next navigation
- jq mode — run jq against the document, show collapsible results