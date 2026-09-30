// src/plan/index.ts — `fapony plan [<PLAN.md>] | adopt | sweep | check`

import { cmdPlanAdopt } from "./adopt.js";
import { cmdPlanNext } from "./next.js";
import { initPlanStore } from "./store.js";
import { cmdPlanCheck, cmdPlanSweep } from "./sweep.js";

const HELP = `usage: fapony plan [<PLAN.md> | --files <path>] | adopt <any-doc.md> | sweep [<PLAN.md>] [--apply] | check [--quiet]

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
  fapony plan check           frontmatter deps, broken links, ticked-chunk shas
                              (exit 1 on issues)

close a chunk: tick it with its sha, commit, then
  fael add note "<what chunk N+1 must know>" --files <f1>,plan:<name> --key plan:<name>:chunk-<N+1>
  (<name> = PLAN-<name>.md, lowercase)
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
  else if (sub === "check") cmdPlanCheck(rest);
  else cmdPlanNext(a);
}
