// src/adapters/hooks/compute-hint-impact.ts — hint-fire impact computation
//
// Split from src/hook.ts (PLAN-lib-layer chunk 3). Reads the hint log and
// counts fires per surface.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type HintFireRow,
  type HintImpact,
  hintLogDir,
  worktreeKey,
} from "../../core/hint-log.js";

/**
 * Compute hint-fire impact from the log. `since` is an ISO date string;
 * omit to scan all rows. `worktree` scopes to one project's log file.
 */
export function computeHintImpact(
  since?: string,
  worktree?: string,
): HintImpact {
  const dir = hintLogDir();
  const impact: HintImpact = {
    fired: 0,
    by_surface: {
      read: 0,
      debt: 0,
      mem: 0,
      commit: 0,
      edit: 0,
      "open-bug": 0,
      "handoff-would-block": 0,
      "handoff-pass": 0,
      "commit-block": 0,
      "bug-block": 0,
    },
    window: since ?? null,
  };

  if (!existsSync(dir)) return impact;

  let files: string[];
  try {
    const all = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    files = worktree
      ? all.filter((f) => f === `${worktreeKey(worktree)}.jsonl`)
      : all;
  } catch {
    return impact;
  }

  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(join(dir, file), "utf-8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      if (!line) continue;
      let row: HintFireRow;
      try {
        row = JSON.parse(line) as HintFireRow;
      } catch {
        continue;
      }
      if (since && row.ts < since) continue;
      impact.fired++;
      impact.by_surface[row.surface]++;
    }
  }

  return impact;
}
