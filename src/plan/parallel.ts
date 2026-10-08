// src/plan/parallel.ts — which open chunk a session should take when one plan
// runs in several worktrees at once.
//
// The plan dir is shared across worktrees (a symlinked .fapony/), so a tick or
// a claim written in one worktree is visible in the other at once — no merge
// to wait for. Three markers on a TL;DR chunk line carry what a picker needs:
//   (wip <branch>)        a session took this chunk — others skip it
//   (wait <what>)         a person must act first (a page approved, a sample
//                         sent) — no session takes it; it still holds the
//                         chunks after it like any open chunk
//   (after 2) / (after —) what it waits on; no marker = the chunk before it
// Defaults keep every existing plan behaving as before: with no markers the
// first open chunk is next and nothing runs alongside it.

import type { MemRow } from "../fael.js";
import { chunkLabel } from "./sweep.js";

const WIP_RE = /\(wip\b\s*([^)]*)\)/i;
// a chunk waiting on a person read as `next` sent agents to stall on it — in
// vela 26 open chunks said "รอ … approved" in prose the picker cannot read
const WAIT_RE = /\(wait\b\s*([^)]*)\)/i;
const AFTER_RE = /\(after\s+([^)]*)\)/i;
// ponytail: file names are read from the chunk line only (an extension list,
// not a parser) — a chunk that names no file can't be checked for overlap.
const FILE_RE =
  /[\w./-]*\w\.(?:ts|tsx|js|jsx|mjs|rs|py|go|sql|json|toml|ya?ml|md)\b/g;

export interface Picked {
  /** index into `items` of the chunk this session takes, -1 = none ready */
  next: number;
  /** chunks another session claimed */
  wip: { at: number; branch: string }[];
  /** chunks marked `(wait …)` — a person acts first, no session takes them */
  waiting: { at: number; why: string }[];
  /** ready chunks that may run in another worktree, with any shared files */
  alongside: { at: number; shared: string[] }[];
  /** why `next` is -1: the chunk(s) the first open one waits on */
  waitsOn: string[];
}

const files = (s: string): string[] => [...new Set(s.match(FILE_RE) ?? [])];

/** `items` = the TL;DR checkbox lines in order, `- [ ]`/`- [x]` kept. */
export function pickChunks(items: string[], branch: string | null): Picked {
  const open = (l: string) => /^\s*[-*]\s+\[\s\]/.test(l);
  const label = (l: string) => chunkLabel(l)?.toLowerCase() ?? null;
  const closed = new Set(
    items
      .filter((l) => !open(l))
      .map(label)
      .filter(Boolean),
  );
  const waits = (i: number): string[] => {
    const m = AFTER_RE.exec(items[i]);
    if (!m)
      return i > 0 && open(items[i - 1]) ? [label(items[i - 1]) ?? "?"] : [];
    return m[1]
      .split(/[,\s]+/)
      .map((t) => t.replace(/^chunk-?/i, "").toLowerCase())
      .filter((t) => t && !/^(—|-|none)$/.test(t) && !closed.has(t));
  };

  const wip: Picked["wip"] = [];
  const waiting: Picked["waiting"] = [];
  const ready: number[] = [];
  let mine = -1;
  let waitsOn: string[] = [];
  items.forEach((l, i) => {
    if (!open(l)) return;
    const claim = WIP_RE.exec(l);
    if (claim) {
      const b = claim[1].trim();
      // a claim with this session's branch (or none) is this session's chunk
      if (mine < 0 && (!b || b === branch)) mine = i;
      else wip.push({ at: i, branch: b || "?" });
      return;
    }
    const held = WAIT_RE.exec(l);
    if (held) {
      waiting.push({ at: i, why: held[1].trim() || "?" });
      if (!waitsOn.length && !ready.length) waitsOn = [label(l) ?? "?"];
      return;
    }
    const w = waits(i);
    if (w.length === 0) ready.push(i);
    else if (!waitsOn.length && !ready.length) waitsOn = w;
  });

  const next = mine >= 0 ? mine : (ready.shift() ?? -1);
  const busy = [next, ...wip.map((w) => w.at)].filter((i) => i >= 0);
  const busyFiles = new Set(busy.flatMap((i) => files(items[i])));
  return {
    next,
    wip,
    waiting,
    alongside: ready
      .filter((i) => i !== next)
      .map((at) => ({
        at,
        shared: files(items[at]).filter((f) => busyFiles.has(f)),
      })),
    waitsOn: next >= 0 ? [] : waitsOn,
  };
}

/** Open chunk lines another session has claimed with `(wip …)`. */
export const claimedChunks = (items: string[]): string[] =>
  items.filter((l) => /^\s*[-*]\s+\[\s\]/.test(l) && WIP_RE.test(l));

// A handoff written under a key `fapony plan` never reads is lost to the next
// session — an agent wrote `vela:registry:handoff` for plan:vela-registry.
// Same plan, wrong spelling: strip `plan:`, `:` → `-`, compare names.
// chunk-<label> has the LABEL shape (k6, 3, 4b) — `workflow:chunk-batching` is a topic
const HANDOFF_KEY_RE = /^(.+):(handoff|chunk-[a-z]{0,3}\d[a-z0-9]*)$/i;
const keyPlan = (key: string): string | null => {
  const m = HANDOFF_KEY_RE.exec(key);
  return m
    ? m[1]
        .replace(/^plan:/i, "")
        .replace(/:/g, "-")
        .toLowerCase()
    : null;
};

// A handoff is a note (CLAUDE.md: `fael add note … --key plan:x:handoff`); a
// decision keyed `plan:handoff` is a record, and "re-file it as a note" is
// advice that cannot apply — only notes are checked for spelling.
const isNote = (r: MemRow): boolean => r.kind === "note";

/** Open notes whose handoff key means plan `name` but is not spelt plan:<name>:… */
export const misfiledHandoffs = (rows: MemRow[], name: string): MemRow[] =>
  rows.filter(
    (r) =>
      isNote(r) &&
      !!r.key &&
      keyPlan(r.key) === name &&
      !r.key.toLowerCase().startsWith(`plan:${name}:`),
  );

/** Open handoff-shaped note keys that name no plan in plan/, done/ or parked/. */
export const orphanHandoffKeys = (
  rows: MemRow[],
  names: string[],
): string[] => {
  const known = new Set(names);
  return [
    ...new Set(
      rows
        .filter(isNote)
        .map((r) => r.key ?? "")
        .filter((k) => {
          const n = keyPlan(k);
          return n !== null && !known.has(n);
        }),
    ),
  ];
};
