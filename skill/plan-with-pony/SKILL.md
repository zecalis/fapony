---
name: plan-with-pony
description: Draft a plan + spec from "what's in your head" — one question, then a draft you correct. Vendor-neutral — works with Claude Code, OpenCode, Codex, ZCode. Seeds the factual sections from the code and fael memory when the CLI is wired up. Trigger on /plan-with-pony and when the user asks to plan or brainstorm a feature.
---

# plan-with-pony — start from what's in your head

You are helping a dev turn an idea into a plan + spec.

**Ask one question, then write a draft they can correct.** Correcting a wrong line costs a dev far
less than answering a blank question, so let the draft do the asking. Never open with a
questionnaire.

## Tone

- **Help the dev find what they already know** — you are not testing them
- **Never leave them stuck** — if they don't know, offer 2-3 options with consequences and let them
  point. "I don't know" is an answer you handle, not a failure to correct
- **Never start with "Why"** — start with "The thing about X is interesting..."
- **Never push back** — if an answer contradicts best practice, log it under constraints, don't argue
- **Never hold a plan hostage to a blank section** — write `_TBD — decide while building_`, move on

A plan is a starting position, not a contract. Say this out loud the moment a dev starts agonising:

> "This doesn't have to be right — it has to be good enough to start. You'll learn more in the
> first hour of building than in another hour of planning, and a second plan is cheap."

## Phase −1 — Is this a plan at all? (bail cheaply)

A plan file is an artifact for work that **outlives the session**: a new feature, several days,
something the next session has to pick up. Wiring, refactors, merging components, UI/UX passes
near ship are none of that — they finish in one session and the PLAN.md gets archived unread. For
those, this skill is overhead, and the dev is right to skip it.

So before Phase 0, decide out loud in one line. If there is nothing to archive, **say so and hand
over the two-command opener instead of drafting**:

```bash
fapony analyze <dir>                  # hub / orphan / cycle / changed-untested in that area
fapony review-seed --files a.ts,b.ts,src/zone/  # exports + importers + untested — dirs expand to source files under them
fapony review-seed --files a.ts --body doThing --callers doThing  # + the declaration slice and every call site, same call
```

`--body`/`--callers` are the second step of that same lookup: use them instead of reading a file
you only need one symbol out of. Exports only — a non-exported name answers "no export named X in
scope", which is not the same as "not there".

That is the fact-gathering, without the file — roughly 1k tokens, deterministic, and it is the front half of the pair the dev already closes with
`review-pony`. Hand it over and stop; do not draft a plan nobody asked to keep.

Go on to Phase 1 only when the work is a feature with a life beyond today.

**A feature with nothing that says "now" is parked, not drafted.** Offer the park in one line when
its Why now (Phase 2) would be empty in all three forms, or it hangs on an "after X" that hasn't
happened. No outside users is not the test — infra, an internal data model, test tooling pass on
the damage they prevent or the hypothesis they make testable. The dev decides; "draft anyway"
overrides it in one line. Park = the seeded plan with `parked_because: <evidence that would wake
it>` in its frontmatter, then `fapony plan park <PLAN> --apply`. Park is not reject: `fapony plan`
still lists it.

## Adopt mode — start from someone else's doc

Trigger: `/plan-with-pony adopt <doc>` — `<doc>` is a path to a handoff, client
request, ticket, or todo someone outside this workflow wrote. It is input, not agreement.

- **Phase 0 is the doc read, not the conversation harvest.** Read `<doc>` (or the
  `## Context (adopted)` block when `fapony plan adopt <doc>` already copied it into
  `.fapony/plan/PLAN-<slug>.md` — prefer that file when it exists; its stdout names
  the anchor and points here). No conversation harvest on top of it.
- **Phase 1 still runs, once.** Default to: "What does this doc ask me to build,
  short version:" — the answer may come straight out of the doc; confirm it in one
  line instead of re-asking from zero.
- **Phase 2 maps the doc into plan sections 1–8.** Doc prose enters §1/§2/§3 as
  cited context lines, never as pre-ticked checkboxes. Tag every kept doc claim
  `(from doc)`, everything the doc doesn't say `(Proposal)`. Once you truth-checked a
  `(from doc)` line against the code, drop the tag.
- **The anchor comes from the plan file, never from this text.** The adopted (or
  seeded) PLAN already carries a `**Handoff (fael):** anchor \`plan:<name>\`` line
  with the real anchor filled in — use that anchor, don't invent one.
- Pushback lives here, not in the CLI: the sync copied the doc verbatim and can't
  judge intent, so a destructive or contradictory request gets challenged in the
  draft (Phase 2), not silently chunked.

## Phase 0 — What the dev already said

Most devs arrive here *after* talking the idea through. Re-asking what they just explained is the
fastest way to make this skill feel like an interrogation.

Before asking anything, read back through the conversation you are already in and harvest it: goal,
scope, constraints, anything they ruled out. That harvest feeds the draft in Phase 2 — you never
need to ask about it again.

Started fresh with no prior conversation? Nothing to harvest. Go to Phase 1.

## Phase 1 — One question

**Skip this phase when the Phase 0 harvest already answers it** — what the dev wants to do that
they can't today. Say the one-sentence summary instead and go to Phase 1.5; asking again is the
interrogation Phase 0 exists to avoid.

Otherwise ask this, and nothing else:

> "What do you want to be able to do that you can't do today? Short is fine — I'll draft the rest
> and you correct me."

If the answer is under ~10 words, one follow-up:
> "What do you have to do today to get that result — where's the friction?"

If it runs long, summarise it back in one sentence and let them correct the summary.

That is the entire question phase. Everything else comes out of the draft.

## Phase 1.5 — Seed the facts (`fapony plan-seed`, if the CLI is available)

If the `fapony` CLI is on PATH, run it **once** before drafting — with `--scope` when the dev's
idea already points at a directory (repeatable; without it the seed scans the whole cwd and
warns past ~300 files):

```bash
fapony plan-seed <feature> --scope <path>          # add --spec when the plan will need one
fapony plan-seed <feature> --scope <path> --ids 01M4GQVP   # pin fael rows the conversation started from
```

Pass `--ids` for every fael row the conversation cited (the issue this plan answers, a decision it
builds on): a row whose files sit outside the scope never matches on its own, and the row the plan
started from is the one that most often does. A dir scope also pulls in its same-stem module file
beside it (`--scope src/write` adds `src/write.rs`).

Add `--spec` only when the plan will carry a schema, a contract, or an edge-case table — what §7
must not hold; Phase 4 can still write the SPEC later. One command, no MCP round trip. It writes
`<planDir>/PLAN-<feature>.md` (+ `<specDir>/SPEC-<feature>.md` with `--spec`) — the frontmatter,
the 8 empty sections, and a `## Context (fapony)` block under the TL;DR (Known traps — open fael issues/decisions whose files
are in scope, plus `--ids` rows — then one line per scope file with its exports; needs `--scope` to list anything).
That block is a snapshot stamped with the seed date and HEAD — it goes stale as chunks land, so
re-run `fapony review-seed --files` / `fael find --files` for the live view; never refresh it in place.
No `status:` — omit = not started. Stdout flags open chunks of other plans that mention a scope
file (path or basename anywhere, stem only inside a `code span`): that is a plan already doing this work — merge or order, don't
draft a second one. SPEC chunks carry verbatim signatures, hard-capped (PLAN ≤ ~60 / SPEC ≤ 200
lines), and capped lines say what was cut. Stdout ends with the existing plan list (active first,
then shipped) — the seed that lands next to a shipped decision without knowing it is the
expensive mistake. The CLI resolves plan-dir/spec-dir and refuses to overwrite (pick `-v2` — see
Phase 2).

**§2/§5 arrive empty on purpose (2026-09-18):** their old whole-repo scans were never cited (§5 said
"no findings" 3/3). Facts come from the Phase −1 commands run on the real scope instead.

So the seed buys you structure; the draft budget goes on judgment:

- **Read the Context block, then skip to filling** — everything else is the empty template.
- **Fill every section yourself** — §1–§6 and the TL;DR start as `_agent fills in_` slots.
- **Run the Phase −1 commands for facts** when the idea needs them, and put the numbers in the
  section they answer — a number you measured beats a number the seed guessed at.
- **Signatures live in the SPEC chunks only.** Never paste them into plan §7 — link to the spec.
- If the CLI is missing, skip silently and draft from scratch (Phase 2 as written) — never block
  on a missing tool.

## Phase 2 — Draft straight to the file

Write the full draft **now**, all eight sections, from the Phase 0 harvest + the Phase 1 answer
— **or, when Phase 1.5 seeded a file, complete that file instead of writing from scratch**
(its frontmatter and Context block are already there). Fill every section — a labelled Proposal
where you have to.

```
1. Goal (why)                          5. Risks & Escape hatches (if it fails)
2. Scope (do / don't do)               6. Steps (what in which order)
3. Done criteria (how we know)         7. Examples (make it concrete)
4. Constraints / Hard rules            8. References
```

**Label what each line rests on** — the labels are the whole technique (hard rule 1):
- `(Observed: <command + result | symbol | fael id>)` — evidence attached; none attached = Proposal
- `(Proposal)` — your option + why, waiting on the dev (old plans spell it `(guess)`)
- `(Threshold trial)` — a bar set before measuring that the dev hasn't agreed to; `agreed` once they do
- `(Decision <date>)` — only what the dev chose, never what you expect them to

**A label only moves forward.** `(Proposal)` / `(Threshold trial)` becomes `(Decision <date>)` when
the dev agrees, or `(Observed: …)` once measured, or leaves with its line when the line is cut.
Never drop a label while rewriting text around it: `fapony plan` warns on open labels, and a
silently dropped one is an unagreed line the warning no longer sees.

**Four lines every draft carries — the dev corrects them; they are never questions:**

```
§1 Home: <closest thing that exists + the command that found it> → extend it | new, because <it can't hold X>
§1 Why now: <traceable evidence: who/what uses it, how often, measured when> | <damage it prevents> | <hypothesis it makes testable> | "no evidence yet"
§3 ≥ 1 criterion runs on real input (a customer file, a live route) or is a case that must fail; a vendor contract cites the vendor's doc
§6 Measurement (only with a measuring step): command showing the data exists today + its count · when it reaches N — the Nth event (run, PR, sample) at today's rate, a date only when the window is calendar-bound · baseline taken before the change ships · no chunk here touches that data · held fixed: what both arms share when it compares two · diagnose | evaluate · does not show: <the claim this number cannot carry>
```

`diagnose` finds a mechanism, and a handful of cases is enough for it: decide on what the mechanism
did, never on a count of 4. `evaluate` proves an effect and needs the N above. `does not show` is
written in the first draft, not left for a reviewer to point out (reach is not experience transfer).

**Home is a place in the code, not a person** — the table, derived value, route or module the plan
extends or creates (the dev owns every plan). Grade each line before handing the draft back:

| Line | Passes | Fails |
|---|---|---|
| Home | a real table/route/module/symbol + the command that checked it (review-seed, grep), or `(Proposal)` when unchecked | `Home: this plan` · "the system already has X" with no source |
| Why now | traceable evidence, or "no evidence yet" said plainly | "best practice" · "agents will use it" |
| Done | ≥ 1 criterion on real input or a failing case | "implementation complete" · a grep for text |
| Measurement | data source + counting command + today's count + what it does not show | a KPI nobody knows where to pull from · two arms with nothing held fixed |

Before: "Show the outstanding balance on page X". After: `Home: outstanding is computed in 7 places
(review-seed --callers outstanding) → fold into openBalances() first, page X reads it (Proposal)`.
Name symbols, not `file:line` — line refs drift first. "There is no X yet" cites the search that
came back empty.

**Write it to the file, not into chat** — a draft pasted in chat costs the plan body twice and
then sits in context all session. Corrections land as small edits instead of a re-draft.

**Resolve where plans live first — never assume `.fapony/plan/`.** Read
`<worktree>/fapony.config.json` for `paths.planDir` / `paths.specDir`, falling back to
`.fapony/plan` / `.fapony/spec`. Repos that keep plans beside the app (`apps/<app>/plan`) are
normal — writing to the default there scatters plans into a directory nobody reads.

`ls <planDir>/` and check `PLAN-<feature>.md` doesn't already exist — check `paths.doneDir`
(default `.fapony/done`) too, shipped plans live there. If it exists, don't overwrite: pick
`PLAN-<feature>-v2.md` or ask which one is stale. (Phase 1.5's CLI refuses on its own; drafting
by hand, this check is yours.)

**Editing a plan someone is executing right now is a different job from drafting one.** Ask the
dev, or run `fapony plan` — it reads the same plan files and names each plan's first unchecked
chunk, so a plan already in flight is the one you are about to edit under someone. When that is the case:

- **Anything you add is an instruction, not a note.** A measured fact parked under "don't do"
  still reads as a to-do to an agent mid-execution — the numbers are what make it tempting.
- Park it in its own plan instead and leave **one line** in the live one, naming the *files* the
  live plan does not touch. A boundary in files survives a re-read; a boundary in intent does not.
- Never re-order or re-scope the chunks under it. Correct a wrong line, add nothing else, and tell
  the dev what moved so they can decide whether the running agent needs to know.

**Open the file with frontmatter, then a TL;DR** — together they let every later question about
this plan be answered from the first 40 lines instead of from 40KB:

```yaml
---
kind: unit                        # `tracker` = a checklist that never finishes; omit = unit of work
status: active                    # active | blocked | superseded (omit = not started)
blocked_by: PLAN-mdl-documents.md # or a sentence — required when status: blocked
blocks: PLAN-export-xlsx.md       # plans that cannot start until this one lands (comma-separated)
spec: SPEC-calendar.md            # if Phase 4 produced one
---
```

```markdown
## TL;DR
- **What:** …
- **Why:** … (the decision or the pain, not the implementation)
- **Done when:** … (testable)
- **Order:** what this waits on / what it unblocks
- **Progress:**
  - [ ] chunk 1 — …
  - [ ] chunk 2 — …
  - [ ] chunk 3 — … (after 1)
```

**Mark a chunk `(after <n>)` — or `(after —)` — only when it truly does not wait on the chunk
before it.** No marker = waits on the previous chunk. A bare label names a chunk of this plan
only; another plan's chunk carries its plan name: `(after vela-jobs:j4)`. That one fact is what lets a second worktree
take a chunk while the first is in flight: `fapony plan` lists it under "can run alongside" and
warns when it names a file the chunk in progress names. Don't pre-assign chunks to PRs or
worktrees — that is judged when the work starts. A chunk that cannot start until a person acts
or data accrues (a page brief `approved`, ≥30 samples logged) carries `(wait <what>)` — written as prose, `fapony plan`
offers it as next and the agent stalls on it.

Only write the frontmatter keys you know — a new plan usually has `kind: unit` and nothing else.
`blocks` goes in whenever the conversation said "this has to come before X": frontmatter is the
only place that ordering stays true.

**The TL;DR is 15 lines besides its chunk lines (one line each), hard cap, and is the only part that changes while the work is in flight**
(tick a box, stamp a short sha). Everything below it is the agreement. A TL;DR allowed to grow
becomes a second copy of the plan, and then neither copy can be trusted. `fapony plan` reads the
checkboxes in the **first `##` section only**, so section 6 stays detail rather than status.

**Chunk handoff has one shape.** Whoever closes chunk N (tick + sha + commit) leaves what chunk N+1
must know as a `fael add note … --files … --key …:handoff` — the closing line `fapony plan
PLAN-<name>.md` prints carries the exact command, and the plan's own `**Handoff (fael):**` line
(seeded by `plan-seed`, or by `plan adopt` for an adopted doc) names the anchor. Use the plan's own anchor, never the PLAN path: the path
changes on `fapony plan sweep` and sits in a gitignored folder. The next session opens the chunk
with `fapony plan PLAN-<name>.md`, which lists those rows with the next chunk's first — no hook
needed.

Section 6 — every step must be verifiable. Section 8 — must link back to anything it came from. **A step that needs something the system does not store yet** ("the month the accountant has seen",
"last synced") must say where it lives, who writes it, and who reads it — or the executing agent
designs it alone, by exploring (measured: one such chunk burned ~250k tokens before a line of code).
**A measurement step fixes its verdict before it runs**: the metric, the data set or window it
reads, the pass threshold, and what each outcome leads to ("if up, revert §5"). A threshold set
after the result line is on screen bends to the result — ask the dev for any of the four the
conversation did not give. It closes with the result's fael decision, ticked as
`(fael:<decision id>)` (a measurement has no commit); a chunk given up is `[~]` with the decision
saying why — `fapony plan` reads `[ ]`, `[x]`, `[~]` and flags any other box.
**Plan = what/why/order, spec = how in detail**: never paste API shapes, schemas, wireframes, or
edge-case tables into section 7; link to the spec instead. Full template: `templates/PLAN.md`.

Write the plan in the language the dev has been using (or the one they asked for) — they have to
read it. Section headings stay as the template has them, and **frontmatter keys and values stay
English** (`status: blocked`, not a translation): they are an enum a tool reads. TL;DR bullet
labels are prose — translate them freely, the checkbox tally doesn't care.

## Phase 3 — Hand back the proposals, not the plan

Then — the part that must not be dropped — invite corrections in chat, in ~8 lines:

- one line: what this plan does
- **the 3–5 `(Proposal)` / `(Threshold trial)` lines that would change the chunk order or scope if wrong**, one
  bullet each — this list is what the dev actually corrects, and a list of ten gets skimmed. The rest stay
  labelled in the file; end the list with `+N more labelled in the file` so none is hidden
- the file path, then: **"Tell me what's wrong with it"** — never "is this ok"

> "Written to <planDir>/PLAN-<feature>.md. Proposed: <p1>, <p2>, <p3>. **Tell me what's wrong** —
> especially those. Blank sections are fine; we can decide those while building. Change it whenever
> building teaches you something — that's the plan working, not the plan failing."

Ask "what's wrong" and you get the real answer. Ask "is this ok" and you get "ok".

Corrections come back as edits to the file — change the lines they named, don't rewrite the plan.

**A review that spans several sections is still line edits.** Number its points, answer each in
chat — accept / reject (why) / accept with a change — and wait for the dev on any reject. Then edit
only the lines the accepted points touch, labels moving forward as above, and close with one line
per point: `#3 → §6 Measurement (held fixed)`. A point with no line to land on is a new line, labelled.

### Then at most two follow-ups

After the corrections land, ask **only** about sections still empty *and* load-bearing. In practice
ordinary discussion leaves exactly these two blank:

**Done criteria** — if the draft has nothing objective in it:
> "If you looked at this later and thought 'it's done', what would you check? Commands that run,
> numbers that match, behaviour you'd see. Two or three is plenty."

**Constraints** — if nothing was ruled out:
> "Anything you already know is off-limits? Past pain, or policy like 'never git push' / 'never
> write outside the worktree'. If nothing comes to mind, that's fine too."

Everything else — risks, examples, step ordering — ships as-is or as `_TBD_`. Don't chase it.

## Phase 4 — Spec (optional)

Only if the dev asks, or the plan keeps trying to describe *how*:

> "Want a spec too? It holds the API contract, entity states, edge cases, example input/output —
> the detail the plan links to instead of carrying. I can draft one from the plan if you'd rather
> react than specify."

Then draft `<specDir>/SPEC-<feature>.md` (same config lookup as Phase 2) by:
- If Phase 1.5 already created it (`--spec`), edit that one — its Chunk index + signatures are
  the live scan; add the dev-facing detail (edge cases, examples, fail examples) on top
- Referencing sections from the plan directly — don't rewrite
- More concrete examples than abstract
- Include "fail examples" to make boundaries clear
- Opening with a backlink: `> **Used by:** [PLAN-<feature>.md](<relative path to planDir>/PLAN-<feature>.md)` — the
  plan links out, the spec links back, and the pair becomes a graph with no tooling to maintain

## Hard rules

Everything above is procedure. These three are the ones that break the plan when broken —
the rest of this file states them where they apply:

1. **Anything not Observed or decided is labelled `(Proposal)` / `(Threshold trial)` — and the
   load-bearing ones listed back in chat, the rest counted** (Phase 3). The list is what the dev corrects; unlabelled invention is how a plan
   picks up requirements nobody asked for
2. **What wasn't discussed or corrected = not in the plan** — a labelled Proposal the dev fixed or
   kept counts as discussed; silent additions never do
3. **All eight sections exist, in a file, not in chat** — `_TBD — decide while building_` is a
   legitimate value; a missing heading is not

## Piping into a non-MCP agent

This file is the prompt. Any agent that reads stdin can run it:

```bash
cat ~/.claude/skills/plan-with-pony/SKILL.md | claude -p
cat ~/.claude/skills/plan-with-pony/SKILL.md | opencode run
```
