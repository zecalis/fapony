// src/analyze/discover.ts — file discovery: which files enter the graph.
//
// Manual walk, not Bun.Glob. Always skipped dirs are hardcoded — no config
// (per plan: no .faponyignore in v1).

import type { Dirent } from "node:fs";
import { existsSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const SCAN_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".pyi"]);

// Files whose exports are listed. Rust is here but not in SCAN_EXTS: plan-seed
// reads its `pub` items, while the import graph has no Rust edges — adding
// `.rs` to the graph would report every Rust file as an orphan.
export const EXPORT_EXTS = new Set([...SCAN_EXTS, ".rs"]);

// "templates" for the same reason knip.json ignores templates/**: those files
// ship as a template laid down in other repos by `fapony init` and never
// have real importers here — scanning them produces false wrapper/orphan
// signals (measured: conventions-seed flagged 8 "wrappers" that were all
// src/mem/commands/*.ts helpers matched against unrelated identically-
// named calls elsewhere in the repo, e.g. "cmdDone() instead of done(").
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  "templates",
  // A `.venv` holds thousands of third-party `.py` files — walking it would
  // drown the graph the way node_modules would (which is skipped above).
  // `__pycache__` needs no entry: it holds only `.pyc`, never scanned.
  ".venv",
]);

// A nested checkout (clone or `git worktree add`) is a different project that
// happens to live inside this one — walking it doubles the graph and makes every
// single-directory pattern look like it repeats across two. `parentDir` is
// required so this can be detected rather than guessed from the name: prefixes
// like `wt-`/`cl-` are one person's convention, `.git` is the actual invariant
// (a dir for a clone, a file for a worktree — existsSync covers both).
export function isSkippedDir(name: string, parentDir: string): boolean {
  if (SKIP_DIRS.has(name)) return true;
  return existsSync(join(parentDir, name, ".git"));
}

export function isEntryPoint(rel: string): boolean {
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  return base === "fapony.ts" || base === "index.ts" || base === "__main__.py";
}

export function collectSourceFiles(
  absDir: string,
  opts?: { skipHidden?: boolean; exts?: Set<string> },
): string[] {
  const exts = opts?.exts ?? SCAN_EXTS;
  const out: string[] = [];
  const stack: string[] = [absDir];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir → skip, never throw
    }
    for (const e of entries) {
      // Never follow symlinks — loop-proof without extra code.
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (isSkippedDir(e.name, dir)) continue;
        if (opts?.skipHidden && e.name.startsWith(".")) continue;
        stack.push(join(dir, e.name));
      } else if (e.isFile()) {
        const dot = e.name.lastIndexOf(".");
        if (dot >= 0 && exts.has(e.name.slice(dot))) {
          out.push(relative(absDir, join(dir, e.name)).split(sep).join("/"));
        }
      }
    }
  }
  out.sort();
  // Shadow rule: `x.py` wins over `x.pyi` — the stub is a fallback for
  // stub-only distributions, never a second node (otherwise dependents
  // double-count). The dropped `.pyi` still resolves via candidates.
  if (out.some((f) => f.endsWith(".pyi"))) {
    const has = new Set(out);
    return out.filter((f) => !f.endsWith(".pyi") || !has.has(f.slice(0, -1)));
  }
  return out;
}
