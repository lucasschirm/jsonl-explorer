---
title: Exploring Data
description: Navigate rows, select documents, use the JSON tree view with collapse/expand
---

# Exploring Data

Once you've loaded a JSONL file, the explorer view provides two panels:

## Layout and minimum viewport

The explorer is a split view: a fixed-width row list on the left and a
flexible detail pane on the right, under a small (48px) fixed header. The
panels scroll independently; the header never scrolls away.

The layout targets a **minimum viewport of 1024px wide**. Below that the
page keeps its 1024px minimum width and scrolls horizontally instead of
stacking the panels — data exploration is a desktop activity, and stacking
would break the row/detail mental model (and the virtualized row list).

"Upload another file" in the header returns to the landing page and fully
disposes the engine: the worker is terminated (after the worker-side spool
cleanup), and all in-memory indexes and caches are dropped. The next load
starts from a clean engine.

## Left Panel: Row List

- **Virtual scrolling** — Only visible rows are rendered, enabling multi-GB file support
- **Row numbers** — Original 1-based line numbers from the source file
- **Preview** — Each row shows a truncated, single-line escaped preview
- **Selection** — Click any row to view its full JSON in the right panel. The highlight follows the row's stable source line id, so it stays on the same row even when a filter changes row positions
- **Placeholders** — Rows whose batched window is still in flight show a short placeholder bar, so the list never blocks or reflows while data loads
- **Status bar** — Shows total and filtered row counts (always the worker's own numbers, never local arithmetic), the current pipeline state (indexing with percent, paused, failed, or filtering with scanned/matched), and a partial marker while the index is still committing (the total is then a lower bound that keeps growing)

### How rows are loaded

The row list never loads the whole file. As you scroll, the visible range
plus a small overscan is requested from the engine in a single batched
window; overlapping requests (fast scrolling, overscan growth) are
coalesced so there is always at most one in-flight window. Fetched previews
are kept in a bounded cache (a few MiB, not an unbounded entry count),
with the oldest off-screen rows evicted first.

Previews are capped at the first 500 bytes of each row so a single huge
line cannot flood the list — the status bar and row height use the FULL
row length. Clicking a row fetches the complete (unescaped) text on
demand; that is what the JSON tree view and the raw view render.

When a filter or a new index commit changes the row set, cached windows
are invalidated by generation: a stale window can never replace rows of
the current view.

## Right Panel: JSON View

The selected row's FULL text is loaded on demand (list previews are
byte-capped; the detail is exact) and rendered as an editable JSON tree:

- **Collapse/Expand** — Click chevrons to toggle objects and arrays,
  independently per node. Collapsed nodes show their child count.
- **Inline editing** — Click any value (primitive token, container
  bracket, or collapsed summary) to edit it in place; `Enter`/blur
  commits, `Escape` cancels. Edits are stored as whole-row overrides
  keyed by stable line ID — see [Editing and Export](/docs/editing-and-export).
  Edited rows show an "edited" badge; the toolbar's Reset button
  restores the original row.
- **Syntax highlighting** — Token colors follow the DaisyUI theme
  (light/dark): keys, strings, numbers, booleans, and nulls are all
  distinguishable at a glance. Large containers start collapsed so a
  big document cannot flood the screen on first render.
- **Invalid JSON** — A row that is not valid JSON is shown as raw text
  with a warning banner (and a one-time toast on selection); the row
  itself is never modified.
- **Large rows** — Rows above the 1 MiB parse threshold default to raw
  mode. Confirming explicitly is required before the JSON tree is
  parsed and rendered, so a single giant row can never freeze the UI
  by itself.
- **Format / Compact** — Presentation-only modes (pretty, two-space
  vs minified). They change how the document is presented/serialized
  for text consumers — they never create an edit and never touch the
  row's text in the worker.
- **Rapid selection** — Selecting rows quickly cancels stale loads:
  only the answer for the row you are currently on is ever rendered.

## Keyboard Navigation

The row list is keyboard operable: click it (or Tab to it) to give it
focus, then

- `↑` / `↓` — Move the selection up/down (clamped at the first and last
  row; the row is scrolled into view and fetched on demand when it is
  not cached yet).
- `Enter` — Move focus to the editor for the selected row (the tree's
  root value, or the raw editor for invalid rows), ready for `Tab`/click
  to start editing.

Page-wide shortcuts (work wherever focus is on the page):

- `Ctrl+F` / `Cmd+F` — Focus the filter input (the explorer's search).

**Focus policy** — these shortcuts never override a focused control:
while an input, textarea, select, or contenteditable has focus, its
native keys win (e.g. `Ctrl+F` inside the filter input still triggers
the browser find, and `Enter` inside an editor still commits it). While
a dialog (raw view, confirmations) is open, the dialog owns the keys.

## Raw View

The "Raw" button (detail toolbar) opens a virtualized raw text view of
the CURRENT (filtered) lines — useful for inspecting unformatted content
or copying it.

- **Bounded by design** — the modal virtualizes the dataset (same
  row-window cache as the list). It never concatenates all rows into
  one string, so opening Raw on a very large filtered view keeps the
  DOM and memory bounded to the visible viewport.
- **Same semantics as the list** — each row shows the byte-capped,
  C0/DEL-escaped, single-line preview plus its source line number.
  Invalid rows are shown exactly like in the list (selectable,
  exportable, never silently dropped).
- **Copy** — each raw row (and the selected row's detail panel) has a
  Copy action that fetches the FULL row text and puts it on the
  clipboard. Clipboard failures (e.g. permission denied) surface as an
  error toast — copying never fails silently.
- **Accessible** — the modal traps focus, closes on Escape or backdrop
  click, and is announced as a dialog (`role="dialog"`,
  `aria-modal`), matching the app's other modals.