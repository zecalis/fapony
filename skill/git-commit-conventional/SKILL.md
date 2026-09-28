---
name: git-commit-conventional
description: Commit at each finished step with a conventional message — use with Claude Code / OpenCode / Codex / ZCode. Trigger on /git-commit and when the user asks to commit changes.
---

# Git Commit Conventional — one commit per finished step

**Hard rule: commit when a step is done, while you still know what it was.** One conventional
line per step. Never take a dirty tree and split it by concern after the fact — that means
re-reading the whole diff to rediscover work you just did, and it spends tokens on a split the
squash merge folds away anyway.

The branch is squash-merged: the PR title becomes the subject on the base, and the squash body
lists these step commits (`squash_merge_commit_message=COMMIT_MESSAGES`). So the step lines are
the base branch's changelog — keep each one short and true. The concern boundary that matters
is the **PR**: one concern per branch, so each commit on the base still carries one concern
(what history-mining for convention migrations needs). Unrelated work → its own branch, not a
split commit.

## Before commit

1. `git status --porcelain` — in a shared/multi-agent worktree (fapony's `wt-*`), files already
   dirty before this session started are another session's in-progress work, not a problem.
   STOP and report only if a file changes between two consecutive `git status` calls (someone is
   writing right now — wait for it to settle), or if content matches nothing in this
   conversation and doesn't look like a coherent feature.
2. Stage the files of the step you just finished — by name, not `git add -A`, so another
   session's dirty files stay out. A one-concern task can be one commit at the end.

## Format

```
<type>(<scope>): <subject, max 72 chars>

<optional body — why, when the subject can't carry it, wrapped at 76>

Co-Authored-By: <the model you are running as> <its vendor's noreply address>
```

`<type>` is exactly one of `feat` `fix` `refactor` `docs` `chore` `test` — no `feat/fix:`, no
two-word types. The body is optional: the step line is what lands in the squash body.

If your harness already gave you an exact `Co-Authored-By` line, use that verbatim — it wins over
this template. Otherwise name the model you actually are; never copy another vendor's address.

### Example

```
feat(analyze): structural health diagnosis

Import graph built live with Bun.Transpiler.scan(); 114 files scan in
16.6ms, so no cache table.
```

## Rules

- **NEVER push from this skill** — it only commits. Push/PR/merge is [git-ship](../git-ship/SKILL.md)'s job
- **Report in lines, not paragraphs** — what you did, what needs the user, nothing else. Never
  narrate the steps; the commands are already in the transcript.
- **NEVER `--amend`** an existing commit unless explicitly authorized
- **NEVER `--no-verify`** — if a pre-commit hook (lint/typecheck) fails on pre-existing code you
  didn't write, fix it for real (safe autofix + minimal manual fix) and note in the body that
  the fix wasn't for your own change
- Conflict with the base branch → STOP and report, don't merge yourself
