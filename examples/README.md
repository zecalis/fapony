# examples/ — what a plan folder looks like

Five plans and one spec, laid out exactly as a real project's `.fapony/` is: live plans in
`plan/`, shipped ones in `done/`, specs in `spec/`. Each file is here to show a different shape,
not to be read end to end.

| File | Shows |
|---|---|
| [plan/PLAN-feature-export.md](plan/PLAN-feature-export.md) | the standard shape — frontmatter, a TL;DR with a 2/4 progress tally, `blocks:` ordering, a `spec:` link |
| [plan/PLAN-webapp-notifications.md](plan/PLAN-webapp-notifications.md) | `status: blocked` with `blocked_by:` as a sentence — waiting on a person is not backlog |
| [plan/PLAN-refactor-auth.md](plan/PLAN-refactor-auth.md) | `kind: tracker` — a list that never finishes, kept out of the backlog count |
| [plan/PLAN-cli-logger.md](plan/PLAN-cli-logger.md) | **no frontmatter at all** — still grouped correctly from run history, so an existing folder of plans needs no migration |
| [done/PLAN-fix-race-condition.md](done/PLAN-fix-race-condition.md) | the archive: shipped header carries the date, the filename does not |
| [spec/SPEC-export.md](spec/SPEC-export.md) | the detail a plan links to instead of pasting — it moves to `done/` with the last plan that cites it |

This is what `plan_list` returns for this folder (`format: "markdown"`) — five files summarised
in eight lines, with no plan body read into context:

```
## active — in order (1)
- [ ] PLAN-feature-export — 2/4 · unblocks PLAN-webapp-notifications.md

## blocked (1)
- [ ] PLAN-webapp-notifications — 0/3 · waiting: waiting on the daily-digest wording from whoever owns support email

## untouched (1)
- [ ] PLAN-cli-logger — never attempted

## trackers — not backlog (1)
- [ ] PLAN-refactor-auth — 2/5

done: 1 archived
```

In a real project these three directories are `.fapony/plan/`, `.fapony/done/` and
`.fapony/spec/`, which is where `plan_list` looks by default — point `paths.planDir` /
`paths.doneDir` / `paths.specDir` at them if your repo keeps plans somewhere else (`apps/<app>/plan`,
say). Then ask your agent *"what's left, and what's blocked?"*.

The rules behind the format: [../templates/PLAN.md](../templates/PLAN.md) (plan) ·
[../templates/SPEC.md](../templates/SPEC.md) (spec) ·
[../skill/plan-with-pony/SKILL.md](../skill/plan-with-pony/SKILL.md) (drafting) ·
[../skill/move-to-done/SKILL.md](../skill/move-to-done/SKILL.md) (archiving).
