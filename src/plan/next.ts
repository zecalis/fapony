// src/plan/next.ts — `fapony plan [<PLAN.md>]`: where a plan stands.
//
// Replaces the plan half of `fapony mem kickoff` (memory moved to fael):
//   no arg    → every active plan: progress, first unchecked chunk, priority
//               high first, blocked marked; plus shipped-but-not-archived
//   <PLAN.md> → its unchecked chunks, whether the last ticked chunk's sha
//               verifies, and the open fael rows about it (the chunk handoff
//               notes — `fael add note … --files <f>,plan:<name>
//               --key plan:<name>:chunk-<n>`), the next chunk's rows first

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { doneDir, planDir, rel, root } from "./store.js";
import {
  checkTickedLine,
  openRowsFor,
  parsePlanFrontmatter,
  planKeyName,
  planSweepCmd,
  shippedNotMoved,
} from "./sweep.js";

const HANDOFF_LIMIT = 5;
const TEXT_MAX = 200;

/** Checked + unchecked items of the first `##` section (the TL;DR). */
const readPlanSectionItems = (
  planPath: string,
): { checked: string[]; unchecked: string[] } => {
  try {
    const body = readFileSync(planPath, "utf8").replace(
      /^---\r?\n[\s\S]*?\r?\n---/,
      "",
    );
    const start = body.search(/^##\s+/m);
    if (start < 0) return { checked: [], unchecked: [] };
    const rest = body.slice(start);
    const next = rest.slice(3).search(/^##\s+/m);
    const block = next < 0 ? rest : rest.slice(0, next + 3);
    const checked: string[] = [];
    const unchecked: string[] = [];
    for (const line of block.split("\n")) {
      let m = /^\s*[-*]\s+\[\s\]\s+(.+)$/.exec(line);
      if (m) {
        unchecked.push(m[1].trim());
        continue;
      }
      m = /^\s*[-*]\s+\[[xX]\]\s+(.+)$/.exec(line);
      if (m) checked.push(m[1].trim());
    }
    return { checked, unchecked };
  } catch {
    return { checked: [], unchecked: [] };
  }
};

// One line saying whether the last ticked chunk actually closed. Verified
// shas stay silent; only the newest ticked chunk is ever mentioned.
const closureHint = (checked: string[]): string | null => {
  const last = checked[checked.length - 1];
  if (!last) return null;
  const { missing, diverged, cited } = checkTickedLine(last, root);
  const label = chunkLabel(last) ?? "latest";
  if (missing.length)
    return `⚠ chunk ${label} is ticked but ${missing[0]} is not in git — nothing proves it closed`;
  if (diverged.length)
    return `⚠ chunk ${label} is ticked but ${diverged[0]} is held by no branch (squashed, branch deleted?)`;
  if (!cited)
    return `⚠ chunk ${label} is ticked but cites no commit — nothing to verify it closed`;
  return null;
};

/** "chunk 2 — …" / "**chunk 2** — …" / "chunk-2" → "2"; the number a
 *  `plan:<name>:chunk-<n>` key carries. Digits only, so markdown around the
 *  label (`**`, `_`) never leaks into the key. */
const chunkLabel = (item: string): string | null =>
  /\bchunk[\s-]*(\d+)/i.exec(item)?.[1] ?? null;

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
    return !!m && /^\s*priority\s*:\s*high\s*$/m.test(m[1]);
  } catch {
    return false;
  }
};

const clip = (s: string): string => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > TEXT_MAX ? `${flat.slice(0, TEXT_MAX - 1)}…` : flat;
};

/** A plan arg as typed (bare name, with/without .md, or a path) → the file. */
const findPlan = (arg: string): string | null => {
  const name = arg.endsWith(".md") ? basename(arg) : `${basename(arg)}.md`;
  return (
    [arg, join(root, arg), join(planDir, name), join(doneDir, name)].find(
      (p) => p.endsWith(".md") && existsSync(p),
    ) ?? null
  );
};

function showPlan(file: string): void {
  const { checked, unchecked } = readPlanSectionItems(file);
  console.log(`# ${readPlanTitle(file) || basename(file)} — ${rel(file)}`);
  if (unchecked.length) {
    console.log(`\n## unchecked`);
    for (const c of unchecked) console.log(`- [ ] ${c}`);
  } else {
    console.log(`\n(all chunks checked — ready to ship or archive)`);
  }
  const hint = closureHint(checked);
  if (hint) console.log(hint);

  // Rows keyed to the first unchecked chunk lead — they are the handoff
  // the session opening that chunk came for. Stable sort keeps newest-first.
  const name = planKeyName(file);
  const next = unchecked[0] ? chunkLabel(unchecked[0]) : null;
  const nextKey = name && next ? `plan:${name}:chunk-${next}` : null;
  const rows = openRowsFor(file)
    .map((r, i) => ({ r, i, lead: !!nextKey && r.key === nextKey }))
    .sort((a, b) => Number(b.lead) - Number(a.lead) || a.i - b.i)
    .map(({ r }) => r);
  if (rows.length) {
    console.log(`\n## open in fael (${rows.length})`);
    for (const r of rows.slice(0, HANDOFF_LIMIT))
      console.log(
        `- ${r.ts.slice(0, 10)} ${r.kind} [${r.id}]${r.key ? ` ${r.key}` : ""} ${clip(r.text)}`,
      );
    if (rows.length > HANDOFF_LIMIT)
      console.log(
        // --files plan:<name> misses rows carrying only the chunk key on a
        // code file, so an anchored plan names both calls
        `… +${rows.length - HANDOFF_LIMIT} more — ${
          name
            ? `fael find --files plan:${name} · fael find --key 'plan:${name}:*'`
            : `fael find --files ${rel(file)}`
        }`,
      );
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
  const arg = a.find((x) => !x.startsWith("--"));
  if (!arg) {
    showAll();
    return;
  }
  const file = findPlan(arg);
  if (!file) {
    console.error(
      `no plan "${arg}" (looked in ${rel(planDir)}/, ${rel(doneDir)}/ and the repo root)`,
    );
    process.exit(1);
  }
  showPlan(file);
}
