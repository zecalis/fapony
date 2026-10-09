# Plan Core — template for every plan file

> Use this template for every plan file (not just fapony) — see [CLAUDE.md](../CLAUDE.md) § Rules
> for AI Agents for the rules each plan must pass before an agent may execute it.

```markdown
---
kind: unit                        # `tracker` for a checklist that never finishes; omit = unit of work
status: active                    # active | blocked | superseded · omit = not started
blocked_by: <plan or sentence>    # required when status: blocked
blocks: PLAN-<other>.md           # plans that cannot start until this one lands (comma-separated)
superseded_by: PLAN-<other>.md    # required when status: superseded
spec: SPEC-<feature>.md           # if any
priority: high                    # optional: high = listed first by `fapony plan` · omit = normal
---

# PLAN-<feature>.md — <short name>

> **Source spec:** [spec/<feature>.md](../spec/<feature>.md) — if any

## TL;DR
- **What:** one line
- **Why:** one line — the decision or the pain, not the implementation
- **Done when:** one line, testable
- **Order:** what this waits on / what it unblocks (mirrors the frontmatter)
- **Progress:**
  - [x] chunk 1 — <what landed>  `<short sha>` <YYYY-MM-DD> · verdict: <grade>
  - [ ] chunk 2 — <what is next>
  - [~] chunk 3 — <dropped: why in one line>  (fael:<decision id>)

---

## 1. Goal (why)
1–3 sentences — if a reader can't answer "so what" after reading = not clear yet

## 2. Scope (do / don't do)
**Do:** 3–7 bullets, outcomes not tasks
**Don't do:** 2–5 bullets + 1-line reason per item

## 3. Done criteria (how we know it's finished)
3–6 bullets — testable (tests pass / command runs / user can reproduce)
Never write bare "done" — must be measurable

## 4. Constraints / Hard rules (must not violate)
3–8 bullets — violations that break things (not "good practices"), specific to this plan —
never copy CLAUDE.md/AGENTS.md rules here: the agent reads those anyway, and a copy goes stale

## 5. Risks & Escape hatches (if it fails)
3–5 bullets: risk → escape hatch

## 6. Steps (what in which order)
1. **<Step 1>** — has a clear deliverable
2. **<Step 2>** — ...
Each step must be verifiable before moving to the next
A step needing state the system doesn't store yet must say where it lives, who writes it, who reads it
A measurement step states before it runs: the metric, the data set / window, the pass threshold, and
what each outcome leads to — it closes with the result's fael decision `(fael:<id>)`, not a commit

## 7. Examples (make it concrete)
bash examples: before / after — **link into spec/, don't paste it.**
If Source spec exists, this section stays ≤5 lines (1-2 examples or a pointer);
anything longer belongs in the spec file, not here.

## 8. References
- link back to related files
```

**Two rules that keep the file cheap to read:**
- **The TL;DR is 15 lines besides its chunk lines, hard cap** (one line per chunk, whole TL;DR under 4000 chars). It is the only part that changes while the work is in
  flight (tick a box, stamp a sha); everything below it is the agreement and changes only when
  scope changes. That contract is what lets a reader trust the first 40 lines instead of pulling
  100KB into context.
- **`plan_list` counts the checkboxes in the first `##` section only** — whatever that section is
  called, so the tally works in any language, and a step list deeper in the file stays detail
  instead of becoming status.
- **Closing a chunk leaves a handoff in fael** — tick it with its sha, commit, then
  `fael add note "<what chunk N+1 must know>" --files <f>,plan:<feature> --key plan:<feature>:chunk-<N+1>`.
  `plan:<feature>` (lowercase) is an anchor, not a path: the path moves when the plan is archived
  into `done/`. `fapony plan PLAN-<feature>.md` lists these rows, the next chunk's first.

**Where files live:** `.fapony/plan/` live · `.fapony/done/` shipped (a sibling, so archiving is a
plain `git mv` that keeps every relative link working) · `.fapony/spec/` the specs plans cite (a spec moves to `done/` with the last plan that cites it).
See [examples/](../examples/) for the whole layout with one file per shape.

**Language:** frontmatter keys and values are English always (they are an enum a tool reads);
headings stay as this template has them; everything else is written in whatever language the dev
reads, because the plan is for them.

**4 iron rules:**
- Sections 1–4 are mandatory — if missing = plan is immature, agent must not execute
- Section 6 each step must be verifiable — if you can't tell it passed = not clear yet
- Section 8 must link back — prevents drift and gives context on reopen
- **Plan is "what/why/order", spec is "how in detail"** — API shapes, schemas,
  wireframes, edge-case tables go in [spec/](../spec/), the plan only links to
  them. A plan that keeps growing past ~200 lines is spec content leaking in,
  not a plan getting more thorough — split it out.

Use [templates/SPEC.md](SPEC.md) for the spec file itself — it links back to
every plan that uses it, so the relationship reads both ways.
