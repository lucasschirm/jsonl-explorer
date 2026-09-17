---
title: Editing and Export
description: How edits are stored (stable line IDs, byte budget), format/compact modes, and export
---

# Editing and Export

## How Edits Are Stored

Edits are **byte-accounted overrides of a whole row**, keyed by the row's
**stable source line ID** — never by its position in the filtered view.
Filters reorder and hide rows; line IDs do not move, so an edit always
refers to the same source row no matter which filter is active.

Rules (enforced in the worker and mirrored in the UI):

- **One row in, one row out.** An override containing CR or LF is rejected
  (`EDIT_CRLF_NOT_ALLOWED`) — an edit can never split a source row into
  extra output rows.
- **Byte budget.** A single override may not exceed 1 MiB
  (`ENGINE_DEFAULTS.editMaxBytes`); the editor UI warns before committing,
  and the worker hard-rejects oversized edits (`EDIT_TOO_LARGE`) as defense
  in depth. The UI tracks total override bytes (`usedBytes`) so you can see
  how much memory edits add on top of the file.
- **The worker is authoritative.** The main thread keeps a non-deep,
  byte-counted mirror of the accepted overrides, but an edit only lands in
  the UI *after* the worker accepted it. Filters, counts, selection, and
  export all read the worker's value, so every consumer sees the same text
  (no fork between "what the list shows" and "what the filter matched").
- **Filters re-evaluate immediately.** Applying (or resetting) an edit
  re-runs that one row against the active filter and atomically updates
  membership, the match count, the error count (jq), and the worker
  generation. A row can enter the filtered view by being edited to match,
  and leave it by being edited away — or by being fixed/broken under a jq
  filter. A full rescan always consults the override map too.
- **Reset restores the source row.** Removing an override returns the row's
  original bytes and re-evaluates membership exactly as above.
- **Edits are per-source.** Opening a new file discards all overrides (line
  IDs refer to rows of the old file).

Edited rows are marked with an "edited" badge in the row list and the detail
panel; the detail panel's byte size and copy actions reflect the override,
not the source bytes.

## Editing Values

The inline editor UI (tree-level primitive editing and raw row editing) is
built on the storage above:

1. Click a value — inline editor appears
2. Type new value — try `JSON.parse` first (e.g., `42`, `true`, `{"a":1}`)
3. Press `Enter` or click away to commit
4. Press `Escape` to cancel

### Type Coercion

- Valid JSON → parsed as that type
- Invalid JSON → stored as string
- Numbers, booleans, null, arrays, objects all supported

### Reset Line

Click the "Reset" button in the toolbar to revert all edits on the current
line (the override is removed and the original source row returns).

## Format / Compact

- **Format** — Pretty-print with 2-space indentation
- **Compact** — Minified single-line output

These are view-only; they don't create edits.

## Export

Click "Export" to download filtered rows (including edits) as a `.jsonl`
file:

- **File System Access API** — Native save dialog (preferred)
- **Blob fallback** — Confirmation required for files > 512 MiB
- Each row ends with exactly one `\n`
- Edits are exported: the row's override replaces its source bytes
- Exports use a captured generation for consistency

## Right Panel Search

Search within the selected document only:

- Text mode — highlight matching keys/values, prev/next navigation
- jq mode — run jq against the document, show collapsible results
