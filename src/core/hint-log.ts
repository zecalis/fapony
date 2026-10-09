// src/core/hint-log.ts — hint-fire log path + write + types (pure, no feature imports)
//
// Extracted from src/hook.ts (PLAN-lib-layer chunk 2a) to break the
// digest→hook coupling. computeHintImpact lives in adapters/hooks/.

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HINT_LOG_DIR = "hint-log";

/** Stable filename key from an absolute worktree path. */
export function worktreeKey(worktree: string): string {
  return worktree.replace(/^\/+/, "").replace(/\//g, "--");
}

/** Directory holding one hint-fire log file per worktree. */
export function hintLogDir(): string {
  const base =
    process.env.FAPONY_STATE_DIR || join(homedir(), ".config", "fapony");
  return join(base, HINT_LOG_DIR);
}

/** Absolute path of a worktree's hint-fire log — may not exist. */
export function hintLogPath(worktree: string): string {
  return join(hintLogDir(), `${worktreeKey(worktree)}.jsonl`);
}

export interface HintFireRow {
  ts: string;
  worktree: string;
  surface:
    | "read"
    | "debt"
    | "mem"
    | "commit"
    | "edit"
    | "open-bug"
    | "handoff-would-block"
    | "handoff-pass"
    | "commit-block"
    | "bug-block";
  file: string | null;
  count: number;
  ids?: string[];
}

/**
 * Append a hint-fire log row. Best-effort: never throws, never blocks.
 * Uses $FAPONY_STATE_DIR when set (tests, CI), otherwise ~/.config/fapony.
 */
export function recordHintFire(row: HintFireRow): void {
  try {
    const dir = hintLogDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(
      hintLogPath(row.worktree),
      `${JSON.stringify(row)}\n`,
      "utf-8",
    );
  } catch {
    // best-effort — swallow
  }
}

export interface HintImpact {
  fired: number;
  by_surface: {
    read: number;
    debt: number;
    mem: number;
    commit: number;
    edit: number;
    "open-bug": number;
    "handoff-would-block": number;
    "handoff-pass": number;
    "commit-block": number;
    "bug-block": number;
  };
  window: string | null;
}
