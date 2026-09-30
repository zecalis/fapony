// src/plan/fix.ts — `fapony plan check --fix`: repair plan state that has
// exactly one right answer. Zero or several candidates = leave it, `plan check`
// reports it. Writes only here (rule 4: read-only commands stay read-only).

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";

import { doneDir, planBase, planDir, rel, root } from "./store.js";
import { checkTickedLine, defaultBranch, gitOut, mdFiles } from "./sweep.js";

// ponytail: recent 300 commits of the default branch, add a cap knob when a plan outlives it
const PATCH_ID_WINDOW = 300;

// tmp-then-rename: two agents share one .fapony/, a reader never sees half a file
const writeAtomic = (file: string, text: string): void => {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
};

const patchIds = (diff: string): string[][] => {
  const p = Bun.spawnSync(["git", "patch-id", "--stable"], {
    cwd: root,
    stdin: new TextEncoder().encode(diff),
    stdout: "pipe",
    stderr: "ignore",
  });
  return p.stdout
    .toString()
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split(" "));
};

/** Commits on the default branch standing in for `sha` (squashed, branch gone):
 *  same subject + ` (#N)`, else same patch-id. Caller repoints only on length 1. */
export const squashSuccessors = (sha: string): string[] => {
  const base = defaultBranch(root);
  if (!base) return [];
  const subject = gitOut(["log", "-1", "--format=%s", sha], root);
  const bySubject = subject
    ? gitOut(["log", base, "--format=%H %s"], root)
        .split("\n")
        .filter((l) => /^ \(#\d+\)$/.test(l.slice(41 + subject.length)))
        .filter((l) => l.slice(41, 41 + subject.length) === subject)
        .map((l) => l.slice(0, 40))
    : [];
  if (bySubject.length === 1) return bySubject;
  const mine = patchIds(gitOut(["show", sha], root))[0]?.[0];
  const byPatch = mine
    ? patchIds(gitOut(["log", "-p", `-n${PATCH_ID_WINDOW}`, base], root))
        .filter(([id]) => id === mine)
        .map(([, c]) => c)
    : [];
  return byPatch.length === 1
    ? byPatch
    : [...new Set([...bySubject, ...byPatch])];
};

const fixTicks = (files: string[]): string[] => {
  const out: string[] = [];
  for (const f of files) {
    const lines = readFileSync(f, "utf8").split("\n");
    let changed = false;
    lines.forEach((line, i) => {
      if (!/^\s*-\s\[x\]/.test(line)) return;
      for (const sha of checkTickedLine(line, root).diverged) {
        const found = squashSuccessors(sha);
        if (found.length !== 1) {
          out.push(
            `${rel(f)}:${i + 1} — ${sha}: ${found.length ? `${found.length} candidates (${found.map((c) => c.slice(0, 7)).join(", ")})` : "no commit on the default branch matches"} — not changed`,
          );
          continue;
        }
        const next = gitOut(
          ["rev-parse", `--short=${Math.max(7, sha.length)}`, found[0]],
          root,
        );
        lines[i] = lines[i].replace(
          new RegExp(`(?<![0-9a-f])${sha}(?![0-9a-f])`),
          next,
        );
        changed = true;
        out.push(`${rel(f)}:${i + 1} — tick ${sha} → ${next} (squash commit)`);
      }
    });
    if (changed) writeAtomic(f, lines.join("\n"));
  }
  return out;
};

// [text](…/PLAN-x.md) whose target is gone but PLAN-x.md exists in exactly one
// place under .fapony/ (moved plan/ ↔ done/). Fenced/inline code is left alone.
const fixLinks = (): string[] => {
  const where = new Map<string, string[]>();
  for (const f of mdFiles(planBase))
    if (/^PLAN-.*\.md$/.test(basename(f)))
      where.set(basename(f), [...(where.get(basename(f)) ?? []), f]);
  const out: string[] = [];
  for (const f of mdFiles(planBase)) {
    const src = readFileSync(f, "utf8");
    const masked = src
      .replace(/```[\s\S]*?```/g, (b) => b.replace(/[^\n]/g, " "))
      .replace(/`[^`\n]*`/g, (b) => " ".repeat(b.length));
    const edits: { at: number; from: string; to: string }[] = [];
    for (const m of masked.matchAll(/\]\(([^)#]+)(#[^)]*)?\)/g)) {
      const target = m[1];
      const name = basename(target);
      const hit = where.get(name);
      if (
        /^(https?:|mailto:|file:|\/)/.test(target) ||
        hit?.length !== 1 ||
        existsSync(resolve(dirname(f), target))
      )
        continue;
      edits.push({
        at: m.index + 2,
        from: target,
        to: relative(dirname(f), hit[0]),
      });
    }
    if (!edits.length) continue;
    let next = src;
    for (const e of edits.reverse())
      next = next.slice(0, e.at) + e.to + next.slice(e.at + e.from.length);
    writeAtomic(f, next);
    for (const e of edits.reverse())
      out.push(`${rel(f)} — link ${e.from} → ${e.to}`);
  }
  return out;
};

export const fixPlanState = (): void => {
  const files = [...new Set([...mdFiles(planDir), ...mdFiles(doneDir)])];
  const done = [...fixTicks(files), ...fixLinks()];
  console.log(
    done.length
      ? `--fix: ${done.length} line(s)\n${done.map((d) => `  ${d}`).join("\n")}\n`
      : "--fix: nothing to repair\n",
  );
};
