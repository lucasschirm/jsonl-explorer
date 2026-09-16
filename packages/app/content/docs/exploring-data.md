---
title: Exploring Data
description: Navigate rows, select documents, use the JSON tree view with collapse/expand
---

# Exploring Data

Once you've loaded a JSONL file, the explorer view provides two panels:

## Left Panel: Row List

- **Virtual scrolling** — Only visible rows are rendered, enabling multi-GB file support
- **Row numbers** — Original 1-based line numbers from the source file
- **Preview** — Each row shows a truncated, single-line escaped preview
- **Selection** — Click any row to view its full JSON in the right panel
- **Status bar** — Shows total and filtered row counts

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