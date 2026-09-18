---
title: Editing and Export
description: How edits are stored (stable line IDs, byte budget), format/compact modes, and export
---

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

Click **Export** (header) to download the current view — filtered rows,
including edits — as a `.jsonl` file:

- Each row ends with exactly one `\n`
- Edits are exported: the row's override replaces its source bytes
- Exports use a captured generation for consistency (below)
- The Export button is disabled until a file is loaded and idle (no export
  running, no filter scan settling)

### Destinations

- **File System Access** (Chrome/Edge — the TSK0001 support policy's
  preferred path): the native save dialog picks the file, and chunks are
  **streamed straight into it** via the writable stream. The whole output
  never sits in memory. On success the writable is `close()`d (commit); on
  cancel or failure it is `abort()`ed, which **discards the partial file**
  — a cancelled export never leaves a truncated file behind. Closing the
  save dialog is a plain cancel (info toast), not an error.
- **Blob fallback** (Firefox/Safari): chunks accumulate into a Blob
  (`application/x-ndjson`), a hidden anchor triggers the download, and the
  object URL is revoked ~1 s after the click (long enough that the download
  cannot race the revocation). The whole output sits in memory, so an
  estimate **above 512 MiB** (`ENGINE_DEFAULTS.exportBlobConfirmBytes`) is
  refused until you explicitly confirm in a dialog — and while you decide,
  the export is released (its worker state and the edit lock freed), so a
  dismissed confirmation costs nothing. Confirming starts a fresh export.

### While an export runs

- A progress strip shows the file name, rows exported / total, bytes, and a
  **Cancel** button. Cancel stops the pump and releases the worker's export
  state immediately (the in-flight chunk then fails with a typed
  `EXPORT_TOKEN_INVALID`, unwinding the run).
- **Mutations are gated in the UI**: the tree's edit affordances and the
  detail panel's reset/raw-edit controls are disabled while the run is
  active — and the worker still hard-refuses with `EXPORT_IN_PROGRESS` as a
  backstop (see the edit-lock note below).
- Every exit path toasts exactly once with a typed, actionable message
  (success: rows + bytes + file name; cancel: info; failure: the worker's
  reason).
- If the view generation moved between your click and the `exportStart`
  RPC (e.g. an edit or index commit landed in between), the worker rejects
  with `STALE_GENERATION` and the **current** generation in the error;
  the UI retries ONCE with that value. A filter scan in flight is NOT
  retried — a warning toast asks you to retry once the filter settles.

### How an export stays consistent (worker snapshot + backpressure)

- **Snapshot at start** — `exportStart` captures the view at ONE
generation: the row membership (filtered view) is snapshotted, and a
request carrying a stale generation is rejected with a typed error so an
export never silently describes a view that has already moved. A filter
scan still running is refused the same way (`EXPORT_FILTER_IN_FLIGHT`):
a mid-scan membership is a view the user never saw.
- **Edits are locked** — while any export is in flight, row edits are
refused ("Edits are paused while an export is running"). This is what
makes the content deterministic: the bytes streamed during the export are
exactly the bytes the snapshot describes. Finishing or cancelling the
export releases the lock.
- **Bounded, acknowledged chunks** — output is pumped in chunks of at
most 256 KiB of *complete* rows (a single row larger than the cap is
emitted alone; a row is never split). The worker produces at most ONE
chunk at a time and stops until the previous one is acknowledged, so a
slow consumer can never make the worker's output queue grow unbounded.
- **Progress** — every chunk reports how many complete rows have been
exported, against the total from `exportStart`; the start response also
carries a byte estimate (100-row sample) used for the fallback
confirmation threshold.
- **Failures are typed** — a source read failure cancels the export with
an `EXPORT_FAILED` error; unknown or expired tokens are rejected with
`EXPORT_TOKEN_INVALID`; cancel is idempotent.

## Right Panel Search

Search within the selected document only:

- Text mode — highlight matching keys/values, prev/next navigation
- jq mode — run jq against the document, show collapsible results
