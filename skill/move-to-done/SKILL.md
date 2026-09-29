---
name: move-to-done
description: Move a shipped PLAN to .fapony/done/. Trigger on /move-to-done and when the user asks to archive a completed plan.
---

# Move to Done — archive PLAN after ship

You are about to move a PLAN that has been shipped to the archive.

## Rules

0. **Report in lines, not paragraphs** — what moved, what the inbound-link sweep found, what
   needs the user. Never narrate the steps; the commands are already in the transcript.

1. **PLAN must have shipped header** — regex: `^> ✅ \*\*.*shipped.*\*\*$`
   If missing, add it yourself, don't ask — invoking this skill *is* the ship claim (the user
   has already verified the work landed; this step is paperwork). Replace the plan's
   status/header line with `> ✅ **shipped <YYYY-MM-DD>** (<hash>)` — today's date plus
   `git rev-parse --short HEAD`. The date is load-bearing: it is the *only* record of when this
   shipped that a later question can read, since the filename does not carry one.
   Say in the summary that you stamped it, so a wrong HEAD is visible and correctable.
   STOP only if there's no git repo / no commits to hash from.

 1b. **A plan can also leave `plan/` without shipping** — it got absorbed into another plan, or the
   redesign deleted the thing it planned. That is normal during a UI/UX sweep and is the main
   reason `plan/` grows forever: there is no state for "dead" so it just sits there. Archive it
   the same way, with two differences — header `> ⛔ **superseded by [PLAN-bar.md](PLAN-bar.md)**
   (<date>)` instead of the shipped header, and frontmatter on the successor's side left alone
   while this file gets:
   ```yaml
   status: superseded
   superseded_by: PLAN-bar.md
   ```
   Then skip step 5 — no work shipped, so there is nothing to record. Never archive a plan as
   superseded on your own reading; the user says which plan replaced it.

   A plan that is merely *waiting* (on a person, a customer, a decision) is **not** dead and does
   not move — mark it `status: blocked` + `blocked_by: <what you are waiting for>` and leave it in
   `plan/` — the frontmatter is for the next person reading the folder, and the plan stays out
   of `done/`, which is what `fapony plan` and `plan sweep` go by. Never `--apply` a blocked file;
   a blocked file with all chunks ticked is deferred doc debt — ask the user: ship it or keep
   waiting.

 1c. **Check the dep graph before moving** — `fapony plan check` reads `blocked_by`/`blocks`
    and says what a human would miss: a `blocked_by` pointing at a file that is not in `plan/`
    or `done/`, a blocker already in `done/` while the dependent is still `status: blocked`,
    a waiter cycle, and a blocked plan with all chunks ticked. Fix its issues first — a move
    on top of a broken graph just relocates the confusion.

2. **Run `fapony plan sweep --apply`** — this does the `git mv`, rewrites markdown links inside the
   file and inbound links from every `.md` under `.fapony/` (`plan/`, `done/`, `spec/`),
   warns about plain-text mentions and about tracked files outside `.fapony/` that still
   name the file, prints a `🔓 <shipped> — <waiter> lists it as blocker` line when the ship
   unblocks a waiting plan (copy that line into your summary — the waiter keeps
   `status: blocked` until its owner clears it) — all in one call:
   ```bash
   fapony plan sweep <PLAN-foo.md> --apply
   ```
    It refuses if the file lacks a shipped header or fael still has an open issue about it or an open handoff row (`plan:<name>:chunk-N`, any kind) — general notes and decisions travel with the plan.
   If git refuses ("not under version control" — `.fapony/` is gitignored in this repo), plain
   `mv` instead; there's nothing to commit for an untracked path, so skip step 4 in that case.
   The filename gets no date prefix — the ship date is already in the header (step 1).

3. **Leave the spec where it is** — `.fapony/spec/` is a reference library, not a queue. A spec
   answers "how does this work", which is asked long after the plan that ordered it shipped, and
   a spec that never moves is a link that never breaks. Nothing to do here; there is no
   `spec/done/`.

4. **Commit** (only when the moved files are actually tracked by git):
   ```
   chore(plan): archive PLAN-foo.md (shipped <hash>)
   ```

5. **Leave a note when the ship taught something** — the move itself is in git, so a
   clean ship needs nothing more. When the plan hit something a reader could not get
   from the diff, call fael's `add` tool (or `fael add`) once:
   - `kind`: `note`
   - `text`: what the symptom looked like, where the cause actually was, and the
     rule that follows. Standalone prose — it is read months later with no access
     to this conversation. Write one only then — "clean ship" files nothing, and a
     note that repeats the diff teaches the next session nothing
   - `files`: repo-relative paths this plan touched (`git diff --name-only <base>..HEAD`)
     plus the archived plan's path (post-move, e.g. `.fapony/done/PLAN-foo.md`)
   Skip only if fael isn't available in this session — don't block the archive on it.

## Example

```
Input: .fapony/plan/PLAN-kickoff.md, no shipped header yet
Steps:
1. stamp header: > ✅ **shipped 2026-09-13** (a1b2c3)
2. fapony plan sweep .fapony/plan/PLAN-kickoff.md --apply
   → moved, links rewritten
3. spec: untouched, stays in .fapony/spec/
4. commit
5. (clean ship — the move is in git, nothing more to file)
```

A ship worth a note looks like this instead:

```
5. add(kind="note",
     text="sheet scroll reset on open, not close — the restore hook was on the wrong side; the router's own scrollRestoration resets on every navigate(). Check the router option before writing a restore hook.",
     files=["src/routes/expenses/index.tsx", ".fapony/done/PLAN-quick-nav.md"])
```

## If fail

- No git repo / no commits (can't derive a shipped hash) → tell user: "Add header > ✅ **shipped** (<hash>) first"
- Stamped the header yourself → always say which hash you used
- plan sweep refuses (open fael issue) → fix and `fael close` it, or `MEM_FORCE=1`
- Too many inbound links → plan sweep reports them; too many to fix → report the list
