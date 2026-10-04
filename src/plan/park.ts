// src/plan/park.ts — `fapony plan park|unpark <PLAN.md>… [--apply]`.
//
// Parked = set aside because the situation changed, not shipped: the plan
// leaves plan/ (so `fapony plan` stops offering its chunks) for parked/ beside
// it, links rewritten both ways. Its spec stays in spec/ — a parked plan may
// resume, and another plan may cite the same spec. The folder is the state:
// park drops `status: blocked` and keeps its `blocked_by:` reason as
// `parked_because:`; unpark drops `parked_because:`. Only a plan with no reason on file gets the fael
// decision command — fapony prints it, never writes it.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { claimedChunks } from "./parallel.js";
import { resolvePlan } from "./resolve.js";
import { isIn, parkedDir, planDir, rel, writeAtomic } from "./store.js";
import { firstSectionItems, planKeyName, relocatePlan } from "./sweep.js";

// Rewrite frontmatter lines only; null when there is no frontmatter or nothing changed.
const editFrontmatter = (
  src: string,
  edit: (fm: string[]) => string[],
): string | null => {
  const lines = src.split("\n");
  const end = lines[0]?.trim() === "---" ? lines.indexOf("---", 1) : -1;
  if (end < 0) return null;
  const out = [
    lines[0],
    ...edit(lines.slice(1, end)),
    ...lines.slice(end),
  ].join("\n");
  return out === src ? null : out;
};

// park: `status: blocked` goes, `blocked_by:` becomes `parked_because:` so
// nothing reads a parked plan as waiting on a blocker.
const retireBlocked = (src: string): string | null =>
  editFrontmatter(src, (fm) =>
    fm
      .filter((l) => !/^\s*status\s*:\s*blocked\s*(#.*)?$/.test(l))
      .map((l) => l.replace(/^(\s*)blocked_by(\s*:)/, "$1parked_because$2")),
  );

// unpark: the plan is back, so why it was set aside no longer holds.
const dropReason = (src: string): string | null =>
  editFrontmatter(src, (fm) =>
    fm.filter((l) => !/^\s*parked_because\s*:/.test(l)),
  );

const hasReason = (src: string): boolean =>
  /^\s*parked_because\s*:\s*\S/m.test(src.split(/\n---\s*\n/)[0] ?? "");

export function cmdPlanPark(a: string[], unpark: boolean): void {
  const verb = unpark ? "unpark" : "park";
  const targets = a.filter((x) => !x.startsWith("--"));
  if (!targets.length) {
    console.error(`usage: fapony plan ${verb} <PLAN.md>… [--apply]`);
    process.exit(1);
  }
  const [from, to] = unpark ? [parkedDir, planDir] : [planDir, parkedDir];
  // resolve every target first — a typo in the third must not leave two moved
  const files = targets.map((target) => {
    const r = resolvePlan(target);
    if (!r.ok) {
      console.error(
        r.candidates.length
          ? `${target} matches ${r.candidates.length} plans — name one:\n${r.candidates.map((c) => `  ${c}`).join("\n")}`
          : `${target} not found`,
      );
      process.exit(1);
    }
    if (!isIn(r.file, from)) {
      console.error(
        `${rel(r.file)} is not in ${rel(from)}/ — only a plan in ${rel(from)}/ can be ${verb}ed`,
      );
      process.exit(1);
    }
    return r.file;
  });
  for (const file of files) {
    // another worktree may be mid-chunk — the move would pull the file from under it
    const claimed = unpark
      ? []
      : claimedChunks(firstSectionItems(file).ordered);
    if (claimed.length)
      console.log(
        `⚠ ${claimed.length} chunk(s) still claimed (wip …) — stop that session first, or it ticks a parked plan:\n${claimed.map((l) => `  ${l.trim()}`).join("\n")}`,
      );
    const src = readFileSync(file, "utf8");
    const edited = unpark ? dropReason(src) : retireBlocked(src);
    if (!a.includes("--apply")) {
      const note = unpark
        ? " · parked_because dropped"
        : " · status: blocked dropped, blocked_by → parked_because";
      console.log(
        `${basename(file)}: would move ${rel(from)}/ → ${rel(to)}/ and rewrite the links to it${edited ? note : ""} (add --apply)`,
      );
      continue;
    }
    const dst = relocatePlan(file, to);
    if (edited) writeAtomic(dst, edited);
    if (unpark) continue;
    if (!hasReason(edited ?? readFileSync(dst, "utf8")))
      console.log(
        `  no reason on file — record why: fael add decision "parked: <why, and what would bring it back>" --files plan:${planKeyName(dst)}`,
      );
  }
}
