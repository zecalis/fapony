# SPEC-export — column mapping, escaping, filenames

> **Used by:** [PLAN-feature-export.md](../plan/PLAN-feature-export.md) ·
> [PLAN-webapp-notifications.md](../plan/PLAN-webapp-notifications.md) (digest attachment)
>
> **A spec moves with the last plan that cites it.** While either plan above is live this file
> stays here; when the last of them ships, `fapony plan sweep --apply` moves it to `done/` beside
> them and repoints every link to it.

## 1. Column mapping

The exporter reads the table's own visible column config. A hidden column is not exported, and
the header row uses the column's `field` key, not its display label — labels get translated,
keys do not.

| Table | Columns exported |
|---|---|
| Tasks | `id, title, status, assignee, due_date` |
| Users | `id, email, role, created_at` |
| Projects | `id, name, owner, task_count` |

## 2. CSV escaping rules

- Every string field is quoted, unconditionally — cheaper to reason about than deciding per value
- A `"` inside a value is doubled: `he said "hi"` → `"he said ""hi"""`
- Newlines inside a value are kept, inside the quotes
- The file starts with a UTF-8 BOM (`﻿`) so Excel on Windows reads Thai and emoji correctly
- Line terminator is `\r\n`, the one Excel expects

## 3. JSON shape

A flat array of objects, one per row, keys in the column order above:

```json
[
  { "id": 1, "title": "Fix login bug", "status": "in-progress", "assignee": "@delamind" }
]
```

`null` for an empty cell — never `""`, which would be indistinguishable from a real empty string.

## 4. Filenames

`<table>-export-<YYYY-MM-DD>.<ext>` in the user's local timezone — `tasks-export-2026-09-05.csv`.
Two exports on the same day overwrite in the Downloads folder; the browser appends `(1)`, and
that is acceptable.

## 5. Edge cases

| Case | Behaviour |
|---|---|
| Zero rows | button disabled, tooltip "No data to export" — no file is written |
| Filter active | export the filtered rows only, across all pages, not the visible page |
| > 5,000 rows | chunk the serialization; the file is still one download |
| Value contains `=` as the first character | prefix with `'` so Excel does not evaluate it as a formula |
