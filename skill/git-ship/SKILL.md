---
name: git-ship
description: Ship a branch end to end — push it, open a PR with an AI-drafted title/body, merge it, then bring the branch back in line with the base. Stops at the PR for team review with `pr`, lands an approved one with `land`. Use with Claude Code. Trigger on /git-ship, /ship, /pr, and when the user asks to open a PR, ship a branch, or merge for them.
---

# Git Ship — push, PR, merge, realign

You are shipping a branch: push it, open a PR with a drafted title/body, merge it, put the
branch back in line with the base.
Commits are one conventional line per finished step (`fix: …`, `feat: …`), made when the step is done.
Never re-split them by concern here; one concern per **PR** is the boundary.

## Where to stop

The argument picks the stop point. Everything else on this page is identical in all three.

| Invocation | Does | For |
|---|---|---|
| `/git-ship` | push → PR → merge → realign | working solo, or a branch nobody else reviews |
| `/git-ship pr` | push → PR, then **stop** and report the URL | a team — someone else reviews and merges |
| `/git-ship land` | the PR exists and is approved → merge → realign | a team, after approval lands |

No argument, and the repo's default branch requires a review to merge
(`gh api repos/{owner}/{repo}/branches/<default> --jq '.protection.required_pull_request_reviews'`
returns anything but `null`)? Treat it as `pr` and say why — merging is not yours to do when the
repo says a human must approve first. `--admin` stays off the table either way.

For `pr`, stop after `gh pr create` and report the URL, plus who needs to review if the repo
declares owners. Don't merge, don't realign — the branch must stay as the reviewer sees it.

For `land`, skip drafting: the PR is already written. Start at the CI gate below, then merge and
realign. Re-read the PR body first and say in one line whether it still matches the commits, since
review may have added some.

## Before anything

1. `git status --porcelain` — uncommitted changes? STOP, ask whether to commit first
2. `git branch --show-current` — refuse if this is `main`/`master` (or the repo's default branch):
   tell the user to branch first
3. `git log <default-branch>..HEAD --oneline` — the commits this PR will contain
4. fael, if this session has it: `fael find --kind issue --files "$(git diff --name-only <default-branch>...HEAD | paste -sd, -)"`
   — issues still open on the files this PR touches. You judge which ones this branch fixed
   (fael never infers): for each, `fael close <id> "<cause> → <fix>; guard <test>"` and cite
   `fael:<id>` in the PR body. Leave the rest open. A net under the fix, not instead of closing at the fix.

## Draft

- **PR title**: one line, conventional-commit style (`feat: ...`, `fix: ...`), summarizing the
  whole branch — not just the last commit
- **PR body**: short summary of what changed and why (from the commit messages + diff, not
  invented), plus a one-line test plan if there's an obvious one (tests run, command output).
  End with an attribution line:
  ```
  🤖 Generated with <the coding agent you are running in>
  ```
  Name the agent you actually are — Claude Code, Codex, opencode, ZCode — not a hardcoded one.
  If your harness already gave you an exact attribution line to use, use that verbatim instead;
  it wins over this template.
- **Merge method**: default to `--squash` on a short-lived feature branch. The PR title
  becomes the subject; with the repo's squash body set to `COMMIT_MESSAGES`, the step commits
  land under it as the changelog — one commit per PR, linear history, one-command revert.
  Check what the repo allows first (`gh api repos/{owner}/{repo} --jq
  '{allow_merge_commit,allow_squash_merge}'`) — a squash-only repo rejects `--merge`.

  Use `--merge` only for a long-lived branch (`dev`, `develop`) that someone keeps checked out
  and the repo allows merge commits: squash would make it diverge from the base every ship
  (see the post-merge `reset --hard` below), and that divergence compounds.

## Confirm once, then run

Show the drafted title + body + merge method together and get one go-ahead — don't ask
separately for push, then PR, then merge. Then:

```bash
git status --porcelain   # re-check right before pushing, not just at the start —
                          # time passed drafting/waiting on CI; in a shared/multi-agent
                          # worktree another session may have added uncommitted work.
                          # If dirty, wait for it to be committed (or ask) before pushing —
                          # don't push around it and don't commit someone else's changes yourself.
git push -u origin <branch>
gh pr create --title "<title>" --body "<body>"
gh pr merge --squash   # or --merge for a long-lived branch, per the chosen method

# post-merge, after --merge: the branch is already an ancestor of the base, so just
# catch it up. No force, nothing to destroy.
git fetch origin
git merge --ff-only origin/<default-branch>
git push origin <branch>

# post-merge, after --squash ONLY — and then it is mandatory, not optional:
git fetch origin
git reset --hard origin/<default-branch>
git push --force-with-lease origin <branch>

# if you shipped from a git worktree, fast-forward the primary checkout too —
# `git worktree list` prints it first:
git -C <primary-checkout> pull --ff-only
```

Either way the branch must end up pointing at the merged base — that is what keeps the next PR
clean. After `--merge` it is a fast-forward, no force.

After a squash it is a `reset --hard`, and it is **not optional** for a branch you keep. Squashing
rewrites the commits, so the branch keeps originals the base will never have — the two diverge a
little more every ship, and GitHub answers every later PR with *"Can't automatically merge"* even
when the content is identical. A feature branch the host auto-deletes needs none of this: start the
next task from fresh `origin/<default-branch>` and `git branch -D` the old one. The reset
force-pushes, so say so — and check `git status --porcelain` is clean first (uncommitted work
would be destroyed).

Verify before claiming either is done: `git merge-base --is-ancestor origin/<branch>
origin/<default-branch>` exits 0 when the branch holds nothing the base lacks.

The primary-checkout pull matters when anything outside the repo points *into* it — symlinked
skills, an editor workspace, a tool resolving its root from that path. Ship from a worktree and
that checkout silently falls a commit behind every time, serving yesterday's content. Only
`--ff-only`, and only when it's clean and on the default branch: report and leave it alone
otherwise, it isn't the branch you were asked to ship.

## Rules

- **Never push to `main`/`master` directly** — always via PR
- **Report in lines, not paragraphs** — what you did, what needs the user, nothing else. Never
  narrate the steps; the commands are already in the transcript.
- **Never merge with failing CI** — check `gh pr checks` first; if red or pending, report and wait
- **Never `--admin` merge** (bypassing branch protection) unless the user explicitly says to
- **Never force-push** an existing PR branch without saying so first
- One PR per concern, same as commits — don't bundle unrelated branches into one PR

## If fail

- `gh` not authenticated → tell the user to run `gh auth login`
- `gh pr create` warns *"Can't automatically merge"* → that's the base's problem, not `gh`'s.
  The PR still gets created. Don't stop there — go verify it as the next bullet says.
- Merge conflict with base branch → STOP, report, don't resolve unilaterally. Exception: a
  long-lived branch squash-merged earlier that skipped the reset above — then the "conflict" is
  squash history mismatch, not divergent content. Verify: `git diff origin/<base> HEAD --stat` versus
  the diff of the branch's own unmerged commits (`git diff <first-unmerged>~1 HEAD --stat`).
  Identical means base holds nothing the branch lacks, so `git merge origin/<base> -X ours` is
  safe (branch wins every textual conflict, content is a strict superset) — say so, merge, then
  do the post-merge reset so it stops recurring. Not identical → STOP and report, don't guess.
- CI red → report which check failed, don't merge, don't retry blindly
