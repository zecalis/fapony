// src/seed/review-seed.ts — `fapony review-seed [--staged|--commit <sha>|--range <a...b>|--files f1,f2,dir|--plan <PLAN.md>]`
//
// Seeds a code review with the deterministic facts of the scope the agent
// asked about: which files changed (per the exact git expression, echoed),
// who statically imports them, whether any test file touches them, and what
// the current signatures are. The agent is left with verification only —
// walk the diff, run the tests, kill findings as normal.
//
// Read-only stdout: no file writes, no cache, no state.db read — the seed is
// a lens, not a delivery (rule 5b — a command that reads code writes only to a
// path the user pointed at, and this one accepts no such path). This used to
// cite rule 5 "never write into a target worktree", dropped 2026-09-17 because
// four commands broke it; being read-only was always a property of this
// command, never of that rule. Facts only: nothing here says broken/fixed
// — judgment lives in the reviewer and mem log, never in
// this output. Deterministic: same input, same bytes, no LLM.
//
// Composes existing producers — buildGraph (analyze.ts) for importers/untested,
// extractExports (map.ts) for signatures. One flag = one declared git call;
// no magic parsing.

import type { Stats } from "node:fs";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  buildGraph,
  collectSourceFiles,
  type ImportGraph,
  isTestedThroughBarrels,
  isTestFile,
  SCAN_EXTS,
} from "../analyze/index.js";
import {
  filterKnipByScope,
  formatKnipRows,
  isSkipped,
  runKnip,
} from "../knip/index.js";
import { extractBody, extractExports } from "../map.js";
import { assertSafe } from "../safety.js";
import { execGit, gitOk, gitValue, SeedError, SIG_MAX } from "./primitives.js";

const WRAP_WIDTH = 88;
// The changed list is the review's scope boundary, not context: a file hidden
// here is a file the reviewer never walks. So it is capped by FILES, generously,
// and the overflow counts files — the other caps below are context and stay tight.
const MAX_CHANGED_FILES = 40;
const MAX_IMPORTER_LINES = 4;
const MAX_SIGNATURE_LINES = 4;
const MAX_IMPORTERS_SHOWN = 4;
const MAX_SIGNATURES_SHOWN = 5;
const MAX_DYNAMIC_LINES = 2;
const MAX_CROSS_CHECK_LINES = 2;
const OUTPUT_CAP = 30;
// `--files` is a lookup, not a review: the caller named the files, so the caps
// that keep a 40-file diff readable only hide the answer they asked for. This
// is the surface the deleted `fapony map <file>` used to be — an executor
// asking "what is in here and who breaks if I change it" before editing, at a
// fraction of reading the file. Still bounded: a hub with 60 importers is a
// wall of text, not an answer.
const LOOKUP_IMPORTERS_SHOWN = 12;
const LOOKUP_OUTPUT_CAP = 120;
// Dir expansion inside --files reuses the diff cap (MAX_CHANGED_FILES): 40
// files is already past "this component area" into "the whole tree" — cut
// there and say so, a folder-shaped wall is not an answer either.
// Signature text cap per symbol (same trim as map.ts's file view).
const DISCLAIMER =
  "static graph only — seed is where to enter, not what is verified";
const USAGE =
  "usage: fapony review-seed [--staged | --commit <sha> | --range <a...b> | --files f1,f2,dir | --plan <PLAN.md>] [--body sym[,sym]] [--callers sym[,sym]] [--knip]";
// --body / --callers are the executor's lookup, not the reviewer's seed: when
// either is present the output is only those sections (plus worktree line and
// disclaimer) — the standard sections would be a wall around the one answer.
const MAX_BODY_LINES = 80;
const MAX_CALLER_FILES = 12;
const MAX_CALLER_HITS = 20;

// --- Scope flags: exactly one source of scope ---

type Scope =
  | { kind: "default" }
  | { kind: "staged" }
  | { kind: "commit"; sha: string }
  | { kind: "range"; expr: string }
  | { kind: "files"; list: string[] }
  | { kind: "plan"; path: string };

interface LookupFlags {
  /** --body sym[,sym] — declaration slices from the named file(s). */
  body: string[];
  /** --callers sym[,sym] — symbol→symbol grep over importer files. */
  callers: string[];
}

function parseLookup(args: string[]): LookupFlags {
  const body: string[] = [];
  const callers: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--body" || a === "--callers") {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) {
        throw new SeedError(`review-seed: ${a} needs a value\n${USAGE}`);
      }
      i++;
      // Both flags take the same comma shape --files takes: split, trim,
      // drop empties, validate each symbol (PLAN-comma-x).
      const syms = v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (syms.length === 0) {
        throw new SeedError(`review-seed: ${a} needs a symbol\n${USAGE}`);
      }
      for (const s of syms) {
        if (!/^[A-Za-z_$][\w$]*$/.test(s)) {
          throw new SeedError(`review-seed: invalid symbol: ${s}`);
        }
        if (a === "--body") body.push(s);
        else callers.push(s);
      }
    }
  }
  return { body, callers };
}

function parseScope(args: string[]): Scope {
  const flags: Scope[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const value = (): string => {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) {
        throw new SeedError(`review-seed: ${a} needs a value\n${USAGE}`);
      }
      i++;
      return v;
    };
    if (a === "--body" || a === "--callers") {
      i++; // consumed by parseLookup — never a scope flag
      continue;
    }
    // --knip is an orthogonal modifier (one extra section), not a scope.
    if (a === "--knip") continue;
    if (a === "--staged") flags.push({ kind: "staged" });
    else if (a === "--commit") {
      const v = value();
      gitValue("commit ref", v);
      flags.push({ kind: "commit", sha: v });
    } else if (a === "--range") {
      const v = value();
      gitValue("range", v);
      if (!v.includes("...")) {
        throw new SeedError(
          `review-seed: --range wants three-dot (merge-base, PR semantics): a...b\n${USAGE}`,
        );
      }
      flags.push({ kind: "range", expr: v });
    } else if (a === "--files") {
      const list = value()
        .split(",")
        .map((s) => s.trim().replace(/^\.\//, ""))
        .filter(Boolean);
      if (list.length === 0) {
        throw new SeedError(
          `review-seed: --files needs at least one path\n${USAGE}`,
        );
      }
      flags.push({ kind: "files", list });
    } else if (a === "--plan") {
      flags.push({ kind: "plan", path: value() });
    } else if (a === "-h" || a === "--help") {
      throw new SeedError(USAGE);
    } else {
      throw new SeedError(`review-seed: unknown argument "${a}"\n${USAGE}`);
    }
  }
  if (flags.length === 0) return { kind: "default" };
  // Repeats of the SAME kind: --files occurrences merge into one scope list
  // (an agent splitting a lookup across two --files tokens is the same shape
  // as the comma list it already accepts); an identical scalar repeat is
  // idempotent; a scalar repeated with a DIFFERENT value is ambiguous and
  // errors — never last-wins (PLAN-comma-x chunk 2). The mixed-scope guard
  // below counts distinct kinds, not occurrences, so `--files a --files b`
  // is one scope, not "files, files".
  const merged = new Map<string, Scope>();
  for (const f of flags) {
    const prev = merged.get(f.kind);
    if (prev === undefined) {
      merged.set(f.kind, f);
    } else if (f.kind === "files" && prev.kind === "files") {
      prev.list = [...new Set([...prev.list, ...f.list])];
    } else if (JSON.stringify(prev) !== JSON.stringify(f)) {
      throw new SeedError(
        `review-seed: --${f.kind} given twice with different values\n${USAGE}`,
      );
    }
  }
  if (merged.size > 1) {
    throw new SeedError(
      `review-seed: one scope flag at a time (got ${[...merged.keys()].join(", ")})\n${USAGE}`,
    );
  }
  return [...merged.values()][0];
}

// --- Scope resolution: one flag = one declared git call ---

export interface FileEntry {
  path: string;
  ins: number | null;
  del: number | null;
  untracked: boolean;
  /** Set when -M paired this path with a deleted source (a rename). */
  renamedFrom?: string;
  /** Set when this path was found by expanding a --files directory. */
  expanded?: true;
}

interface ResolvedScope {
  label: string;
  entries: FileEntry[];
  /** For --plan: default-diff paths, for the cross-check. */
  crossCheck?: { planFiles: string[]; changed: string[] };
  /** For --files: dropped paths and expansion cuts, printed after changed. */
  filesNotes?: string[];
}

// `--files` accepts directories: the caller thinks in zones ("this component
// area"), not file names — asking is how the names get learned. A dir expands
// to source files under it via the same walk buildGraph keys the graph by
// (collectSourceFiles — node_modules/.git/nested checkouts skipped, no
// hidden-dir filter, same as the graph), so importers and signatures still
// hit. A path that is neither file nor dir is dropped from the scope and
// reported, never silently counted as a one-row scope.
function expandFilesScope(
  list: string[],
  worktree: string,
): { files: FileEntry[]; notes: string[]; dirExpanded: boolean } {
  const files: FileEntry[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  const notFound: string[] = [];
  const emptyDirs: string[] = [];
  const dirs: string[] = [];
  // Per-dir top-level subdir counts, gathered while walking — cheap because
  // it reuses `rels` already collected below; only printed if the cap cuts
  // something, so a scope that fits never pays for it in the output.
  const breakdowns: string[] = [];
  let dirExpanded = false;
  let cutNamed = 0;
  let cutExpanded = 0;
  const add = (p: string, expanded: boolean): void => {
    if (seen.has(p)) return;
    seen.add(p);
    if (files.length >= MAX_CHANGED_FILES) {
      if (expanded) cutExpanded++;
      else cutNamed++;
      return;
    }
    files.push({
      path: p,
      ins: null,
      del: null,
      untracked: false,
      ...(expanded ? { expanded: true } : {}),
    });
  };
  // Named files are placed before any dir expands. A path the caller typed
  // outranks one a walk inferred, so `--files src/,fapony.ts` can never spend
  // the whole cap on src/ and drop fapony.ts — the quiet disappearance this
  // flag exists to stop. Dirs are collected here, expanded in the pass below.
  for (const raw of list) {
    const p = raw.replace(/\/+$/, "");
    let st: Stats;
    try {
      st = statSync(join(worktree, p));
    } catch {
      notFound.push(p);
      continue;
    }
    if (st.isFile()) add(p, false);
    else if (st.isDirectory()) dirs.push(p);
    else notFound.push(p);
  }
  for (const p of dirs) {
    dirExpanded = true;
    const rels = collectSourceFiles(join(worktree, p));
    if (rels.length === 0) emptyDirs.push(p);
    if (rels.length > MAX_CHANGED_FILES) {
      const counts = new Map<string, number>();
      for (const r of rels) {
        const top = r.includes("/") ? r.slice(0, r.indexOf("/")) : "(root)";
        counts.set(top, (counts.get(top) ?? 0) + 1);
      }
      const list = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(
          ([name, count]) => `${p === "." ? name : `${p}/${name}`} (${count})`,
        )
        .join(" · ");
      breakdowns.push(`${p} (${rels.length} files) → ${list}`);
    }
    for (const r of rels) add(p === "." ? r : `${p}/${r}`, true);
  }
  if (notFound.length > 0) {
    notes.push(
      `not found (${notFound.length}): ${notFound.join(", ")} — dropped from scope`,
    );
  }
  for (const d of emptyDirs) {
    notes.push(`${d} (dir) — no source files under it`);
  }
  if (cutNamed > 0) {
    notes.push(
      `… +${cutNamed} named file(s) past the ${MAX_CHANGED_FILES} cap — narrow the scope`,
    );
  }
  if (cutExpanded > 0) {
    notes.push(
      `… +${cutExpanded} more file(s) under the expanded dirs — capped at ${MAX_CHANGED_FILES}, narrow the scope`,
    );
    for (const b of breakdowns) notes.push(`  ${b}`);
  }
  return { files, notes, dirExpanded };
}

// numstat with -M reports renames as `old => new` (whole path) or git's
// brace form `prefix/{old => new}/suffix` (only the moved segment) — expand
// both back to full paths so downstream sections see the real new path plus
// a renamedFrom annotation, never git's internal syntax.
// Exported for plan-seed's changed-files feed — reuse, not a second parser.
export function parseNumstat(output: string): FileEntry[] {
  const out: FileEntry[] = [];
  for (const line of output.split("\n").filter(Boolean)) {
    const [ins, del, ...rest] = line.split("\t");
    let path = rest.join("\t");
    if (!path) continue;
    if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
    let renamedFrom: string | undefined;
    const brace = /\{([^{}]*) => ([^{}]*)\}/.exec(path);
    if (brace) {
      renamedFrom = path.replace(brace[0], brace[1]);
      path = path.replace(brace[0], brace[2]);
    } else if (path.includes(" => ")) {
      const arrow = path.indexOf(" => ");
      renamedFrom = path.slice(0, arrow);
      path = path.slice(arrow + 4);
    }
    out.push({
      path,
      ins: ins === "-" ? null : Number.parseInt(ins, 10),
      del: del === "-" ? null : Number.parseInt(del, 10),
      untracked: false,
      ...(renamedFrom !== undefined ? { renamedFrom } : {}),
    });
  }
  return out;
}

// untracked paths, one per file — -uall stops git collapsing an untracked
// directory to "dir/" (a seed wants file names, and the collapsed dir breaks
// plan cross-check path equality). Exported for plan-seed (same feed).
export function untrackedFiles(porcelain: string): FileEntry[] {
  const out: FileEntry[] = [];
  for (const line of porcelain.split("\n").filter(Boolean)) {
    if (!line.startsWith("?? ")) continue;
    let path = line.slice(3);
    if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
    out.push({ path, ins: null, del: null, untracked: true });
  }
  return out;
}

function shortSha(cwd: string, ref: string): string | null {
  const r = execGit(`git rev-parse --short ${ref}`, cwd);
  return r.ok ? r.output.split("\n")[0] : null;
}

// --plan paths arrive in three shapes: absolute, relative to the invocation
// cwd (e.g. ../../.fapony/plan/X.md from a subdir), or relative to the
// worktree root (e.g. .fapony/plan/X.md from anywhere). join(worktree, arg)
// answers only the third — an absolute arg becomes worktree+abs garbage
// (join, unlike resolve, does not reset on an absolute segment), and a
// cwd-relative arg with .. escapes above the root. So: absolute as-is,
// otherwise first-existing-wins between cwd and worktree (bug mucm1own).
function resolvePlanPath(arg: string, cwd: string, worktree: string): string {
  if (isAbsolute(arg)) {
    if (existsSync(arg)) return arg;
    throw new SeedError(`review-seed: plan file not found: ${arg}`);
  }
  const candidates = [resolve(cwd, arg), join(worktree, arg)];
  for (const p of new Set(candidates)) {
    if (existsSync(p)) return p;
  }
  throw new SeedError(`review-seed: plan file not found: ${arg}`);
}

// Fallback commit resolution for --plan without files[] frontmatter.
// Tries two sources in order:
//   1. `> **Commits:** sha1 sha2 …` line in the plan header
//   2. `git log --grep <PLAN-filename> --format=%h`
// Returns the first source that yields commits, with metadata for the label.
function isCommitObject(sha: string, cwd: string): boolean {
  return execGit(`git cat-file -e ${sha}^{commit}`, cwd).ok;
}

function planFallbackCommits(
  planText: string,
  planBase: string,
  cwd: string,
): { sha: string; short: string; source: "header" | "git log grep" }[] {
  // Source 1: > **Commits:** line in the plan header (first 2048 bytes)
  const head = planText.slice(0, 2048);
  const commitsLine = />\s*\*?\*?Commits:?\*?\*?\s+(.+)/i.exec(head);
  if (commitsLine) {
    const shas = commitsLine[1]
      .match(/\b[0-9a-f]{7,12}\b/g)
      ?.filter((s) => isCommitObject(s, cwd))
      .map((s) => ({
        sha: s,
        short: s,
        source: "header" as const,
      }));
    if (shas && shas.length > 0) return shas;
  }
  // Source 2: git log --grep for the plan name. Chunk commits cite the plan
  // as "(PLAN-x chunk N)" — never with the .md suffix — so grep the stem:
  // it still matches messages that do carry the suffix (substring).
  const stem = planBase.replace(/\.md$/, "");
  const logResult = execGit(
    `git log --grep=${stem} --format=%h --max-count=10`,
    cwd,
  );
  if (logResult.ok && logResult.output.trim()) {
    const shas = logResult.output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((s) => ({
        sha: s,
        short: s,
        source: "git log grep" as const,
      }));
    if (shas.length > 0) return shas;
  }
  return [];
}

function resolveScope(
  scope: Scope,
  cwd: string,
  worktree: string,
): ResolvedScope {
  if (scope.kind === "files") {
    const { files, notes, dirExpanded } = expandFilesScope(
      scope.list,
      worktree,
    );
    return {
      label: dirExpanded ? "--files (dir-expanded)" : "--files (as given)",
      entries: files,
      ...(notes.length > 0 ? { filesNotes: notes } : {}),
    };
  }
  if (scope.kind === "plan") {
    const planPath = resolvePlanPath(scope.path, cwd, worktree);
    const planText = readFileSync(planPath, "utf-8");
    const planFiles = planFrontFiles(planText);
    if (planFiles === null) {
      // No files[] — try fallback commit sources before default diff.
      const planBase = basename(planPath);
      const fallbackCommits = planFallbackCommits(planText, planBase, cwd);
      if (fallbackCommits.length > 0) {
        // Use the fallback commits as the scope: get the files touched by those commits.
        const shaList = fallbackCommits.map((c) => c.sha).join(" ");
        const entries = parseNumstat(
          execGit(`git diff-tree --no-commit-id --numstat -r ${shaList}`, cwd)
            .output,
        );
        const source = fallbackCommits[0].source;
        return {
          label: `--plan ${scope.path} (commits via ${source}: ${fallbackCommits.map((c) => c.short).join(", ")})`,
          entries,
        };
      }
      // No commits found either — fall back to the default diff, say so.
      const entries = [
        ...parseNumstat(execGit("git diff HEAD --numstat -M", cwd).output),
        ...untrackedFiles(execGit("git status --porcelain -uall", cwd).output),
      ];
      return {
        label:
          "--plan (no files: frontmatter, no commits found) — diff HEAD + untracked",
        entries,
      };
    }
    // Cross-check target is the default diff — one declared git call.
    const changed = [
      ...parseNumstat(execGit("git diff HEAD --numstat -M", cwd).output),
      ...untrackedFiles(execGit("git status --porcelain -uall", cwd).output),
    ].map((e) => e.path);
    const shortA = shortSha(cwd, "HEAD");
    return {
      label: `--plan ${scope.path}${shortA ? ` (HEAD = ${shortA})` : ""}`,
      entries: planFiles.map((p) => ({
        path: p,
        ins: null,
        del: null,
        untracked: false,
      })),
      crossCheck: { planFiles, changed: [...new Set(changed)].sort() },
    };
  }
  if (scope.kind === "default") {
    const diff = execGit("git diff HEAD --numstat -M", cwd);
    gitOk(diff, "git diff HEAD --numstat -M");
    const st = execGit("git status --porcelain -uall", cwd);
    gitOk(st, "git status --porcelain -uall");
    const entries = [
      ...parseNumstat(diff.output),
      ...untrackedFiles(st.output),
    ];
    return { label: "diff HEAD + untracked", entries };
  }
  if (scope.kind === "staged") {
    const diff = execGit("git diff --cached --numstat -M", cwd);
    gitOk(diff, "git diff --cached --numstat -M");
    return {
      label: "--staged (diff --cached)",
      entries: parseNumstat(diff.output),
    };
  }
  if (scope.kind === "commit") {
    const sha = scope.sha;
    const verify = execGit(`git rev-parse --verify ${sha}^{commit}`, cwd);
    if (!verify.ok) throw new SeedError(`review-seed: not a commit: ${sha}`);
    const short = shortSha(cwd, sha) ?? sha;
    const parent = execGit(`git rev-parse --verify ${sha}^`, cwd);
    if (!parent.ok) {
      // Root commit — no parent to diff against; tree vs empty tree instead.
      const entries = parseNumstat(
        execGit(`git diff-tree --no-commit-id --numstat -r --root ${sha}`, cwd)
          .output,
      );
      return {
        label: `--commit ${short} (root commit — vs empty tree)`,
        entries,
      };
    }
    const parentShort = shortSha(cwd, `${sha}^`) ?? parent.output.slice(0, 7);
    const diff = execGit(`git diff ${sha}^ ${sha} --numstat -M`, cwd);
    gitOk(diff, `git diff ${sha}^ ${sha} --numstat -M`);
    return {
      label: `--commit ${short} (${parentShort}..${short})`,
      entries: parseNumstat(diff.output),
    };
  }
  // range
  const expr = scope.expr;
  const mb = execGit(`git merge-base ${expr.replace("...", " ")}`, cwd);
  const tipShort = shortSha(cwd, expr.split("...")[1]) ?? expr.split("...")[1];
  const baseShort = mb.ok ? (shortSha(cwd, mb.output) ?? "?") : null;
  const diff = execGit(`git diff ${expr} --numstat -M`, cwd);
  gitOk(diff, `git diff ${expr} --numstat -M`);
  return {
    label: baseShort ? `${expr} = ${baseShort}…${tipShort}` : `--range ${expr}`,
    entries: parseNumstat(diff.output),
  };
}

// --- Plan frontmatter files[] (same flat-key style as plans.ts parseFront) ---

function planFrontFiles(text: string): string[] | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^\s*([a-z_]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (kv?.[1] !== "files") continue;
    const value = kv[2].replace(/\s+#.*$/, "").trim();
    if (!value) return null;
    const list = value
      .split(",")
      .map((s) => s.trim().replace(/^\.\//, ""))
      .filter(Boolean);
    return list.length > 0 ? list : null;
  }
  return null;
}

// --- Structure lines (facts from the static graph) ---

function wrap(parts: string[], joiner: string, indent: string): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const p of parts) {
    const piece = cur ? `${cur}${joiner}${p}` : p;
    if (piece.length > WRAP_WIDTH && cur) {
      lines.push(`${indent}${cur}`);
      cur = p;
    } else {
      cur = piece;
    }
  }
  if (cur) lines.push(`${indent}${cur}`);
  return lines;
}

function fmtCounts(e: FileEntry): string {
  const rename = e.renamedFrom ? ` (renamed from ${e.renamedFrom})` : "";
  if (e.untracked) return " (untracked)";
  // Dir-expanded files were not named by the caller — "as given" would lie.
  if (e.expanded) return rename;
  if (e.ins === null || e.del === null) return rename || " (as given)";
  if (e.ins === 0 && e.del === 0) return rename;
  return ` +${e.ins}-${e.del}${rename}`;
}

function hasDynamicDispatch(absFile: string): boolean {
  let content: string;
  try {
    content = readFileSync(absFile, "utf-8");
  } catch {
    return false;
  }
  return /\b(?:import|require)\s*\(/.test(content);
}

// --- --body: declaration slice (indent-out, no parser) ---
// extractBody lives in map.ts beside extractExports — the conventions seeder
// reuses the same slice for wrapper detection (one implementation, rule 1).

// --- --callers: symbol→symbol over importer files (identifier scan) ---

// Narrow file→file importers to symbol→symbol by scanning importer files for
// the identifier. Deliberately textual: a name in a comment or string counts
// as a hit — ~80% of "who calls this" for near-zero cost. Real call-graph
// precision is code-review-graph's job; this is the seed that says where to
// look. Only static importers are scanned (the graph's dependents); a caller
// that never imports the defining file is out of reach here.
function findCallers(
  symbol: string,
  targets: string[],
  graph: ImportGraph,
  worktree: string,
): {
  rows: { file: string; hits: number[]; more: number }[];
  filesCapped: boolean;
} {
  const all: { file: string; hits: number[]; more: number }[] = [];
  const re = new RegExp(`\\b${symbol}\\b`);
  for (const target of targets) {
    for (const dep of graph.dependents.get(target) ?? new Set<string>()) {
      if (all.some((o) => o.file === dep)) continue;
      let source: string;
      try {
        source = readFileSync(join(worktree, dep), "utf-8");
      } catch {
        continue;
      }
      const found = source
        .split("\n")
        .map((l, i) => (re.test(l) ? i + 1 : 0))
        .filter((n) => n > 0);
      if (found.length === 0) continue;
      const hits = found.slice(0, MAX_CALLER_HITS);
      all.push({ file: dep, hits, more: found.length - hits.length });
    }
  }
  // Sort before capping: capping first would show an arbitrary 12 of N.
  all.sort((a, b) => (a.file < b.file ? -1 : 1));
  const rows = all.slice(0, MAX_CALLER_FILES);
  return { rows, filesCapped: all.length > rows.length };
}

// --body / --callers output: the answer the executor asked for, nothing else.
// Resolve the scope first (cheap for --files, one git call otherwise) because
// --callers needs the target file list to walk importers from.
function renderLookup(
  flags: LookupFlags,
  scope: Scope,
  cwd: string,
  worktree: string,
): string {
  const lines: string[] = [];
  lines.push(`worktree: ${worktree} (${lookupLabel(flags)})`);

  let resolved: ResolvedScope | null = null;
  if (flags.callers.length > 0) {
    resolved = resolveScope(scope, cwd, worktree);
  }

  const hasGraph = (f: string): boolean => {
    const dot = f.lastIndexOf(".");
    return dot >= 0 && SCAN_EXTS.has(f.slice(dot));
  };

  if (flags.body.length > 0) {
    // Which files to search: scope entries when the scope names them, else
    // the flag can be used bare — then scan every source file in the tree
    // (same walk as buildGraph), capped, with the cut announced.
    let targets: string[];
    if (scope.kind === "files") {
      targets = expandFilesScope(scope.list, worktree)
        .files.map((e) => e.path)
        .filter(hasGraph);
    } else {
      targets = collectSourceFiles(worktree);
    }
    const shown: string[] = [];
    for (const path of targets) {
      let source: string;
      try {
        source = readFileSync(join(worktree, path), "utf-8");
      } catch {
        continue;
      }
      const scan = extractExports(source, undefined, path);
      if (scan.error) continue;
      for (const sym of scan.symbols) {
        if (!flags.body.includes(sym.name)) continue;
        shown.push(`${path}:${sym.line}`);
        lines.push(`${path}:${sym.line} ${sym.name}`);
        const body = extractBody(source, sym.line);
        if (body.length >= MAX_BODY_LINES) {
          lines.push(
            `  ⚠ body truncated at ${MAX_BODY_LINES} lines — read the file for the rest`,
          );
        }
        for (const b of body) lines.push(`  ${b}`);
      }
    }
    if (shown.length === 0) {
      lines.push(`body: no export named ${flags.body.join(", ")} in scope`);
    }
    if (scope.kind !== "files") {
      lines.push(
        "(no --files: scanned whole tree — pass --files <file> to narrow)",
      );
    }
  }

  if (flags.callers.length > 0) {
    const graph = buildGraph(worktree);
    const targets = (resolved?.entries ?? [])
      .map((e) => e.path)
      .filter(hasGraph);
    // One section per symbol — a merged any-of scan would lose which
    // symbol hit, and a single symbol's output stays byte-identical.
    for (const sym of flags.callers) {
      const found = findCallers(sym, targets, graph, worktree);
      if (targets.length === 0) {
        lines.push(`callers of ${sym}: no source files in scope`);
      } else if (found.rows.length === 0) {
        lines.push(
          `callers of ${sym}: none found in static importers (dynamic or non-importing use is out of reach)`,
        );
      } else {
        lines.push(
          `callers of ${sym} (textual hits, may be comments/strings):`,
        );
        for (const f of found.rows) {
          const more = f.more > 0 ? ` (+${f.more} more hits)` : "";
          lines.push(`  ${f.file}:${f.hits.join(",")}${more}`);
        }
        if (found.filesCapped) {
          lines.push(
            `  ⚠ more importer files matched — capped at ${MAX_CALLER_FILES}`,
          );
        }
      }
    }
  }

  lines.push(DISCLAIMER);
  return lines.join("\n");
}

function lookupLabel(flags: LookupFlags): string {
  const parts: string[] = [];
  if (flags.body.length > 0) parts.push(`--body ${flags.body.join(",")}`);
  if (flags.callers.length > 0) {
    parts.push(`--callers ${flags.callers.join(",")}`);
  }
  return parts.join(" ");
}

export function renderSeed(args: string[], cwd: string): string {
  const scope = parseScope(args);
  const root = execGit("git rev-parse --show-toplevel", cwd);
  if (!root.ok) {
    throw new SeedError("review-seed: not a git repository (no worktree root)");
  }
  try {
    assertSafe(args);
  } catch (e) {
    throw new SeedError(
      e instanceof Error ? e.message : "refused dangerous argument",
    );
  }
  const worktree = root.output.split("\n")[0];

  // --body / --callers: lookup mode. Scope flags stay legal (a --files dir
  // feeds --callers its targets), but the standard sections are suppressed —
  // the caller asked for one answer, not the review seed around it.
  const lookup = parseLookup(args);
  const hasKnip = args.includes("--knip");
  if (lookup.body.length > 0 || lookup.callers.length > 0) {
    if (hasKnip) {
      throw new SeedError(
        `review-seed: --knip needs a scope section, not --body/--callers\n${USAGE}`,
      );
    }
    return renderLookup(lookup, scope, cwd, worktree);
  }

  const resolved = resolveScope(scope, cwd, worktree);
  const entries = [...resolved.entries].sort((a, b) =>
    a.path < b.path ? -1 : 1,
  );

  // Static graph over the whole worktree — same producer as `fapony analyze`.
  let graph: ImportGraph | null = null;
  try {
    graph = buildGraph(worktree);
  } catch {
    graph = null;
  }
  const testFiles = graph ? graph.files.filter((f) => isTestFile(f)).length : 0;

  const structureTargets = entries.filter((e) => {
    if (isTestFile(e.path)) return false;
    // SCAN_EXTS keys carry the dot (".ts") — slice from the dot itself.
    const dot = e.path.lastIndexOf(".");
    if (dot < 0 || !SCAN_EXTS.has(e.path.slice(dot))) return false;
    return existsSync(join(worktree, e.path));
  });

  // Lookup mode: caller named the files, so show them whole (see caps above).
  const filesLookup = scope.kind === "files";
  const importersShown = filesLookup
    ? LOOKUP_IMPORTERS_SHOWN
    : MAX_IMPORTERS_SHOWN;
  const importerLineCap = filesLookup ? entries.length : MAX_IMPORTER_LINES;
  const signaturesShown = filesLookup
    ? Number.POSITIVE_INFINITY
    : MAX_SIGNATURES_SHOWN;
  const signatureLineCap = filesLookup ? entries.length : MAX_SIGNATURE_LINES;
  const outputCap = filesLookup ? LOOKUP_OUTPUT_CAP : OUTPUT_CAP;

  const lines: string[] = [];
  lines.push(`worktree: ${worktree} (${resolved.label})`);

  const shownEntries = entries.slice(0, MAX_CHANGED_FILES);
  const changedParts = shownEntries.map((e) => `${e.path}${fmtCounts(e)}`);
  if (entries.length === 0) {
    lines.push("changed (0): nothing in this scope");
  } else {
    lines.push(`changed (${entries.length}):`);
    lines.push(...wrap(changedParts, " · ", "  "));
    if (entries.length > shownEntries.length) {
      lines.push(
        `  … +${entries.length - shownEntries.length} more file(s) — narrow the scope to see them`,
      );
    }
  }
  for (const n of resolved.filesNotes ?? []) lines.push(n);

  if (!graph) {
    lines.push(
      "graph: scan failed — importers/untested/signatures unavailable",
    );
  } else if (structureTargets.length > 0) {
    const importerLines: string[] = [];
    for (const e of structureTargets) {
      const deps = [
        ...(graph.dependents.get(e.path) ?? new Set<string>()),
      ].sort();
      if (deps.length === 0) continue;
      const shown = deps.slice(0, importersShown).join(", ");
      const rest =
        deps.length > importersShown
          ? ` (+${deps.length - importersShown})`
          : "";
      importerLines.push(`  ${e.path} ← ${shown}${rest}`);
    }
    if (importerLines.length > 0) {
      lines.push("importers (static):");
      for (const l of importerLines.slice(0, importerLineCap)) lines.push(l);
      if (importerLines.length > importerLineCap) {
        lines.push(`  … +${importerLines.length - importerLineCap} more`);
      }
    }

    const untested = structureTargets.filter(
      (e) => !(graph && isTestedThroughBarrels(graph, e.path)),
    );
    if (testFiles === 0) {
      lines.push("untested: repo has no test files — flag uninformative");
    } else if (untested.length > 0) {
      const wrapped = wrap(
        untested.map((e) => e.path),
        ", ",
        "  ",
      );
      lines.push(`untested (${untested.length}):`);
      lines.push(...wrapped.slice(0, 2));
      if (wrapped.length > 2) lines.push(`  … +${wrapped.length - 2} more`);
    }

    const sigLines: string[] = [];
    for (const e of structureTargets) {
      let source: string;
      try {
        source = readFileSync(join(worktree, e.path), "utf-8");
      } catch {
        continue;
      }
      const scan = extractExports(source, undefined, e.path);
      if (scan.error) {
        sigLines.push(`  ${e.path} — ⚠ ${scan.error}`);
        continue;
      }
      if (scan.symbols.length === 0) {
        sigLines.push(`  ${e.path} — (no exports)`);
        continue;
      }
      // Real declaration text per symbol — the reviewer checks "did a param
      // change" without opening the file. Same trim as map.ts's file view.
      const srcLines = source.split("\n");
      const shown = scan.symbols
        .slice(0, signaturesShown)
        .map((s) => {
          const raw = (srcLines[s.line - 1] ?? "").trim();
          const sig =
            raw.length > SIG_MAX ? `${raw.slice(0, SIG_MAX - 1)}…` : raw;
          return sig ? `${s.name}:${s.line} ${sig}` : `${s.name}:${s.line}`;
        })
        .join(" · ");
      const rest =
        scan.symbols.length > signaturesShown
          ? ` (+${scan.symbols.length - signaturesShown})`
          : "";
      sigLines.push(`  ${e.path} — ${shown}${rest}`);
    }
    if (sigLines.length > 0) {
      lines.push("signatures (current):");
      for (const l of sigLines.slice(0, signatureLineCap)) lines.push(l);
      if (sigLines.length > signatureLineCap) {
        lines.push(`  … +${sigLines.length - signatureLineCap} more`);
      }
    }

    const dynamic = structureTargets.filter((e) =>
      hasDynamicDispatch(join(worktree, e.path)),
    );
    if (dynamic.length > 0) {
      const wrapped = wrap(
        dynamic.map((e) => e.path),
        ", ",
        "  ",
      );
      lines.push(
        "dynamic-dispatch hint (import(/require( — resolve at runtime):",
      );
      lines.push(...wrapped.slice(0, MAX_DYNAMIC_LINES));
      if (wrapped.length > MAX_DYNAMIC_LINES) {
        lines.push(`  … +${wrapped.length - MAX_DYNAMIC_LINES} more lines`);
      }
    }
  }

  // --knip: unused exports/files scoped to this seed's entries. Opt-in (slow:
  // spawns bunx) and TS-only — knip knows nothing of .py/.rs, so those files
  // simply never match. Never fails the seed: an unrunnable knip is one line.
  if (hasKnip) {
    const knip = runKnip(worktree);
    if (isSkipped(knip)) {
      lines.push(knip.skipped);
    } else {
      lines.push(
        ...formatKnipRows(
          filterKnipByScope(
            knip.issues,
            entries.map((e) => e.path),
          ),
        ),
      );
    }
  }

  if (resolved.crossCheck) {
    const planSet = new Set(resolved.crossCheck.planFiles);
    const changedSet = new Set(resolved.crossCheck.changed);
    const notInPlan = [...changedSet].filter((f) => !planSet.has(f)).sort();
    const notChanged = resolved.crossCheck.planFiles
      .filter((f) => !changedSet.has(f))
      .sort();
    if (notInPlan.length > 0 || notChanged.length > 0) {
      if (notInPlan.length > 0) {
        const wrapped = wrap(notInPlan, ", ", "  ");
        lines.push("plan cross-check: changed-not-in-plan:");
        lines.push(...wrapped.slice(0, MAX_CROSS_CHECK_LINES));
        if (wrapped.length > MAX_CROSS_CHECK_LINES) {
          lines.push(
            `  … +${wrapped.length - MAX_CROSS_CHECK_LINES} more lines`,
          );
        }
      }
      if (notChanged.length > 0) {
        const wrapped = wrap(notChanged, ", ", "  ");
        lines.push("plan cross-check: in-plan-not-changed:");
        lines.push(...wrapped.slice(0, MAX_CROSS_CHECK_LINES));
        if (wrapped.length > MAX_CROSS_CHECK_LINES) {
          lines.push(
            `  … +${wrapped.length - MAX_CROSS_CHECK_LINES} more lines`,
          );
        }
      }
    }
  } else if (scope.kind === "plan") {
    lines.push("plan cross-check: plan has no files: frontmatter — skipped");
  } else {
    lines.push("plan cross-check: skipped — no --plan flag");
  }

  // Disclaimer is mandatory on every output — reserve its line so cap
  // truncation (below) can never carry it off with the rest of the tail.
  if (lines.length > outputCap - 1) {
    const rest = lines.length - (outputCap - 2);
    lines.length = outputCap - 2;
    lines.push(`… (+${rest} lines truncated)`);
  }
  lines.push(DISCLAIMER);
  return lines.join("\n");
}

export function cmdReviewSeed(args: string[]): void {
  try {
    console.log(renderSeed(args, process.cwd()));
  } catch (e) {
    if (e instanceof SeedError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
}
