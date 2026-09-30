// src/seed/plan-seed.ts — `fapony plan-seed <name> [--spec] [--scope <path>[,<path>]]...`
//
// Writes PLAN + SPEC straight into planDir/specDir. What it pre-fills is the
// structure (frontmatter, the 8 sections, prior art, ledger context) — the
// agent is left with judgment only.
//
// **§2/§5 no longer carry seeded facts (2026-09-18).** They held a repetition
// scan and analyze findings; measured across every plan that ever used them,
// §5 printed "no findings" 3 times out of 3 and §2 printed a naming
// observation nobody cited. The cause is structural: `--scope` narrows to the
// files about to change, while both producers report whole-repo properties
// (hub/orphan/cycle across directories) — empty when scoped, noisy when not.
// Worse, a judgment heading pre-filled with a shrug teaches the reader that
// every seeded line is noise. Facts now come from `fapony analyze <dir>` and
// `review-seed --files` run at draft time on the real scope, where they do not
// go stale. Do not re-add a producer here without measuring that its output is
// cited in a shipped plan.
//
// SPEC chunks are hard-capped review-seed style — PLAN ≤ ~60 and SPEC ≤ 200
// lines are the contract (PLAN-seed-scope-and-cap §3, measured against an
// 18,175-line SPEC innominix deleted by hand).
// init-family: writes only the files the user asked for, inside planDir/
// specDir — never runtime state (that stays in ~/.config/fapony/).
// Deterministic: same input, same output, no LLM call.
//
// Composes existing producers — no new parsing, no new table, no MCP tool.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import {
  collectSourceFiles,
  EXPORT_EXTS,
  isSkippedDir,
} from "../analyze/index.js";
import {
  CONFIG_FILENAME,
  type Config,
  doneDir,
  loadConfig,
  planDir,
  specDir,
} from "../core/config.js";
import { readFaelLog, recentDecisions } from "../fael.js";
import { extractExports } from "../map.js";
import { findMentions } from "../plan/resolve.js";
import { capLines, execGit, SIG_MAX } from "./primitives.js";

// One chunk = one module's signatures — past ~40 lines a module is its own
// reading task, and the whole-SPEC cap below does the final trim.
const MAX_CHUNK_LINES = 40;
// The whole-SPEC contract (§3.1): whatever the scope, the file stays ≤ 200.
const MAX_SPEC_LINES = 200;
// Above this many files in scope the caps start eating output silently —
// warn so the shortness is explained. (guess — first cutoff that felt right)
const SCOPE_WARN_FILES = 300;
// Shipped plans/specs that already touched this scope. Capped low on purpose:
// this is a "go read that first" pointer, not a bibliography.
const MAX_PRIOR_ART = 5;
// Mem-row text budget in the Known traps block.
const MEM_TEXT_MAX = 120;
// Chunk 4 (PLAN-seed-and-surface): the PLAN names what is already in scope —
// one line per scope file with its export names. SPEC-only seeds never gave
// PLAN-only readers this pointer, so agents re-derived what export-lines.ts
// already knew. Capped low: a pointer, not a signature dump.
const MAX_EXISTING_IN_SCOPE = 15;
// The PLAN ≤ ~60 contract (§3.1) predates this block — the block yields to it,
// never grows it. Effective block cap = min(block cap, remaining budget).
const MAX_PLAN_LINES = 60;
// Anchor-safe slug: lowercase, non-alphanumerics → dash.
const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

// Absolute source files under a scope root. A single-file scope counts as
// itself — collectSourceFiles only walks dirs, so a file root would vanish.
function scopeSourceFiles(root: string): string[] {
  let st: import("node:fs").Stats;
  try {
    st = statSync(root);
  } catch {
    return [];
  }
  if (!st.isDirectory()) {
    return isSourceFile(st, basename(root)) ? [root] : [];
  }
  return collectSourceFiles(root, { skipHidden: true, exts: EXPORT_EXTS }).map(
    (rel) => join(root, rel),
  );
}

// The overwrite check catches a filename collision. It does not catch the
// expensive mistake: planning again what a shipped plan already decided —
// PLAN-cost-per-pass froze the tokens/pass formula, and a later seed over
// src/stats gave no hint it existed. Scope paths are the join key: a shipped
// plan that names this directory decided something about the code this seed
// is about to plan. Headers only (title + shipped date) — pulling the bodies
// in would recreate the reading task the plan exists to avoid.
function renderPriorArt(cwd: string, config: Config, roots: string[]): string {
  const placeholder = "- _(agent fills in)_";
  const keys = roots
    .map((r) => relative(cwd, r))
    .filter((r) => r !== "" && r !== ".");
  // No --scope means every shipped plan matches — a list of everything points
  // at nothing.
  if (keys.length === 0) return placeholder;

  const hits = findMentions(
    [doneDir(config), specDir()].map((dir) => ({
      abs: join(cwd, dir),
      label: dir.split("/").pop() ?? dir,
    })),
    keys,
  ).map((h) => ({
    shipped: h.shipped,
    line: `- ✅ Already decided: [${h.name}](../${h.label}/${h.name}) — ${h.title}${h.shipped ? ` (shipped ${h.shipped})` : ""} \`(fapony plan-seed)\``,
  }));
  if (hits.length === 0) return placeholder;
  // Newest decision first — alphabetical order cuts by filename, which is the
  // one thing that says nothing about whether the decision still binds.
  // Undated (specs, unshipped) sort last rather than disappearing.
  hits.sort((a, b) =>
    a.shipped < b.shipped ? 1 : a.shipped > b.shipped ? -1 : 0,
  );
  const shown = hits.slice(0, MAX_PRIOR_ART).map((h) => h.line);
  if (hits.length > MAX_PRIOR_ART) {
    shown.push(
      `- … +${hits.length - MAX_PRIOR_ART} more touching the same scope`,
    );
  }
  shown.push(placeholder);
  return shown.join("\n");
}

// Chunk 5 (PLAN-seed-and-surface): stdout ends with the plans that already
// exist — the seed that lands next to a shipped decision without knowing it
// is the expensive mistake (§8 prior art guards the file, this guards the
// glance). Active plans first (the ones a new seed must not duplicate),
// then shipped; capped like every other list here.
const MAX_PLAN_LIST = 10;

function listExistingPlans(
  cwd: string,
  config: Config,
  exclude: string,
): string[] {
  const items: string[] = [];
  for (const [dir, where] of [
    [planDir(), "plan"],
    [doneDir(config), "done"],
  ] as const) {
    let names: string[];
    try {
      names = readdirSync(join(cwd, dir))
        .filter((n) => n.endsWith(".md"))
        .sort();
    } catch {
      continue; // dir missing — nothing seeded yet
    }
    for (const n of names) {
      if (n === exclude) continue; // the file just written, not "existing"
      items.push(`- ${n} (${where})`);
    }
  }
  if (items.length === 0) return ["- (none yet)"];
  return capLines(items, MAX_PLAN_LIST, "plans");
}

// --- Context (fapony): mem decisions + existing in scope ---
//
// No ledger-ranking line here (PLAN-seed-and-surface chunk 6): the ledger is
// frozen and Positioning rule 2 forbids cross-model ranking claims, so a
// seeded pointer at it teaches the reader to cite what cannot be cited.
// computeModelFit() itself stays — `fapony stats` reads it.

// One line per scope file naming its exports — `src/debt/scan.ts —
// scanDebt() · DebtHit`. Files with no exports (or unreadable) are skipped:
// a pointer lists what is there, not what is not. Sorted for determinism.
function renderExistingInScope(
  roots: string[],
  cwd: string,
  scoped: boolean,
  cap: number,
): string[] {
  // No --scope means every file in the repo matches — a list of everything
  // points at nothing (§8 prior art goes quiet for the same reason).
  if (!scoped)
    return ["- _(no --scope — re-seed with --scope <dir> to list exports)_"];
  const abs: string[] = [];
  for (const r of roots) for (const f of scopeSourceFiles(r)) abs.push(f);
  const rels = [...new Set(abs.map((f) => relative(cwd, f) || "."))].sort();
  const lines: string[] = [];
  for (const rel of rels) {
    let source: string;
    try {
      source = readFileSync(join(cwd, rel), "utf-8");
    } catch {
      continue;
    }
    const scan = extractExports(source, undefined, rel);
    if (scan.error || scan.symbols.length === 0) continue;
    // Re-export-only files scan as one `*` per line — dedupe to a single `*`.
    const names = [
      ...new Set(
        scan.symbols.map((s) => (s.kind === "fn" ? `${s.name}()` : s.name)),
      ),
    ];
    lines.push(`- ${rel} — ${names.join(" · ")}`);
  }
  if (lines.length === 0) return ["- _(no exports in scope)_"];
  return capLines(lines, cap, "files in scope (narrow with --scope <path>)");
}

function renderContextFapony(worktree: string): string {
  const lines: string[] = [];
  const decisions = recentDecisions(
    readFaelLog(worktree, undefined, true).rows,
    3,
  );
  lines.push(
    decisions.length > 0
      ? `- Decisions on record (mem): ${decisions
          .map(
            (d) =>
              `"${d.text.length > 140 ? `${d.text.slice(0, 139)}…` : d.text}"`,
          )
          .join(" · ")}`
      : "- Decisions on record (mem): _(none — no fael log or empty)_",
  );
  return lines.join("\n");
}

// --- PLAN barrel ---

function planTemplate(
  name: string,
  priorArt: string,
  contextFapony: string,
  existingScope: string[],
  specLink: string | null,
): string {
  return `---
kind: unit
status: active
---

# PLAN-${name} — (agent fills in a title)

> **Status:** 🚧 in-progress · **Created:** (agent fills in the date)

## TL;DR
- **What:** (agent fills in) · **Why:** (agent fills in) · **Done when:** (agent fills in)
- **Order:** (agent fills in)
- **Progress:**
  - [ ] chunk 1 — (agent fills in)

## Context (fapony)
${contextFapony}
### Existing in scope
${existingScope.join("\n")}

## 1. Goal (why)
_(agent fills in)_

## 2. Scope (do / don't do)
_(agent fills in)_

## 3. Done criteria (how we know it's finished)
_(agent fills in — must be verifiable)_

## 4. Constraints / Hard rules (must not violate)
_(agent fills in)_

## 5. Risks & Escape hatches (if it fails)
_(agent fills in)_

## 6. Steps (what in which order)
**Chunks → sessions → PRs, closing a step:** \`fapony plan PLAN-${name}.md\` prints the batching rule and how to close a chunk — the single source, nothing to copy here.

1. _(agent fills in — each step must be verifiable)_

- [ ] handoff: the mem note is the handoff — this box only opts the plan into the Stop-hook check

## 7. Examples
${
  specLink
    ? `→ ${specLink}  (signatures live in the spec, not the plan)`
    : "_(agent fills in — or add a SPEC with plan-seed --spec)_"
}

## 8. References
${priorArt}

## Context (agent)
_(empty slot — the agent dumps its own graph/code-summary)_
`;
}

// --- SPEC chunked (--spec) ---
// One chunk per module (top-level dir, recursed), verbatim declaration
// signatures per file inside — the exact thing plan §7 must not hold.

interface Chunk {
  slug: string;
  title: string;
  body: string;
}

function capChunk(c: Chunk): Chunk {
  return {
    ...c,
    body: capLines(
      c.body.split("\n"),
      MAX_CHUNK_LINES,
      "signatures (narrow with --scope <path>)",
    ).join("\n"),
  };
}

function fileLines(absFile: string): string[] {
  let source: string;
  try {
    source = readFileSync(absFile, "utf-8");
  } catch {
    return ["_(unreadable)_"];
  }
  const scan = extractExports(source, undefined, absFile);
  if (scan.error) return [`⚠ ${scan.error} — symbols not extractable`];
  if (scan.symbols.length === 0) return ["_(no exports)_"];
  let srcLines: string[] = [];
  try {
    srcLines = source.split("\n");
  } catch {
    // fall through to name-only below
  }
  return scan.symbols.map((s) => {
    const raw = srcLines[s.line - 1]?.trim() ?? "";
    const sig = raw.length > SIG_MAX ? `${raw.slice(0, SIG_MAX - 1)}…` : raw;
    return `  - \`${s.line}\`  ${s.kind}  ${sig || s.name}`;
  });
}

function isSourceFile(st: { isDirectory(): boolean }, name: string): boolean {
  return (
    !st.isDirectory() && EXPORT_EXTS.has(name.slice(name.lastIndexOf(".")))
  );
}

function moduleChunkFiles(absDir: string, entries: string[]): string[] {
  const lines: string[] = [];
  for (const name of entries) {
    const child = join(absDir, name);
    let st: import("node:fs").Stats;
    try {
      st = statSync(child);
    } catch {
      continue;
    }
    if (isSourceFile(st, name)) {
      lines.push(`### ${name}`, "", ...fileLines(child), "");
    }
  }
  return lines;
}

function moduleChunk(absDir: string, rel: string): Chunk | null {
  let entries: string[];
  try {
    entries = readdirSync(absDir, { withFileTypes: true })
      .filter(
        (e) =>
          !e.isSymbolicLink() &&
          !e.name.startsWith(".") &&
          !isSkippedDir(e.name, absDir),
      )
      .map((e) => e.name)
      .sort();
  } catch {
    return null;
  }
  const lines: string[] = moduleChunkFiles(absDir, entries);
  for (const name of entries) {
    const child = join(absDir, name);
    let st: import("node:fs").Stats;
    try {
      st = statSync(child);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const nested = moduleChunk(child, `${rel}/${name}`);
    if (nested) lines.push(`**${name}/**`, "", nested.body, "");
  }
  if (lines.length === 0) return null;
  return { slug: slug(rel), title: rel, body: lines.join("\n").trimEnd() };
}

// One scope root = root files first, then one chunk per top-level dir. When the
// root is a single file, produce one chunk for it (readdirSync on a file throws,
// so handle it before the dir walk).
function rootChunks(absDir: string): Chunk[] {
  const chunks: Chunk[] = [];
  let st: import("node:fs").Stats;
  try {
    st = statSync(absDir);
  } catch {
    return chunks;
  }
  if (!st.isDirectory()) {
    // Single-file scope: one chunk, the file's own signatures.
    const name = basename(absDir);
    if (!isSourceFile(st, name)) return chunks;
    const lines = fileLines(absDir);
    if (lines.length === 0) return chunks;
    return [
      capChunk({
        slug: slug(name),
        title: name,
        body: lines.join("\n"),
      }),
    ];
  }
  let entries: string[] = [];
  try {
    entries = readdirSync(absDir, { withFileTypes: true })
      .filter(
        (e) =>
          !e.isSymbolicLink() &&
          !e.name.startsWith(".") &&
          !isSkippedDir(e.name, absDir),
      )
      .map((e) => e.name)
      .sort();
  } catch {
    return chunks;
  }
  const rootLines = moduleChunkFiles(absDir, entries);
  if (rootLines.length > 0) {
    chunks.push(
      capChunk({
        slug: "root",
        title: "(root files)",
        body: rootLines.join("\n").trimEnd(),
      }),
    );
  }
  for (const name of entries) {
    const child = join(absDir, name);
    let st: import("node:fs").Stats;
    try {
      st = statSync(child);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const c = moduleChunk(child, name);
    if (c) chunks.push(capChunk(c));
  }
  return chunks;
}

// Chunk titles/slugs are unique per scope root — with more than one root,
// prefix them so "src" from two different scopes doesn't collide.
function buildChunks(roots: string[], cwd: string): Chunk[] {
  const chunks: Chunk[] = [];
  const multi = roots.length > 1;
  for (const root of roots) {
    const rel = relative(cwd, root) || ".";
    for (const c of rootChunks(root)) {
      chunks.push(
        multi
          ? {
              slug: slug(`${rel}-${c.slug}`),
              title:
                c.title === "(root files)"
                  ? `${rel}/ (root files)`
                  : `${rel}/${c.title}`,
              body: c.body,
            }
          : c,
      );
    }
  }
  return chunks;
}

function specTemplate(
  name: string,
  chunks: Chunk[],
  scopeEcho: string | null,
  traps: string[],
): string {
  const index = chunks.map((c) => `- [${c.title}](#${c.slug})`).join("\n");
  // The index is one string with a newline per chunk; budgeting it as one line
  // undershot the cap by that many lines (the 18k-SPEC failure mode). Cap the
  // index separately so the body's capLines has a bounded head to work with.
  const fixedHead = [
    `# SPEC-${name} — (agent fills in a title)`,
    "",
    `> **Used by:** PLAN-${name} — signatures below come from a live source scan — re-seed after structural changes.`,
    ...(scopeEcho ? [`> **Scope:** ${scopeEcho}`] : []),
    "",
    "## Chunk index",
    "",
  ];
  const indexLines = index
    ? index.split("\n")
    : ["_(no chunks — no source files found)_"];
  const budgetIndex = Math.max(MAX_SPEC_LINES - fixedHead.length - 1, 0);
  const cappedIndex = capLines(
    indexLines,
    budgetIndex,
    "chunks (narrow with --scope <path>)",
  );
  const head = [...fixedHead, ...cappedIndex, ""];
  const tail = [
    "## (agent fills in — wireframes / edge cases / API shapes the plan references)",
  ];
  const bodyLines = [
    // Known traps sit after the index, before the first chunk body — budgeted
    // with the bodies so the whole-SPEC cap still cuts from the tail and the
    // count line above survives (a silent section would teach skipping it).
    ...(traps.length > 0 ? [...traps, ""] : []),
    ...chunks.flatMap((c) => [
      `## <a id="${c.slug}"></a>${c.title}`,
      "",
      ...c.body.split("\n"),
      "",
    ]),
  ];
  // Whole-file cap runs last and the agent section survives it, same way
  // review-seed reserves its disclaimer: reserve the tail, cut the middle,
  // say how much was dropped.
  const budget = Math.max(MAX_SPEC_LINES - head.length - tail.length, 0);
  const cappedBody = capLines(
    bodyLines,
    budget,
    "lines (narrow with --scope <path>)",
  );
  return `${[...head, ...cappedBody, ...tail].join("\n")}\n`;
}

// --- Known traps (PLAN-active-pain chunk 2): mem rows on this scope ---
//
// The one place a seed is allowed to be opinionated: past pain about exactly
// these files. bug rows first, then decision (note carries no "this hurt"
// signal), newest first within a kind. Match mirrors fael find: files[] first;
// the text/spec fallback runs ONLY for rows with no files[] at all — a row
// that named files already spoke, its text may quote any path.
//
// Measured base rate on this repo before building (rule 2, 2026-09-23):
// 248 rows total; scope src/seed → 5 matched (3 bug/2 decision, 0 lacked) ·
// src/mem → 12 (4/8, 0) · src/adapters/hooks → 6 (2/4, 0) · whole repo → 61
// (20/41, 0). The "M lacked files[]" fallback layer fired 0/4 scopes here —
// kept because a pre-files[] repo (vela's 2,672 rows) depends on it.
const MAX_TRAP_ROWS = 5;

interface TrapHit {
  row: {
    ts: string;
    kind: string;
    text: string;
    files?: string[];
    spec?: string;
  };
  /** First in-scope file[] entry that matched — null for the text fallback. */
  file: string | null;
  viaText: boolean;
}

export function renderKnownTraps(
  worktree: string,
  cwd: string,
  roots: string[],
  scoped: boolean,
): { lines: string[]; matched: number; lacked: number } {
  const empty = { lines: [], matched: 0, lacked: 0 };
  try {
    const { rows } = readFaelLog(worktree, undefined, true);
    if (rows.length === 0) return empty;

    const scopeFiles = new Set<string>();
    for (const r of roots)
      for (const f of scopeSourceFiles(r)) scopeFiles.add(relative(cwd, f));
    if (scopeFiles.size === 0) return empty;
    const scopeKeys = roots
      .map((r) => relative(cwd, r))
      .filter((k) => k !== "" && k !== ".");

    const hits: TrapHit[] = [];
    for (const row of rows) {
      if (row.kind !== "bug" && row.kind !== "decision") continue;
      const files = row.files ?? [];
      const inScope = files.find((f) => scopeFiles.has(f));
      if (inScope) {
        hits.push({ row, file: inScope, viaText: false });
        continue;
      }
      // Fallback: only a row with NO files[] — see comment above.
      if (files.length === 0 && scoped) {
        const hay = `${row.text}\n${row.spec ?? ""}`;
        if (scopeKeys.some((k) => hay.includes(k))) {
          hits.push({ row, file: null, viaText: true });
        }
      }
    }
    if (hits.length === 0) return empty;

    // Stable sort: bug before decision, recency preserved inside each kind.
    hits.sort((a, b) =>
      a.row.kind === b.row.kind ? 0 : a.row.kind === "bug" ? -1 : 1,
    );
    const lacked = hits.filter((h) => h.viaText).length;
    const lines = [
      "## Known traps (fael)",
      "",
      `- ${hits.length} relevant row(s) on this scope (${lacked} lacked files[]${lacked > 0 ? " — matched via text" : ""})`,
    ];
    for (const h of hits.slice(0, MAX_TRAP_ROWS)) {
      const text =
        h.row.text.length > MEM_TEXT_MAX
          ? `${h.row.text.slice(0, MEM_TEXT_MAX - 1)}…`
          : h.row.text;
      lines.push(
        `- ${h.row.ts.slice(0, 10)} ${h.row.kind} — ${text}${h.file ? ` (${h.file})` : ""}`,
      );
    }
    if (hits.length > MAX_TRAP_ROWS) {
      lines.push(
        `- … +${hits.length - MAX_TRAP_ROWS} more at cap ${MAX_TRAP_ROWS} (bug first, then decision)`,
      );
    }
    return { lines, matched: hits.length, lacked };
  } catch {
    return empty; // no mem log / unreadable = a seed with no traps, never an error
  }
}

// --- CLI entry ---

export function cmdPlanSeed(args: string[]): void {
  const usage =
    "usage: fapony plan-seed <name> [--spec] [--scope <path>[,<path>]]...";
  // Positional parse, not args.find(!startsWith("--")) — a --scope VALUE is
  // a non-flag argument and must never be mistaken for the plan name.
  let name: string | undefined;
  let withSpec = false;
  const scopeArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--spec") {
      withSpec = true;
    } else if (a === "--scope") {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) {
        console.error(`plan-seed: --scope needs a path\n${usage}`);
        process.exit(1);
      }
      // Agents expect `--scope a,b,c` — same comma shape as `--files` — so a
      // comma list is split here instead of failing on a path that never is.
      // A real repo dir can't contain a literal ",x" tail; any comma splits.
      // Trim each segment too: `a, b` is the same habit as `a,b`, and the
      // space must not become part of the path (PLAN-comma-x).
      const syms = v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (syms.length === 0) {
        console.error(`plan-seed: --scope needs a path\n${usage}`);
        process.exit(1);
      }
      scopeArgs.push(...syms);
      i++;
    } else if (a.startsWith("--")) {
      console.error(`plan-seed: unknown flag "${a}"\n${usage}`);
      process.exit(1);
    } else if (name === undefined) {
      name = a;
    }
  }
  if (!name) {
    console.error(usage);
    process.exit(1);
  }
  const cwd = process.cwd();
  const config = loadConfig(join(cwd, CONFIG_FILENAME));
  // Resolve the git worktree root so mem/ledger queries hit the same key
  // state.db uses (git rev-parse --show-toplevel). Running from a subdir
  // would otherwise mismatch: stats return empty, Context (fapony) always
  // prints "(not enough graded history yet)".
  const root = execGit("git rev-parse --show-toplevel", cwd);
  const worktree = root.ok ? root.output.split("\n")[0] : cwd;

  // Scope: explicit paths win; default is the cwd. Resolved absolutes,
  // deduped — the same path twice is one scope. Nested roots are pruned:
  // --scope src --scope src/utils would double-count files in src/utils.
  const requested = [...new Set(scopeArgs.map((s) => resolve(cwd, s)))];
  // Sort by path length (shortest first) so a parent always comes before its
  // children; then drop any root whose ancestor is already in the list.
  requested.sort((a, b) => a.length - b.length);
  const roots: string[] = [];
  for (const r of requested) {
    if (roots.some((accepted) => r.startsWith(`${accepted}${sep}`))) continue;
    roots.push(r);
  }
  for (const r of roots) {
    if (!existsSync(r)) {
      console.error(`plan-seed: scope not found: ${r}`);
      process.exit(1);
    }
  }
  if (roots.length === 0) roots.push(resolve(cwd, "."));
  // Past a few hundred files the SPEC caps start eating output — say why it
  // looks short instead of letting the seed silently truncate. 300 is a guess.
  let totalFiles = 0;
  for (const r of roots) totalFiles += scopeSourceFiles(r).length;
  if (totalFiles > SCOPE_WARN_FILES) {
    console.error(
      `plan-seed: ${totalFiles} source files in scope (> ${SCOPE_WARN_FILES}) — output is capped; narrow with --scope <path>`,
    );
  }

  const planDirAbs = join(cwd, planDir());
  const planPath = join(planDirAbs, `PLAN-${name}.md`);
  if (existsSync(planPath)) {
    console.error(
      `${planPath} already exists — not overwriting. Use a new name, e.g. PLAN-${name}-v2`,
    );
    process.exit(1);
  }

  const priorArt = renderPriorArt(cwd, config, roots);
  const contextFapony = renderContextFapony(worktree);
  const scoped = requested.length > 0;
  // First pass at the block cap — the total-cap check below may shrink it.
  let existingScope = renderExistingInScope(
    roots,
    cwd,
    scoped,
    MAX_EXISTING_IN_SCOPE,
  );

  let specLink: string | null = null;
  let traps = { lines: [] as string[], matched: 0, lacked: 0 };
  if (withSpec) {
    const specDirAbs = join(cwd, specDir());
    const specPath = join(specDirAbs, `SPEC-${name}.md`);
    if (existsSync(specPath)) {
      console.error(
        `${specPath} already exists — not overwriting. Use a new name, e.g. SPEC-${name}-v2`,
      );
      process.exit(1);
    }
    traps = renderKnownTraps(worktree, cwd, roots, scoped);
    const chunks = buildChunks(roots, cwd);
    mkdirSync(specDirAbs, { recursive: true });
    writeFileSync(
      specPath,
      specTemplate(
        name,
        chunks,
        requested.length > 0
          ? roots.map((r) => relative(cwd, r) || ".").join(", ")
          : null,
        traps.lines,
      ),
    );
    specLink = `../${specDir().split("/").pop()}/SPEC-${name}.md`;
  }

  mkdirSync(planDirAbs, { recursive: true });
  const buildPlan = (existing: string[]): string =>
    planTemplate(name, priorArt, contextFapony, existing, specLink);
  let planBody = buildPlan(existingScope);
  // The ≤ ~60 contract predates the §4 block — shrink the block (never the
  // judgment sections) until the file fits. Each item is one line, so cutting
  // `over` items fixes exactly; the re-render recounts the cut honestly.
  const planLines = (b: string): number =>
    b.replace(/\n$/, "").split("\n").length;
  const over = planLines(planBody) - MAX_PLAN_LINES;
  if (over > 0) {
    const budget = Math.max(existingScope.length - over, 1);
    existingScope = renderExistingInScope(roots, cwd, scoped, budget);
    planBody = buildPlan(existingScope);
  }
  writeFileSync(planPath, planBody);
  console.log(`wrote ${planPath}${specLink ? ` + SPEC-${name}.md` : ""}`);
  // Measurement surface (plan §3): a silent section is indistinguishable from
  // "no mem log" — say what was injected so a week of seeds is countable.
  if (traps.matched > 0) {
    console.log(
      `Known traps: ${traps.matched} row(s) injected (${traps.lacked} lacked files[])`,
    );
  }
  console.log("Existing plans:");
  for (const l of listExistingPlans(cwd, config, `PLAN-${name}.md`))
    console.log(l);
}
