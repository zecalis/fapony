// src/plan/adopt.ts — `fapony plan adopt <any-doc.md>`
//
// The entry the plan format was missing: someone outside this workflow hands
// the session a document (handoff, client request, ticket) and the agent had
// to re-decide everything by hand. Adopt moves that doc into .fapony/plan/
// under a proper PLAN name so every downstream mechanism — `fapony plan`
// chunk listing, `plan:name` fael anchors, plan sweep, move-to-done — works
// on a document nobody wrote as a PLAN.
//
// Sync-only, deterministic, no LLM and no judgment: resolve a unique
// PLAN-<slug>.md, prepend frontmatter + TL;DR, keep the original body verbatim
// under "## Context (adopted)", and point at the skill that does chunking
// (chunk-cutting is judgment, so it stays in the agent's flow — chunk 2's
// scope line). Never touches the source file.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { doneDir, planBase, root } from "./store.js";

// The fael anchor is lowercase `[a-z0-9._-]`; planKeyName (sweep.ts) already
// holds that rule for PLAN names, so the slug the name is built from respects
// it on the way in.
export const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/\.md$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

// The TL;DR is 15 lines, hard cap (templates/PLAN.md); a drafted chunk list
// sits under a count the agent produces with the skill — never guessed here.
function planTemplate(name: string, origName: string): string {
  const anchor = `plan:${name}`;
  return `---
kind: unit
status: active
---

# PLAN-${name} — (title: one line from the adopted doc)

> **Status:** 🚧 adopted — not yet chunked · **Adopted:** ${new Date().toISOString().slice(0, 10)} · from ${origName}

## TL;DR
- **What:** (cut from the adopted doc — \`/plan-with-pony adopt\` drafts it)
- **Why:** (why this doc exists — the doc's own words)
- **Done when:** (testable)
- **Order:** (what this waits on / what it unblocks)
- **Progress:**
  - [ ] chunk 1 — (cut chunks with /plan-with-pony adopt — agent fills in)

## Context (adopted from ${origName})
The doc below is adopted verbatim — it is input, not agreement. Every claim an
agent keeps from it must be re-verified before it becomes a plan line; §1–§8
and the chunk cut are the skill's job, nothing here is pre-ticked.

---
**Handoff (fael):** anchor \`${anchor}\` — \`fapony plan PLAN-${name}.md\` prints the open handoff and how to close a chunk.
`;
}

export function cmdPlanAdopt(a: string[]): void {
  const usage = "usage: fapony plan adopt <any-doc.md>";
  const target = a.find((x) => !x.startsWith("--"));
  if (!target || a.includes("--help") || a.includes("-h")) {
    console.error(usage);
    process.exit(a.includes("--help") || a.includes("-h") ? 0 : 1);
  }
  // cwd first (monorepo subdir), then the repo root — resolvePlan's order
  const src =
    [resolve(target), resolve(root, target)].find((p) => existsSync(p)) ??
    resolve(target);
  if (!existsSync(src)) {
    console.error(`plan adopt: not found: ${target}`);
    process.exit(1);
  }
  const origName = basename(src);
  if (/^PLAN-/.test(origName)) {
    console.error(
      `plan adopt: ${origName} already looks like a PLAN — use it where it is, or rename first`,
    );
    process.exit(1);
  }

  const slug = slugify(origName);
  if (!slug) {
    console.error(`plan adopt: cannot derive a PLAN name from "${origName}"`);
    process.exit(1);
  }
  // Unique name: PLAN-<slug>.md, then -2, -3… (plan-seed's refusal is on a
  // fixed name; adopt resolves its own, so the overlap check differs). done/
  // counts as a collision too: a shipped PLAN-<slug>.md would otherwise make a
  // same-named doc unadoptable forever, so skip past it like a live one.
  const base = join(planBase, "plan");
  let name = slug;
  for (
    let n = 2;
    existsSync(join(base, `PLAN-${name}.md`)) ||
    existsSync(join(doneDir, `PLAN-${name}.md`));
    n++
  ) {
    name = `${slug}-${n}`;
  }

  const body = readFileSync(src, "utf8");
  mkdirSync(base, { recursive: true });
  writeFileSync(
    join(base, `PLAN-${name}.md`),
    planTemplate(name, origName) + body,
  );
  console.log(`adopted ${target} → PLAN-${name}.md`);
  console.log(
    `anchor: plan:${name} (fael rows about this plan tag --files plan:${name})`,
  );
  console.log(
    `next: /plan-with-pony adopt — chunk-cutting is the skill's job, not this command's`,
  );
}
