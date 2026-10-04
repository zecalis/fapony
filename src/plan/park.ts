// src/plan/park.ts — `fapony plan park|unpark <PLAN.md> [--apply]`.
//
// Parked = set aside because the situation changed, not shipped: the plan
// leaves plan/ (so `fapony plan` stops offering its chunks) for parked/ beside
// it, links rewritten both ways. Its spec stays in spec/ — a parked plan may
// resume, and another plan may cite the same spec. Why it was parked is fael's
// to keep: fapony prints the decision command, never writes it.

import { basename, dirname } from "node:path";
import { resolvePlan } from "./resolve.js";
import { parkedDir, planDir, rel } from "./store.js";
import { planKeyName, relocatePlan } from "./sweep.js";

export function cmdPlanPark(a: string[], unpark: boolean): void {
  const verb = unpark ? "unpark" : "park";
  const target = a.find((x) => !x.startsWith("--"));
  if (!target) {
    console.error(`usage: fapony plan ${verb} <PLAN.md> [--apply]`);
    process.exit(1);
  }
  const r = resolvePlan(target);
  if (!r.ok) {
    console.error(
      r.candidates.length
        ? `${target} matches ${r.candidates.length} plans — name one:\n${r.candidates.map((c) => `  ${c}`).join("\n")}`
        : `${target} not found`,
    );
    process.exit(1);
  }
  const [from, to] = unpark ? [parkedDir, planDir] : [planDir, parkedDir];
  if (dirname(r.file) !== from) {
    console.error(
      `${rel(r.file)} is not in ${rel(from)}/ — only a plan in ${rel(from)}/ can be ${verb}ed`,
    );
    process.exit(1);
  }
  if (!a.includes("--apply")) {
    console.log(
      `${basename(r.file)}: would move ${rel(from)}/ → ${rel(to)}/ and rewrite the links to it (add --apply)`,
    );
    return;
  }
  relocatePlan(r.file, to);
  const name = planKeyName(r.file);
  console.log(
    unpark
      ? `back in ${rel(to)}/ — fapony plan ${basename(r.file)} shows where it stands`
      : `record why: fael add decision "parked: <why, and what would bring it back>" --files plan:${name}`,
  );
}
