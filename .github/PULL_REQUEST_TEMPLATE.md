## What / Why

Short summary of what changed and why. Delete the half you don't need.

## Verification

Paste the tail of `bun run check` (or `gh pr checks` once CI runs) — evidence, not just a tick below.

```
(paste here)
```

## Checklist

- [ ] `bun run check` passes (lint + typecheck + test) — output pasted above
- [ ] One concern per PR — no unrelated changes bundled in
- [ ] Title is conventional-commit style (`feat: …`, `fix: …`, …)
- [ ] CI green before merge (`gh pr checks`)

<!-- Squash-merge only (`gh pr merge --squash`) — squash rewrites history by design, so a kept branch must `git reset --hard origin/<default-branch>` after the merge (see docs/edge-cases.md). -->
