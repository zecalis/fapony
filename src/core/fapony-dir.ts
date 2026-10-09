// src/core/fapony-dir.ts — where a repo's `.fapony/` (plan/ done/ spec/)
// lives: the nearest one walking up from cwd, bounded by the
// git root, else `<root>/.fapony`. Monorepos keep one per app (apps/x/.fapony).

import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { FAPONY_DIR } from "./config.js";

/** Physical path (symlinks resolved) so start and repo root compare like with
 *  like; falls back to a lexical resolve when the path does not exist yet. */
function physical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** `git rev-parse --show-toplevel` from a directory, or null outside a repo. */
function gitRootOf(fromDir: string): string | null {
  try {
    const { execSync } =
      require("node:child_process") as typeof import("node:child_process");
    const root = execSync("git rev-parse --show-toplevel", {
      cwd: fromDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return root || null;
  } catch {
    return null;
  }
}

/**
 * The lexical ancestor of `fromDir` that is the git repo root, or null outside
 * a repo. `git rev-parse` returns a physical path (it resolves /var → /private/
 * var on macOS), so the walk compares `physical(dir)` against it and returns the
 * path in the caller's own lexical form — the returned dir must match what the
 * caller passed in, not a canonicalized stranger.
 */
export function repoRootOf(fromDir: string): string | null {
  const start = resolve(fromDir);
  const gitRoot = gitRootOf(start);
  if (!gitRoot) return null;
  const physicalRoot = physical(gitRoot);
  let dir = start;
  while (true) {
    if (physical(dir) === physicalRoot) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Nearest `.fapony/` at or above `fromDir` (never past the git root), else
 *  `<root>/.fapony` — which may not exist yet. */
export function faponyDirFrom(fromDir: string): string {
  const start = resolve(fromDir);
  const root = repoRootOf(start);
  let dir = start;
  while (true) {
    const candidate = join(dir, FAPONY_DIR);
    if (existsSync(candidate)) return candidate;
    if (dir === (root ?? "/")) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(root ?? start, FAPONY_DIR);
}
