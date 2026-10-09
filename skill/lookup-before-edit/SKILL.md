---
name: lookup-before-edit
description: Look up unfamiliar files before reading or editing them — exports, line numbers, and importers without reading the whole file. Trigger on /lookup-before-edit and proactively whenever you are about to read, edit, or refactor a file you do not already know.
---

# Lookup Before Edit — scope first, read second

You are about to touch files you do not know. Do not `Read` them whole — look them up first.
A full-file read on a 500-line module costs ~35k tokens of output; a lookup costs under 1k.

## The one command

```bash
fapony review-seed --files <f1,f2,dir> [--body <sym>[,<sym>]] [--callers <sym>[,<sym>]]
```

What it returns: every export with its line number (uncapped), plus the importers — first 12
per file, the rest as `(+N)`, so the total is still readable. That is your entry map — then
`Read` only the line ranges you actually need.

## Narrow it

- `--body <sym>[,<sym>]` — declaration slice of those exports (truncated at 80 lines each):
  "what does this do" without the file.
- `--callers <sym>[,<sym>]` — symbol→symbol scan across the importers the static graph sees.
- Directories expand to the source files under them (cap 40, stated when cut). Paths that do
  not exist are dropped with a notice, not counted silently.

## Limits (do not work around them)

- **Exports only.** A non-exported function answers "no export named X in scope" — that is
  the correct answer, not a failure. Read the file for internals.
- **Static only.** Dynamic use is invisible to the graph; an empty caller list means "not
  seen statically", never "unused".
- **120 lines total.** Past that the tail is cut (`… (+N lines truncated)`) — and the tail is
  the later files' signatures. Many files at once → split the call, don't trust a cut list.
- No `fapony` CLI or the call errors → read the file normally and carry on. A hint, not a gate.

## History (same paths)

- fael `find` with `files: [<same paths>]` (or `fael find --files <paths>`) — "what was ever decided about
  this file". fael already attaches these rows when you Read a file, so call it only for paths you skip reading.

## After the lookup

1. Pick line ranges from the export list, `Read` those slices only.
2. Before changing a shape, sum shown + `(+N)` importers — that is your blast radius.
3. Do not re-read a file whose mtime has not moved; `grep` it instead.
