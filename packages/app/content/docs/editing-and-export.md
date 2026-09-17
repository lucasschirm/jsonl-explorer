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

The detail panel's tree is editable in place. Clicking a value opens a
single-line editor seeded with the value's current JSON token:

- **Primitives** (string, number, boolean, null) — click the token.
- **Objects and arrays** — click the bracket (expanded) or the collapsed
  summary (e.g. `{4 items}`); the *whole container* is replaced.

The chevron still only expands/collapses; only the value itself starts an
edit. Exactly one node is editable at a time; switching rows or reloading
the line cancels any open session (a draft never carries across rows).

### Commit

1. Type the new value — `JSON.parse` is tried first (e.g. `42`, `true`,
   `null`, `"hi"`, `[1,2]`, `{"a":1}`)
2. `Enter` or clicking away commits; `Escape` cancels
3. The commit re-serializes the **entire document** (compact JSON, exactly
   one line) and mirrors it with **one** `setEdit` RPC — the worker applies
   it atomically, re-evaluates the active filter for that row, and bumps
   the generation. The detail tree then reloads from the worker, so what
   you see is what was stored.

### Type Coercion

- Valid JSON → stored as that type
- Invalid JSON (e.g. `hello world`) → stored as a **string**
- Non-finite number literals (e.g. `1e400`) → stored as a **string**
  (they would otherwise silently serialize to `null`)

### Safety

- If the row changes while you are editing (stale path), the commit is
  rejected with one toast — the app never guesses where your edit belongs.
- A worker-rejected edit (e.g. over the 1 MiB budget, CR/LF) toasts the
  reason and leaves both the tree and the override map untouched.

### Raw Editing (Invalid Rows)

A row that is not valid JSON cannot use the tree, so it gets an explicit
**Edit row** control with a single-line textarea and **Save / Cancel**
buttons — no implicit commits (a multi-line draft must never save itself on
a stray blur):

- **Save** mirrors the draft as the row's whole-row override (one `setEdit`,
  same storage rules as tree edits) and reloads the panel. Correcting the
  row to valid JSON immediately switches the panel to the tree, and the
  worker has already re-evaluated the active filter's membership for that
  line (stable line ID).
- **Newlines are rejected.** A literal CR or LF would split the row into
  extra export rows, so the save is refused with one typed toast and the
  draft is kept for fixing.
- **Budget warning.** When the draft exceeds the 1 MiB override budget the
  editor shows a warning and disables Save before the click.
- **Cancel** discards the draft; no RPC is sent.

### Reset Line

The toolbar's **Reset** button (enabled only while the row has an accepted
override) removes the override: the original source row returns — including
the original *invalid* bytes, when the row was raw-edited — the "edited"
badges clear, and the active filter re-evaluates that row.

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
