// src/knip/run.ts — run knip once, never throw.
// Read-only: spawns `bunx knip@6 --reporter json` in the target worktree and
// parses stdout. Any failure (not installed, no package.json, timeout,
// unparseable) returns { skipped } — the seed prints one line, never fails
// the whole lookup (same philosophy as the graph scan failure path).
//
// Pinned to knip@6: an unpinned `bunx knip` resolves whatever is newest on
// the machine running the seed, and exit codes / stderr wording differ
// across versions (measured: exit-2 + help-on-stdout with no package.json
// on one version, exit-1 + empty stderr on another). Every skipped line
// carries the `knip:` prefix so callers can grep one shape.

import type { KnipEntry, KnipResult } from "./types.js";

/** Timeout for the spawned knip — the seed waits on this, so a hung knip
 *  must degrade to one skipped line, never a hung lookup. */
export const KNIP_TIMEOUT_MS = 60_000;

/** The spawn outcome `interpretKnipSpawn` needs — a subset of Bun's
 *  SyncSubprocess shape, so tests can feed canned results without spawning. */
export interface KnipSpawnResult {
  exitCode: number | null;
  stdout: Uint8Array;
  stderr: Uint8Array;
  exitedDueToTimeout?: boolean;
}

interface RawIssue {
  name?: unknown;
  line?: unknown;
  file?: unknown;
  files?: unknown;
  exports?: unknown;
  types?: unknown;
  enumMembers?: unknown;
  namespaceMembers?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
}

function asArray(v: unknown): RawIssue[] {
  return Array.isArray(v) ? (v as RawIssue[]) : [];
}

function names(list: unknown): { name: string; line: number }[] {
  const out: { name: string; line: number }[] = [];
  for (const e of asArray(list)) {
    if (typeof e.name === "string") {
      const l = typeof e.line === "number" ? e.line : 0;
      out.push({ name: e.name, line: l });
    }
  }
  return out;
}

function depNames(list: unknown): { name: string }[] {
  const out: { name: string }[] = [];
  for (const e of asArray(list)) {
    if (typeof e.name === "string") out.push({ name: e.name });
  }
  if (Array.isArray(list)) {
    for (const s of list) {
      if (typeof s === "string") out.push({ name: s });
    }
  }
  return out;
}

function toEntry(e: RawIssue): KnipEntry | null {
  if (typeof e.file !== "string") return null;
  const files: { name: string }[] = [];
  for (const f of asArray(e.files)) {
    if (typeof f.name === "string") files.push({ name: f.name });
  }
  return {
    file: e.file,
    files,
    exports: names(e.exports),
    types: names(e.types),
    enumMembers: names(e.enumMembers),
    namespaceMembers: names(e.namespaceMembers),
    dependencies: depNames(e.dependencies),
    devDependencies: depNames(e.devDependencies),
  };
}

/** Turn a finished spawn into issues-or-skipped. Pure (no spawning), so
 *  tests feed canned exit codes and bytes instead of running knip. */
export function interpretKnipSpawn(p: KnipSpawnResult): KnipResult {
  if (p.exitedDueToTimeout) {
    return {
      skipped: `knip: skipped (timed out after ${KNIP_TIMEOUT_MS / 1000}s)`,
    };
  }
  const err = Buffer.from(p.stderr).toString().trim().split("\n")[0] ?? "";
  // No project here at all (no package.json) — stdout is just `--help`
  // boilerplate then. Check this first: knip also exits non-zero with real
  // JSON on stdout when it finds issues (same as linters), and that stdout
  // IS the result.
  if (/package\.json|no .*project|configuration/i.test(err)) {
    return { skipped: `knip: no JS/TS project found (${err.slice(0, 80)})` };
  }
  if (p.exitCode !== 0) {
    if (Buffer.from(p.stdout).toString().trim().length === 0) {
      return {
        skipped: `knip: skipped (exit ${p.exitCode} ${err.slice(0, 80)})`,
      };
    }
    // Non-zero with stdout: fall through to the parse below.
  }
  try {
    const parsed = JSON.parse(Buffer.from(p.stdout).toString()) as {
      issues?: unknown;
    };
    const entries: KnipEntry[] = [];
    for (const e of asArray(parsed.issues)) {
      const entry = toEntry(e);
      if (entry) entries.push(entry);
    }
    return { issues: entries };
  } catch {
    return { skipped: "knip: output unparseable" };
  }
}

export function runKnip(worktree: string): KnipResult {
  let p: KnipSpawnResult;
  try {
    p = Bun.spawnSync(["bunx", "knip@6", "--reporter", "json"], {
      cwd: worktree,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: KNIP_TIMEOUT_MS,
    });
  } catch {
    return { skipped: "knip: not runnable here (bunx spawn failed)" };
  }
  return interpretKnipSpawn(p);
}
