// src/plan/fix.ts — `fapony plan check --fix`: repair plan state that has
// exactly one right answer. Zero or several candidates = leave it, `plan check`
// reports it. Writes only here (rule 4: read-only commands stay read-only).

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";

import { doneDir, planBase, planDir, rel, root, writeAtomic } from "./store.js";
import {
  checkTickedLine,
  defaultBranch,
  defaultLog,
  gitOut,
  isOnDefault,
  mdFiles,
  TICK_RE,
} from "./sweep.js";

// ponytail: recent 300 commits of the default branch, add a cap knob when a plan outlives it
const PATCH_ID_WINDOW = 300;

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

// the default branch's recent patch-ids, read once per run — one --fix can
// ask for every squashed tick in plan/ + done/
let window: string[][] | null = null;

/** Commits on the default branch standing in for `sha` (squashed): same
 *  subject + ` (#N)`, else same patch-id. Caller repoints only on length 1.
 *  A squash of `sha` comes after it — an ancestor or an older commit is a
 *  namesake ("chore: lint (#5)" vs a live branch's own "chore: lint"). */
export const squashSuccessors = (sha: string): string[] => {
  const base = defaultBranch(root);
  if (!base) return [];
  const at = (c: string) =>
    Number(gitOut(["log", "-1", "--format=%ct", c], root));
  const since = at(sha);
  const after = (c: string) =>
    at(c) >= since &&
    Bun.spawnSync(["git", "merge-base", "--is-ancestor", c, sha], {
      cwd: root,
    }).exitCode !== 0;
  const subject = gitOut(["log", "-1", "--format=%s", sha], root);
  const bySubject = subject
    ? defaultLog(root)
        .filter((l) => {
          const s = l.slice(l.indexOf(" ") + 1);
          return (
            s.startsWith(subject) && /^ \(#\d+\)$/.test(s.slice(subject.length))
          );
        })
        .map((l) => l.slice(0, l.indexOf(" ")))
        .filter(after)
    : [];
  if (bySubject.length === 1) return bySubject;
  const mine = patchIds(gitOut(["show", sha], root))[0]?.[0];
  window ??= patchIds(
    gitOut(["log", "-p", `-n${PATCH_ID_WINDOW}`, base, "--"], root),
  );
  const byPatch = mine
    ? window
        .filter(([id]) => id === mine)
        .map(([, c]) => c)
        .filter(after)
    : [];
  return byPatch.length === 1
    ? byPatch
    : [...new Set([...bySubject, ...byPatch])];
};

// Every tick not on the default branch is a candidate — readiness asks for the
// default branch, so a squashed commit whose branch still lives (worktree not
// pruned) needs repointing as much as one no ref holds. A tick on a live
// branch with no successor is work in flight: silent. Only a lost one reports.
const fixTicks = (files: string[]): string[] => {
  const out: string[] = [];
  for (const f of files) {
    const edits = new Map<string, { to: string; notes: string[] }>();
    readFileSync(f, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (!TICK_RE.test(line)) return;
        const offMain = checkTickedLine(line, root, isOnDefault).diverged;
        if (!offMain.length) return;
        const lost = new Set(checkTickedLine(line, root).diverged);
        let to = line;
        const notes: string[] = [];
        for (const sha of offMain) {
          const found = squashSuccessors(sha);
          if (found.length !== 1) {
            if (lost.has(sha))
              out.push(
                `${rel(f)}:${i + 1} — ${sha}: ${found.length ? `${found.length} candidates (${found.map((c) => c.slice(0, 7)).join(", ")})` : "no commit on the default branch matches"} — not changed`,
              );
            continue;
          }
          const next = gitOut(
            ["rev-parse", `--short=${Math.max(7, sha.length)}`, found[0]],
            root,
          );
          to = to.replace(new RegExp(`(?<![0-9a-f])${sha}(?![0-9a-f])`), next);
          notes.push(
            `${rel(f)}:${i + 1} — tick ${sha} → ${next} (squash commit)`,
          );
        }
        if (to !== line) edits.set(line, { to, notes });
      });
    if (!edits.size) continue;
    // squashSuccessors is slow git work — another agent may have ticked a
    // chunk meanwhile, so apply the edits to the file as it is now
    const now = readFileSync(f, "utf8").split("\n");
    const applied = new Set<string>();
    const next = now.map((l) => {
      const e = edits.get(l);
      if (!e) return l;
      applied.add(l);
      return e.to;
    });
    if (applied.size) writeAtomic(f, next.join("\n"));
    for (const [line, e] of edits)
      out.push(
        ...(applied.has(line)
          ? e.notes
          : [`${rel(f)} — a tick line changed while --fix ran — rerun --fix`]),
      );
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
