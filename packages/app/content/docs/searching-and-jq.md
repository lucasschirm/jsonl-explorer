---
title: Searching and jq
description: Text substring search and jq filter queries with examples
---

# Searching and jq

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
