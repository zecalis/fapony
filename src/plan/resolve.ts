// src/plan/resolve.ts — one answer to "which plan file did the user mean" for
// `fapony plan` and `fapony plan sweep`, plus "which docs mention this path".
//
// fapony owns the plan half of the workflow, so nothing here goes through
// fael: `plan:x` / `plan:x:chunk-3` are just spellings of PLAN-x.md.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { doneDir, planBase, planDir, root } from "./store.js";

export type Resolved =
  | { ok: true; file: string; chunk: string | null }
  // candidates empty = nothing matches; ≥2 = ambiguous, never picked for you
  | { ok: false; candidates: string[] };

// PLAN-x.md → "x"; any other doc in plan/ (adopted) → its stem.
const stemOf = (file: string): string =>
  (
    /^PLAN-(.+)\.md$/i.exec(file)?.[1] ?? file.replace(/\.md$/i, "")
  ).toLowerCase();

const listDocs = (): { file: string; key: string }[] =>
  [planDir, doneDir].flatMap((dir) => {
    try {
      return readdirSync(dir)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .map((f) => ({ file: join(dir, f), key: stemOf(f) }));
    } catch {
      return []; // dir missing
    }
  });

/** PLAN-x.md · PLAN-x · x · plan:x · plan:x:handoff · plan:x:chunk-3 · any path · a unique
 *  substring. plan/ wins over done/ on an exact name. */
export const resolvePlan = (arg: string): Resolved => {
  const direct = [resolve(arg), join(root, arg)].find(
    (p) => p.endsWith(".md") && existsSync(p),
  );
  if (direct) return { ok: true, file: direct, chunk: null };

  const m = /^(?:plan:)?(.+?)(?::chunk-(\d+)|:handoff)?$/i.exec(arg.trim());
  const name = (m?.[1] ?? arg)
    .replace(/\.md$/i, "")
    .replace(/^PLAN-/i, "")
    .toLowerCase();
  const docs = listDocs();
  const hits = docs.some((d) => d.key === name)
    ? docs.filter((d) => d.key === name).slice(0, 1)
    : docs.filter((d) => d.key.includes(name));
  if (hits.length === 1)
    return { ok: true, file: hits[0].file, chunk: m?.[2] ?? null };
  return { ok: false, candidates: hits.map((d) => basename(d.file)) };
};

export type Mention = {
  label: string;
  name: string;
  title: string;
  shipped: string;
};

/** Docs in `dirs` whose body contains any of `keys` (paths). Headers only —
 *  title + shipped date; the body is the reading task this exists to avoid. */
export const findMentions = (
  dirs: { abs: string; label: string }[],
  keys: string[],
): Mention[] => {
  const hits: Mention[] = [];
  for (const { abs, label } of dirs) {
    let names: string[];
    try {
      names = readdirSync(abs)
        .filter((n) => n.endsWith(".md"))
        .sort();
    } catch {
      continue; // dir missing — a repo without shipped plans yet
    }
    for (const n of names) {
      let content: string;
      try {
        content = readFileSync(join(abs, n), "utf-8");
      } catch {
        continue;
      }
      if (!keys.some((k) => content.includes(k))) continue;
      // The H1 usually repeats the filename ("PLAN-x.md — real title") and
      // the filename is already the link text — keep only what it adds.
      const title = (content.match(/^#\s+(.+)$/m)?.[1] ?? n)
        .trim()
        .replace(/^(?:PLAN|SPEC)-[\w.-]+\s+[—-]\s+/, "");
      const shipped = content.match(/shipped\s+(\d{4}-\d{2}-\d{2})/)?.[1] ?? "";
      hits.push({ label, name: n, title, shipped });
    }
  }
  return hits;
};

/** `fapony plan --files a,b` — active plans first, then done/, then specs. */
export const mentionsOfFiles = (files: string[]): Mention[] =>
  findMentions(
    [
      { abs: planDir, label: "plan" },
      { abs: doneDir, label: "done" },
      { abs: join(planBase, "spec"), label: "spec" },
    ],
    files,
  );
