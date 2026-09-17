---
title: Searching and jq
description: Text substring search and jq filter queries with examples
---

# Searching and jq

The search bar at the top of the left panel supports two modes:

## Text Search (Default)

Enter any string to perform a case-sensitive literal substring match across all rows.

- Press `Enter` or click the search icon to execute
- No live filtering — explicit action required
- Matching is per-row: a query never spans two rows
- Blank rows are rows too — they match only the empty query
- While a URL is still downloading/indexing, results are labeled
  **partial** and are automatically re-run over the full file when
  indexing completes — no need to search again
- Cancellation (stop button or a new search) keeps the previous view
  until the new result is fully built

## jq Filter

Prefix your query with `jq:` to use the powerful jq query language.

Examples:
- `jq:.status == "error"` — Filter rows where status is "error"
- `jq:.user.id` — Extract user IDs (truthy results match)
- `jq:select(.tags | index("important"))` — Rows with "important" tag
- `jq:. | length > 100` — Rows with more than 100 characters

### How jq Matching Works

A row matches when the jq program produces **at least one output** that is neither `false` nor `null`. The `empty` output is a non-match.

Invalid JSON lines and runtime errors are counted and summarized once; they don't stop the filter.

### Performance Notes

- jq compiles once, then runs per row (O(n) parses)
- Progress updates every 1000 rows
- Cancel anytime with the stop button
- For large files, consider text search first

## Clear Search

Click the × button or press `Escape` to reset to the unfiltered view.