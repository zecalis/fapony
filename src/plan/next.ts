// src/plan/next.ts — `fapony plan [<PLAN.md>]`: where a plan stands.
//
// Replaces the plan half of `fapony mem kickoff` (memory moved to fael):
//   no arg    → every active plan: progress, first unchecked chunk, priority
//               high first, blocked marked; plus shipped-but-not-archived
//   <PLAN.md> → a brief sized for one chunk: the next unchecked chunk in full,
//               the rest one clipped line each, whether the last ticked
//               chunk's sha verifies, the handoff note (`fael add note …
//               --files <f>,plan:<name> --key plan:<name>:handoff`, legacy
//               `plan:<name>:chunk-<label>` too) and the batching + closing
//               rules. Other open fael rows are only counted — `fael kickoff`
//               owns that list.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { mentionsOfFiles, resolvePlan } from "./resolve.js";
import { doneDir, planBase, planDir, rel, root } from "./store.js";
import {
  checkTickedLine,
  chunkLabel,
  firstSectionItems,
  openRowsFor,
  parsePlanFrontmatter,
  planKeyName,
  planSweepCmd,
  shippedNotMoved,
} from "./sweep.js";

const HANDOFF_LIMIT = 5;
const TEXT_MAX = 200;
const LATER_MAX = 120;

/** The one copy of the batching + closing rules, printed by `fapony plan
 *  <PLAN>`. A copy baked into each PLAN at seed time drifted (4 variants of the
 *  closing line across 21 active plans), so plan-seed, plan adopt and init only
 *  point here. */
export const chunkRules = (anchor: string): string[] => [
  "batching: one session = one branch = one squash-merged PR, up to 3 chunks of this plan, one commit per chunk · a chunk gets its own PR when it changes a DB schema/migration or persisted format, touches auth/permissions/security or money logic, changes a public API/CLI contract, or needs a design review · close each chunk fully (tick + handoff note + commit) before the next; stop at anything that needs a human decision · a chunk that must build on an unmerged branch is stacked (PR base = that branch; once it merges: `git rebase --onto origin/main <lower> <upper>`)",
  `closing a step: tick TL;DR with sha (+ PR number once it exists) · \`git commit\` files only · \`fael add note "<what the next chunk must know>" --files <f1,f2>,${anchor} --key ${anchor}:handoff\` (one key per plan — fael supersedes the previous note)`,
];

/** First-section items with the `- [ ] ` / `- [x] ` marker cut off. */
const readPlanSectionItems = (
  planPath: string,
): { checked: string[]; unchecked: string[] } => {
  const strip = (l: string) => l.replace(/^\s*[-*]\s+\[[\sxX]\]\s+/, "").trim();
  const { checked, unchecked } = firstSectionItems(planPath);
  return { checked: checked.map(strip), unchecked: unchecked.map(strip) };
};

// One line saying whether the last ticked chunk actually closed. Verified
// shas stay silent; only the newest ticked chunk is ever mentioned. A tick
// with no label the parser can read is "the last tick", never a made-up one.
const closureHint = (checked: string[]): string | null => {
  const last = checked[checked.length - 1];
  if (!last) return null;
  const { missing, diverged, cited } = checkTickedLine(last, root);
  const label = chunkLabel(last);
  const who = label ? `chunk ${label} is ticked but ` : "last tick: ";
  if (missing.length)
    return `⚠ ${who}${missing[0]} is not in git — nothing proves it closed`;
  if (diverged.length)
    return `⚠ ${who}${diverged[0]} is held by no branch (squashed, branch deleted?)`;
  if (!cited) return `⚠ ${who}cites no commit — nothing to verify it closed`;
  return null;
};

// A "later" chunk is listed by what it is called, not what it does: bold off,
// cut at the first ": " / " (" / " · ", then at LATER_MAX. The full text stays
// in the PLAN, and it becomes "next" when its turn comes.
const headline = (s: string): string => {
  const flat = s.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
  const cut = flat.split(/:\s|\s\(|\s·\s/)[0];
  const h = clip(cut, LATER_MAX);
  return cut.length < flat.length && !h.endsWith("…") ? `${h} …` : h;
};

const readPlanTitle = (planPath: string): string => {
  try {
    return /^#\s+(.+)$/m.exec(readFileSync(planPath, "utf8"))?.[1].trim() ?? "";
  } catch {
    return "";
  }
};

const isHighPriority = (planPath: string): boolean => {
  try {
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(
      readFileSync(planPath, "utf8").slice(0, 1024),
    );
    return !!m && /^\s*priority\s*:\s*high\s*(#.*)?$/m.test(m[1]);
  } catch {
    return false;
  }
};

const clip = (s: string, max = TEXT_MAX): string => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

// The plan's `spec:` frontmatter → where it lives, or that it is gone. No
// `spec:` key = a plan without a spec, nothing to say.
const specLine = (planPath: string): string | null => {
  try {
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(
      readFileSync(planPath, "utf8"),
    )?.[1];
    const name = front && /^spec:\s*([^\s#]\S*)\s*(#.*)?$/m.exec(front)?.[1];
    if (!name) return null;
    const spec = join(planBase, "spec", basename(name));
    return existsSync(spec)
      ? `spec: ${rel(spec)}`
      : `⚠ spec ${basename(name)} is named in the frontmatter but not in ${rel(join(planBase, "spec"))}/`;
  } catch {
    return null;
  }
};

function showFiles(files: string[]): void {
  const hits = mentionsOfFiles(files);
  console.log(`# plans and specs mentioning ${files.join(", ")}`);
  if (!hits.length) console.log("(none)");
  for (const h of hits)
    console.log(
      `- ${h.label} ${h.name} — ${h.title}${h.shipped ? ` (shipped ${h.shipped})` : ""}`,
    );
}

function showPlan(file: string, chunk: string | null): void {
  const { checked, unchecked } = readPlanSectionItems(file);
  console.log(`# ${readPlanTitle(file) || basename(file)} — ${rel(file)}`);
  const spec = specLine(file);
  if (spec) console.log(spec);
  // `plan:x:chunk-<label>` picks another chunk as "next"; else the first unchecked
  const picked = chunk
    ? unchecked.findIndex(
        (c) => chunkLabel(c)?.toLowerCase() === chunk.toLowerCase(),
      )
    : -1;
  const at = Math.max(picked, 0);
  if (unchecked.length) {
    console.log(`\n## next\n- [ ] ${unchecked[at]}`);
    const later = unchecked.filter((_, i) => i !== at);
    if (later.length) {
      console.log(`\n## later (${later.length})`);
      for (const c of later) console.log(`- ${headline(c)}`);
    }
  } else {
    console.log(`\n(all chunks checked — ready to ship or archive)`);
  }
  const hint = closureHint(checked);
  if (hint) console.log(hint);

  // Handoff = the rows the session opening the next chunk came for:
  // `plan:<name>:handoff` (one key per plan, fael keeps only the newest open)
  // or a legacy `plan:<name>:chunk-<label>`. The next chunk's legacy row leads;
  // stable sort keeps newest-first. Every other open row about the plan is only
  // counted — `fael kickoff` owns that list.
  const name = planKeyName(file);
  const nextLabel = unchecked[at] ? chunkLabel(unchecked[at]) : null;
  const handoffKey = name ? `plan:${name}:handoff` : null;
  const nextKey =
    name && nextLabel ? `plan:${name}:chunk-${nextLabel.toLowerCase()}` : null;
  const isLead = (key?: string) =>
    !!key && (key === handoffKey || key === nextKey);
  const all = openRowsFor(file);
  const handoffs = all
    .filter(
      (r) =>
        !!name &&
        !!r.key &&
        (r.key === handoffKey || r.key.startsWith(`plan:${name}:chunk-`)),
    )
    .sort((a, b) => Number(isLead(b.key)) - Number(isLead(a.key)))
    .slice(0, HANDOFF_LIMIT);
  if (all.length) {
    console.log(`\n## handoff`);
    if (!handoffs.length) console.log("(none)");
    for (const r of handoffs)
      console.log(
        `- ${r.ts.slice(0, 10)} ${r.kind} [${r.id}] ${r.key} ${clip(r.text)}`,
      );
    const rest = all.length - handoffs.length;
    if (rest)
      console.log(
        `(+${rest} open rows about this plan — fael kickoff ${name ? `plan:${name}` : rel(file)})`,
      );
  }
  if (unchecked.length) {
    console.log(`\n## closing`);
    for (const rule of chunkRules(`plan:${name ?? "<name>"}`))
      console.log(`- ${rule}`);
  }
}

function showAll(): void {
  const files = existsSync(planDir)
    ? readdirSync(planDir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => join(planDir, f))
    : [];
  if (!files.length) {
    console.log(`no plans in ${rel(planDir)}/`);
    return;
  }
  const shipped = new Set(shippedNotMoved());
  const active = files
    .filter((f) => !shipped.has(basename(f)))
    .sort(
      (a, b) =>
        Number(isHighPriority(b)) - Number(isHighPriority(a)) ||
        a.localeCompare(b),
    );
  console.log(`# ${rel(planDir)}/ — ${active.length} active plan(s)`);
  for (const f of active) {
    const { checked, unchecked } = readPlanSectionItems(f);
    const fm = parsePlanFrontmatter(f);
    const tags = [
      isHighPriority(f) ? "priority:high" : "",
      fm.status === "blocked" ? `blocked_by: ${fm.blockedByRaw ?? "?"}` : "",
    ].filter(Boolean);
    console.log(
      `\n- ${basename(f)} — ${checked.length}/${checked.length + unchecked.length} chunks${tags.length ? ` · ${tags.join(" · ")}` : ""}`,
    );
    if (unchecked[0]) console.log(`  next: ${clip(unchecked[0])}`);
  }
  if (shipped.size) {
    console.log(`\n## shipped but not archived into done/ (${shipped.size})`);
    for (const n of shipped) console.log(`- ${n}`);
    console.log(`(move: ${planSweepCmd} <file.md> --apply)`);
  }
}

export function cmdPlanNext(a: string[]): void {
  const fi = a.indexOf("--files");
  if (fi >= 0) {
    const files = (a[fi + 1] ?? "").split(",").filter(Boolean);
    if (!files.length) {
      console.error(
        "--files needs a path: fapony plan --files src/x.ts[,src/y.ts]",
      );
      process.exit(1);
    }
    showFiles(files.map((f) => (f.startsWith(root) ? rel(f) : f)));
    return;
  }
  const arg = a.find((x) => !x.startsWith("--"));
  if (!arg) {
    showAll();
    return;
  }
  const r = resolvePlan(arg);
  if (!r.ok) {
    console.error(
      r.candidates.length
        ? `"${arg}" matches ${r.candidates.length} plans — name one:\n${r.candidates.map((c) => `  ${c}`).join("\n")}`
        : `no plan "${arg}" (looked in ${rel(planDir)}/, ${rel(doneDir)}/ and the repo root)`,
    );
    process.exit(1);
  }
  showPlan(r.file, r.chunk);
}
