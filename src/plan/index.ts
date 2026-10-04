// src/plan/index.ts — `fapony plan [<PLAN.md>] | adopt | sweep | park | unpark | check`

import { cmdPlanAdopt } from "./adopt.js";
import { fixPlanState } from "./fix.js";
import { cmdPlanNext } from "./next.js";
import { cmdPlanPark } from "./park.js";
import { initPlanStore } from "./store.js";
import { cmdPlanCheck, cmdPlanSweep } from "./sweep.js";

const HELP = `usage: fapony plan [<PLAN.md> | --files <path>] | adopt <any-doc.md> | sweep [<PLAN.md>] [--apply] | park|unpark <PLAN.md> [--apply] | check [--quiet] [--fix]

  fapony plan                 every active plan: progress + next unchecked chunk
  fapony plan <PLAN.md>       one plan: unchecked chunks, last-tick sha check,
                              spec link, open fael rows about it (the handoffs)
                              <PLAN.md> = file, path, name, plan:x, plan:x:chunk-3
                              or a unique substring; ambiguous → list, exit 1
  fapony plan --files a.ts[,b.ts]
                              the plans + specs (plan/, done/, spec/) that mention them
  fapony plan adopt <doc.md>  bring someone else's doc into the plan flow:
                              unique PLAN name, frontmatter + TL;DR prepended,
                              doc body kept verbatim (sync-only, no chunking)
                              → /plan-with-pony adopt cuts the chunks
  fapony plan sweep           shipped plans not yet archived (dry run)
  fapony plan sweep <PLAN.md> --apply
                              move a shipped or superseded plan into done/
                              (git mv; plain rename when .fapony/ is gitignored)
                              + rewrite the links to it
  fapony plan park <PLAN.md> --apply
                              set a plan aside (situation changed, not shipped):
                              plan/ → parked/, links rewritten, spec stays in spec/
  fapony plan unpark <PLAN.md> --apply
                              parked/ → plan/, links rewritten
  fapony plan check           frontmatter deps, broken links, ticked-chunk shas
                              (exit 1 on issues; read-only)
  fapony plan check --fix     first repair what has exactly one answer: a tick whose
                              commit was squashed away → the squash commit on the
                              default branch; a link to a plan that moved between
                              plan/, done/ and parked/. No match or several → reported only

close a chunk: tick it with its sha, commit, then
  fael add note "<what chunk N+1 must know>" --files <f1>,plan:<name> --key plan:<name>:handoff
  (<name> = PLAN-<name>.md, lowercase; one key per plan — fael supersedes the previous note)
example: fapony plan .fapony/plan/PLAN-x.md`;

export function cmdPlan(a: string[]): void {
  const [sub, ...rest] = a;
  if (sub === "-h" || sub === "--help" || rest.includes("--help")) {
    console.log(HELP);
    return;
  }
  initPlanStore();
  if (sub === "adopt") cmdPlanAdopt(rest);
  else if (sub === "sweep") cmdPlanSweep(rest);
  else if (sub === "park" || sub === "unpark")
    cmdPlanPark(rest, sub === "unpark");
  else if (sub === "check") {
    if (rest.includes("--fix")) fixPlanState();
    cmdPlanCheck(rest);
  } else cmdPlanNext(a);
}
