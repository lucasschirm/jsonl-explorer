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
- **Selection** — Click any row to view its full JSON in the right panel
- **Status bar** — Shows total and filtered row counts

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

The selected row is parsed and displayed as an interactive JSON tree:

- **Collapse/Expand** — Click chevrons to toggle objects and arrays
- **Child counts** — Collapsed nodes show the number of children
- **Syntax highlighting** — Colors match the DaisyUI theme (light/dark)
- **Line numbers** — Optional line numbers for reference

## Keyboard Navigation

- `↑` / `↓` — Move selection up/down
- `Enter` — Focus JSON editor on right panel
- `Ctrl+F` — Focus search bar

## Raw View

Click the "Raw" button to see a virtualized raw text view of filtered lines, useful for copying or inspecting unformatted content.