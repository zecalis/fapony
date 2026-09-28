// test/helpers.ts — shared test helpers for fapony tests.
// Use these instead of re-implementing the pattern in every test file.

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/core/config.js";
import { openDb } from "../src/db/store.js";

/**
 * Creates a temp git repo with an initial commit, runs fn with its path,
 * and always cleans up. Used by MCP tests that need real git facts.
 */
export function withTempRepo(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "fapony-repo-"));
  try {
    execSync("git init", { cwd: dir, stdio: "ignore" });
    execSync("git config user.email 'test@test.com'", {
      cwd: dir,
      stdio: "ignore",
    });
    execSync("git config user.name 'Test'", { cwd: dir, stdio: "ignore" });
    writeFileSync(join(dir, "README.md"), "# test repo\n");
    execSync("git add .", { cwd: dir, stdio: "ignore" });
    execSync('git commit -m "init"', { cwd: dir, stdio: "ignore" });
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Run fn with a fresh temp dir standing in for a user's home directory, then
 * remove it. Used by tests that exercise code reading/writing `~/.<client>/…`
 * (installers, detect) without touching the real home.
 */
export function withTempHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "fapony-home-"));
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** Write obj as pretty JSON with a trailing newline — config/fixture files. */
export function writeJson(path: string, obj: unknown): void {
  writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`);
}

/**
 * Run fn with console.error captured; returns the joined lines. Nothing is
 * printed. Restores the original console.error even if fn throws.
 */
export function captureErrors(fn: () => void): string {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  };
  try {
    fn();
  } finally {
    console.error = orig;
  }
  return lines.join("\n");
}

/**
 * Run fn with an isolated temp db. The db is opened before fn and closed
 * after; FAPONY_STATE_DIR is set to a fresh temp dir and restored on return.
 * Temp dir is always cleaned up.
 */
export function withTmpDb<T>(fn: (db: ReturnType<typeof openDb>) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "fapony-test-"));
  const orig = process.env.FAPONY_STATE_DIR;
  process.env.FAPONY_STATE_DIR = dir;
  try {
    const db = openDb();
    const result = fn(db);
    db.close();
    return result;
  } finally {
    if (orig === undefined) delete process.env.FAPONY_STATE_DIR;
    else process.env.FAPONY_STATE_DIR = orig;
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Minimal config for testing — no memory, no roles, default review.
 * Spread-add fields as needed: `{ ...baseConfig(), roles: { ... } }`.
 */
export function baseConfig(): Config {
  return {
    worktrees: { test: "/tmp/test" },
    review: {
      maxRounds: 2,
    },
    memory: null,
  };
}

/**
 * Run fn with console.log captured; returns the joined lines. Nothing is
 * printed. Restores the original console.log even if fn throws.
 */
export function captureLogs(fn: () => void): string {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  };
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return lines.join("\n");
}

/**
 * Run fn with console.error suppressed.
 */
export function silentErrors<T>(fn: () => T): T {
  const orig = console.error;
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.error = orig;
  }
}

/**
 * Run fn with a temp FAPONY_CONFIG file. The config object is serialized
 * to JSON, FAPONY_CONFIG points at it for the duration of fn, then the
 * env is restored and the file removed.
 */
export function withTempConfig(configObj: unknown, fn: () => void): void {
  const cfgPath = join(
    tmpdir(),
    `fapony-test-cfg-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`,
  );
  writeFileSync(cfgPath, JSON.stringify(configObj));
  const prevConfig = process.env.FAPONY_CONFIG;
  process.env.FAPONY_CONFIG = cfgPath;
  try {
    fn();
  } finally {
    if (prevConfig === undefined) delete process.env.FAPONY_CONFIG;
    else process.env.FAPONY_CONFIG = prevConfig;
    rmSync(cfgPath, { force: true });
  }
}

/** One row as `fael find --json` prints it (fael's shape, not MemRow). */
export interface FaelFixtureRow {
  id: string;
  ts: string;
  kind: string;
  text: string;
  by?: string;
  files?: string[];
  spec?: string;
  key?: string;
  closed?: { id: string; ts: string; by: string; text: string };
}

/**
 * Run fn with a fake `fael` first on PATH — it prints whatever `setRows` last
 * wrote, for any subcommand. Keeps tests off the real binary and the real
 * .fael/ log. Handles async fn; PATH is restored when it settles.
 */
export function withFakeFael<T>(
  fn: (setRows: (rows: (FaelFixtureRow | string)[]) => void) => T,
): T {
  const bin = mkdtempSync(join(tmpdir(), "fapony-fake-fael-"));
  const rowsPath = join(bin, "rows.jsonl");
  writeFileSync(rowsPath, "");
  writeFileSync(join(bin, "fael"), `#!/bin/sh\ncat "${rowsPath}"\n`, {
    mode: 0o755,
  });
  // A string row is written raw (malformed-line fixtures).
  const setRows = (rows: (FaelFixtureRow | string)[]): void =>
    writeFileSync(
      rowsPath,
      rows
        .map((r) =>
          typeof r === "string" ? r : JSON.stringify({ by: "t", ...r }),
        )
        .join("\n"),
    );
  const origPath = process.env.PATH;
  process.env.PATH = `${bin}:${origPath ?? ""}`;
  const restore = (): void => {
    process.env.PATH = origPath;
    rmSync(bin, { recursive: true, force: true });
  };
  let out: T;
  try {
    out = fn(setRows);
  } catch (e) {
    restore();
    throw e;
  }
  if (out instanceof Promise) {
    return out.finally(restore) as T;
  }
  restore();
  return out;
}
