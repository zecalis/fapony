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
import { misfiledHandoffs, orphanHandoffKeys, pickChunks } from "./parallel.js";
import { mentionsOfFiles, resolvePlan } from "./resolve.js";
import { doneDir, planBase, planDir, rel, root } from "./store.js";
import {
  checkTickedLine,
  chunkLabel,
  DROP_RE,
  firstSectionItems,
  missingFael,
  openRows,
  openRowsFor,
  parsePlanFrontmatter,
  planKeyName,
  planSweepCmd,
  shippedNotMoved,
} from "./sweep.js";

const HANDOFF_LIMIT = 5;
const TEXT_MAX = 200;
const LATER_MAX = 120;
const SPEC_REFS_MAX = 3;
const SPEC_TITLE_MAX = 50;

/** The one copy of the batching + closing rules, printed by `fapony plan
 *  <PLAN>`. A copy baked into each PLAN at seed time drifted (4 variants of the
 *  closing line across 21 active plans), so plan-seed, plan adopt and init only
 *  point here. */
export const chunkRules = (anchor: string): string[] => [
  "batching: one session = one branch = one squash-merged PR, one commit per chunk · add the next chunk only while the PR stays reviewable in one sitting, never past 3 · a chunk gets its own PR when it changes a DB schema/migration or persisted format, touches auth/permissions/security or money logic, changes a public API/CLI contract, or needs a design review · close each chunk fully (tick + handoff note + commit) before the next; stop at anything that needs a human decision · a session starts a fresh branch from origin/main — never push onto a branch whose PR already merged (`gh pr view --json state`) · PR title names the plan and its chunks (`PLAN-x chunk 2–3`) · a chunk that must build on an unmerged branch is stacked (PR base = that branch; once it merges: `git rebase --onto origin/main <lower> <upper>`)",
  `parallel: starting a chunk, append \`(wip <branch>)\` to its TL;DR line — the plan dir is shared, so another worktree's \`fapony plan\` skips it at once · a chunk runs alongside another only when \`fapony plan\` lists it under "can run alongside" (its \`(after <n>)\` / \`(after —)\` is met) and shares no file with the chunk in progress · the planner writes \`(after …)\` on a chunk line only when it truly does not wait on the chunk before it · each parallel chunk: own worktree, own branch, own PR`,
  `closing a step: tick TL;DR with sha and drop its \`(wip …)\` — no commit (a measurement) cites \`(fael:<decision id>)\` instead, a dropped chunk is \`[~]\` + the decision saying why · \`git commit\` files only · \`fael add note "<what the next chunk must know>" --files <f1,f2>,${anchor} --key ${anchor}:handoff\` (one key per plan — fael supersedes the previous note; a chunk run in parallel with another open chunk of this plan, in another worktree, writes \`--key ${anchor}:chunk-<n>\` instead, <n> digits only) · after \`gh pr create\`, append \`(#N)\` to that tick (a squash rewrites the sha, \`(#N)\` survives it)`,
];

/** First-section items with the `- [ ] ` / `- [x] ` / `- [~] ` marker cut
 *  off — `dropped` counts the `[~]` share of `checked`; `lastTick` keeps its
 *  marker, a drop is judged by it. */
const readPlanSectionItems = (
  planPath: string,
): {
  checked: string[];
  unchecked: string[];
  dropped: number;
  unknown: string[];
  lastTick?: string;
} => {
  const strip = (l: string) =>
    l.replace(/^\s*[-*]\s+\[[\sxX~]\]\s+/, "").trim();
  const { checked, unchecked, unknown } = firstSectionItems(planPath);
  return {
    checked: checked.map(strip),
    unchecked: unchecked.map(strip),
    dropped: checked.filter((l) => DROP_RE.test(l)).length,
    unknown: unknown.map((l) => l.trim()),
    lastTick: checked.at(-1),
  };
};

const tally = (s: ReturnType<typeof readPlanSectionItems>): string =>
  `${s.checked.length}/${s.checked.length + s.unchecked.length} chunks${s.dropped ? ` (${s.dropped} dropped)` : ""}`;

// One line saying whether the last ticked chunk actually closed. Verified
// shas stay silent; only the newest ticked chunk is ever mentioned. A tick
// with no label the parser can read is "the last tick", never a made-up one.
const closureHint = (last?: string): string | null => {
  if (!last) return null;
  const { missing, diverged, cited } = checkTickedLine(last, root);
  const label = chunkLabel(last);
  const who = label ? `chunk ${label} is ticked but ` : "last tick: ";
  if (missing[0]?.startsWith("fael:"))
    return `⚠ ${label ? `chunk ${label}: ` : "last tick: "}${missingFael(missing[0])} — nothing proves it closed`;
  if (missing.length)
    return `⚠ ${who}${
      missing[0].startsWith("#")
        ? `(${missing[0]}) names no single default-branch commit`
        : `${missing[0]} is not in git`
    } — nothing proves it closed`;
  // the squash commit exists, only the tick is stale: `--fix` repoints it —
  // unless the PR squashed several commits (no subject/patch match): cite `(#N)`
  if (diverged.length)
    return `⚠ ${who}${diverged[0]} is held by no branch (squashed, branch deleted?) — fix: fapony plan check --fix, or append the merged PR's \`(#N)\` to the tick`;
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

const isOpen = (l: string): boolean => /^\s*[-*]\s+\[\s\]/.test(l);

// The worktree's branch — a `(wip <branch>)` claim naming it is this session's.
const currentBranch = (): string | null => {
  const p = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: root,
    stderr: "ignore",
  });
  const b = p.stdout.toString().trim();
  return p.exitCode === 0 && b && b !== "HEAD" ? b : null;
};

const clip = (s: string, max = TEXT_MAX): string => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

// The plan's `spec:` frontmatter → where it lives, or that it is gone. No
// `spec:` key = a plan without a spec, nothing to say. A spec sits in spec/
// while a plan cites it and moves to done/ with the last one (plan sweep).
const specFile = (
  planPath: string,
): { name: string; file: string | null } | null => {
  const name = parsePlanFrontmatter(planPath).spec;
  if (!name) return null;
  const file = [join(planBase, "spec"), doneDir]
    .map((d) => join(d, name))
    .find(existsSync);
  return { name, file: file ?? null };
};

// `§16` / `§16.2` in the chunk text → where that section sits in the spec:
// `§16 → SPEC-vela.md:339-414 <title>`, so the session reads 75 lines, not 671.
// A section runs from its heading (`## §16 …` or `## 16. …`) to the next heading
// of the same or a higher level; headings inside code fences are not headings.
// A § the spec has no heading for is skipped — never guessed — and so is one
// that another document owns: `ARCHITECTURE §5`, `SPEC-vela-ui §3`. Bare `§5`
// and `SPEC §5` are this spec's.
const specRefs = (file: string, chunk: string): string[] => {
  const mine = [basename(file), basename(file, ".md"), "SPEC"];
  const cited = [
    ...new Set(
      [
        ...chunk.matchAll(
          /(?:\b([A-Z][A-Z0-9]*(?:[-_.]\w+)*)\s*)?§(\d+(?:\.\d+)*)/g,
        ),
      ]
        .filter((m) => !m[1] || mine.includes(m[1]))
        .map((m) => m[2]),
    ),
  ];
  if (!cited.length) return [];
  const lines = readFileSync(file, "utf8").split("\n");
  let fenced = false;
  const heads: { at: number; level: number; text: string }[] = [];
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) fenced = !fenced;
    const m = !fenced && /^(#{1,6})\s+(.+?)\s*$/.exec(l);
    if (m) heads.push({ at: i + 1, level: m[1].length, text: m[2] });
  });
  const refs = cited.flatMap((n) => {
    const num = new RegExp(
      `^§?${n.replace(/\./g, "\\.")}(?!\\d|\\.\\d)[.):]?(?:\\s+|$)`,
    );
    const i = heads.findIndex((h) => num.test(h.text));
    if (i < 0) return [];
    const { at, level, text } = heads[i];
    const nextAt =
      heads.slice(i + 1).find((h) => h.level <= level)?.at ?? lines.length + 1;
    let to = nextAt - 1;
    while (to > at && !lines[to - 1].trim()) to--;
    return [
      `§${n} → ${basename(file)}:${at}-${to} ${clip(text.replace(num, ""), SPEC_TITLE_MAX)}`,
    ];
  });
  return refs.slice(0, SPEC_REFS_MAX);
};

const specLine = (spec: NonNullable<ReturnType<typeof specFile>>): string =>
  spec.file
    ? `spec: ${rel(spec.file)}`
    : `⚠ spec ${spec.name} is named in the frontmatter but not in ${rel(join(planBase, "spec"))}/ or ${rel(doneDir)}/`;

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
  const items = readPlanSectionItems(file);
  const { unchecked } = items;
  console.log(`# ${readPlanTitle(file) || basename(file)} — ${rel(file)}`);
  const spec = specFile(file);
  if (spec) console.log(specLine(spec));
  // `plan:x:chunk-<label>` picks that chunk as "next"; else the picker: the
  // first open chunk no other worktree claimed whose `(after …)` is met.
  const { ordered } = firstSectionItems(file);
  const pick = pickChunks(ordered, currentBranch());
  const openLines = ordered.filter(isOpen);
  const toAt = (i: number) => (i < 0 ? -1 : openLines.indexOf(ordered[i]));
  const at = chunk
    ? Math.max(
        unchecked.findIndex(
          (c) => chunkLabel(c)?.toLowerCase() === chunk.toLowerCase(),
        ),
        0,
      )
    : toAt(pick.next);
  if (spec?.file && unchecked[at])
    for (const ref of specRefs(spec.file, unchecked[at])) console.log(ref);
  if (unchecked.length) {
    const name = planKeyName(file) ?? "<name>";
    const elsewhere = chunk ? [] : pick.wip.map((w) => toAt(w.at));
    const alongside = chunk ? [] : pick.alongside;
    if (at >= 0) console.log(`\n## next\n- [ ] ${unchecked[at]}`);
    else
      console.log(
        `\n## next\n(none ready — ${pick.wip.length ? `${pick.wip.length} chunk(s) claimed by another worktree; ` : ""}the first open chunk waits on ${pick.waitsOn.map((l) => `chunk ${l}`).join(", ") || "an open chunk"})`,
      );
    if (elsewhere.length) {
      console.log(`\n## in progress in another worktree`);
      for (const [i, w] of pick.wip.entries())
        console.log(`- ${headline(unchecked[elsewhere[i]])} — ${w.branch}`);
    }
    if (alongside.length) {
      console.log(
        `\n## can run alongside (another worktree: \`fapony plan plan:${name}:chunk-<label>\`)`,
      );
      for (const a of alongside)
        console.log(
          `- ${headline(unchecked[toAt(a.at)])}${a.shared.length ? ` — ⚠ shares ${a.shared.join(", ")} with a chunk in progress: run it after, not alongside` : ""}`,
        );
    }
    const shown = new Set([
      at,
      ...elsewhere,
      ...alongside.map((a) => toAt(a.at)),
    ]);
    const later = unchecked.filter((_, i) => !shown.has(i));
    if (later.length) {
      console.log(`\n## later (${later.length})`);
      for (const c of later) console.log(`- ${headline(c)}`);
    }
  } else {
    console.log(
      `\n(all chunks closed: ${tally(items)} — ready to ship or archive)`,
    );
  }
  const hint = closureHint(items.lastTick);
  if (hint) console.log(hint);
  for (const l of items.unknown)
    console.log(
      `⚠ unknown checkbox, not counted: ${clip(l)} — use [ ], [x] or [~] (dropped)`,
    );

  // Handoff = the rows the session opening the next chunk came for:
  // `plan:<name>:handoff` (one key per plan, fael keeps only the newest open)
  // or a legacy `plan:<name>:chunk-<label>`. The next chunk's legacy row leads;
  // stable sort keeps newest-first. Every other open row about the plan is only
  // counted — `fael kickoff` owns that list.
  const name = planKeyName(file);
  const nextLabel = at >= 0 && unchecked[at] ? chunkLabel(unchecked[at]) : null;
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
  if (name)
    for (const r of misfiledHandoffs(openRows(), name))
      console.log(
        `⚠ handoff under a key fapony plan never reads: [${r.id}] ${r.key} — re-file it: fael add note "<text>" --files <f>,plan:${name} --key plan:${name}:${r.key?.split(":").pop()} --supersedes ${r.id}`,
      );
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
  const branch = currentBranch();
  for (const f of active) {
    const items = readPlanSectionItems(f);
    const { unchecked } = items;
    const fm = parsePlanFrontmatter(f);
    const tags = [
      isHighPriority(f) ? "priority:high" : "",
      fm.status === "blocked" ? `blocked_by: ${fm.blockedByRaw ?? "?"}` : "",
    ].filter(Boolean);
    console.log(
      `\n- ${basename(f)} — ${tally(items)}${items.unknown.length ? ` · ⚠ ${items.unknown.length} unknown checkbox(es)` : ""}${tags.length ? ` · ${tags.join(" · ")}` : ""}`,
    );
    const { ordered } = firstSectionItems(f);
    const pick = pickChunks(ordered, branch);
    if (pick.wip.length)
      console.log(
        `  in progress elsewhere: ${pick.wip.map((w) => `${chunkLabel(ordered[w.at]) ?? "?"} (${w.branch})`).join(", ")}`,
      );
    if (pick.next >= 0)
      console.log(
        `  next: ${clip(ordered[pick.next].replace(/^\s*[-*]\s+\[\s\]\s+/, ""))}`,
      );
    else if (unchecked[0])
      console.log(
        `  next: none ready — waits on ${pick.waitsOn.map((l) => `chunk ${l}`).join(", ") || "a claimed chunk"}`,
      );
  }
  // A handoff key that names no plan is a note no `fapony plan` will show.
  const names = [planDir, doneDir].flatMap((d) =>
    existsSync(d) ? readdirSync(d).flatMap((n) => planKeyName(n) ?? []) : [],
  );
  const orphans = orphanHandoffKeys(openRows(), names);
  if (orphans.length)
    console.log(
      `\n⚠ ${orphans.length} open handoff key(s) name no plan in ${rel(planDir)}/ or ${rel(doneDir)}/: ${orphans.slice(0, 5).join(", ")} — re-file under plan:<name>:handoff (--supersedes <id>)`,
    );
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
