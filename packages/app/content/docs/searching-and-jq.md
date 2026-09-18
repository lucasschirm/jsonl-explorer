---
title: Searching and jq
description: Text substring search and jq filter queries with examples
---

The filter bar at the top of the left panel filters the **whole file** and
replaces the row view with the matches. It supports two modes, chosen with
the **Text / jq** toggle (the mode is never guessed from your input):

## Text Search (Default)

Type any string for a case-sensitive literal substring match across all rows.

- Press `Enter` or click the search icon to execute
- No live filtering — typing never changes the view; an explicit action is required
- Matching is per-row: a query never spans two rows
- Blank rows are rows too — they match only the empty query
- While a URL is still downloading/indexing, results are labeled
  **partial** and are automatically re-run over the full file when
  indexing completes — no need to search again
- Cancellation (the **Cancel** button or a new search) keeps the previous
  view until the new result is fully built

## jq Filter

Switch the mode toggle to **jq** and type any jq program. Examples:

- `.status == "error"` — rows where status is `"error"`
- `.user.id` — rows with a user id (truthy results match)
- `select(.tags | index("important"))` — rows with an "important" tag
- `. | length > 100` — objects with more than 100 top-level entries

![A jq filter applied — 3 of 5 rows remain in the list](/screenshots/filtering-light.png)

### How jq Matching Works

A row matches when the jq program produces **at least one output** that is
neither `false` nor `null`. The `empty` output is a non-match.

- The program is **compiled once** per filter run, then evaluated per row
- Rows that are not valid JSON, and rows where the program raises a runtime
  error, are **skipped and counted** — they never fail the filter. After the
  run you get ONE summary (how many rows were skipped and the first error),
  never one message per row
- A program that does not **compile** is a failure: you get an actionable
  message with the jq syntax error, and the previous view is kept

### Performance Notes

- Progress (rows scanned / matched) is shown while the filter runs; cancel
  anytime with the **Cancel** button
- For large files, consider a text search first — it is faster than jq

## Clear Filter

Click the × button or press `Escape` to reset to the unfiltered view.
Pressing `Enter` with an empty input does the same.

## Local Search (Selected Row)

Above the JSON tree in the detail panel there is a second search bar — this
one searches the **selected document only**, never the whole file, and it is
completely independent of the left-side filter (using one never touches the
other). It exists when the selected row renders as a tree (valid, confirmed
JSON); invalid or unconfirmed large rows have no local search.

### Text Mode

- Case-sensitive literal substring match against **keys and primitive
  values** of the selected document (strings by content, other primitives by
  their JSON token)
- Results appear instantly as you type — text search is fully local and
  synchronous; nothing is sent to the worker
- Matching nodes are highlighted in the tree; `↑`/`↓` (or **Prev**/**Next**,
  or `Enter`) walk the matches in document order, wrapping around, and the
  current match's container is expanded and scrolled into view
- The count label shows the position (`2 / 5`) or the total (`5 results`)

### jq Mode

Switch the toggle to **jq**, type a program, and click **Run** (`Enter`
works too). The program executes in the worker **against this one document
only** — the row is sent by value, so the run is a snapshot: switching rows
or saving an edit while a run is in flight silently discards the stale
answer.

- Unlike the whole-file jq filter (a boolean verdict per row), local jq
  shows **every output** in emission order — `.items[].id` lists all ids
- A program that produces nothing shows a “No output” hint (it is not an
  error); a program that does not parse or fails on this document shows the
  typed error line and one toast
- The output pane is collapsible and caps rendering at 200 outputs so a
  program like `.[]` on a huge array cannot flood the DOM — **Copy all**
  copies every output anyway, and each visible output has its own **Copy**

Both modes clear automatically when you select another row or the document
changes (for example after saving an edit).
