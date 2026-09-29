// src/plan/sweep.ts — `fapony plan sweep` + `fapony plan check`.
// sweep: find PLAN-*.md whose header says shipped but not yet moved into done/
// rationale: moving by hand = chasing relative links yourself (in the file + files that link to it) → the step gets skipped often
// no arg = report only (safe, shows every kickoff/stale run)
// <file.md> = check a single file, is it ready to move
// <file.md> --apply = git mv + fix markdown links inside the file + fix inbound links from every .md under .fapony/
//                      (plan/ + done/ + spec/) + warn about plain-text mentions (detect-only, no auto-fix)
//                      + warn about tracked files outside .fapony/ that mention the filename (detect-only)

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

import { type MemRow, readFaelLog } from "../fael.js";
import { slugify } from "./adopt.js";
import { doneDir, planBase, planDir, rel, root } from "./store.js";

/** PLAN-<name>.md → "<name>" lowercased — the fael anchor/key form
 *  (`plan:<name>`; fael stores anchors lowercase, keys are [a-z0-9._-]). */
export const planKeyName = (planPath: string): string | null =>
  /^PLAN-(.+)\.md$/i.exec(basename(planPath))?.[1].toLowerCase() ?? null;

// Open fael rows about a plan — one fael call per run, then matched in TS on
// any of the three ways a row can name the plan:
//   files[]/spec basename = PLAN-x.md  (path rows; survives plan/ → done/)
//   files[] has the anchor  plan:<name> or plan:<name>:* (anchor rows)
//   key = plan:<name> or starts with plan:<name>:  (plan:<name>:chunk-N)
// A files[] entry of plan:<name>:chunk-N names the plan just as a key of the
// same shape does — exact-only on files[] slipped those rows out.
let openCache: { root: string; rows: MemRow[] } | null = null;
let allCache: { root: string; rows: MemRow[] } | null = null;
const allRows = (): MemRow[] => {
  if (allCache?.root !== root)
    allCache = { root, rows: readFaelLog(root, undefined, false).rows };
  return allCache.rows;
};
export const openRowsFor = (planPath: string): MemRow[] => {
  if (openCache?.root !== root)
    openCache = { root, rows: readFaelLog(root, undefined, true).rows };
  const file = basename(planPath);
  const name = planKeyName(planPath);
  const anchor = name ? `plan:${name}` : null;
  return openCache.rows.filter(
    (r) =>
      [...(r.files ?? []), r.spec ?? ""].some((f) => {
        const fl = f.toLowerCase();
        return (
          basename(f) === file ||
          (!!anchor && (fl === anchor || fl.startsWith(`${anchor}:`)))
        );
      }) ||
      (!!anchor &&
        !!r.key &&
        (r.key === anchor || r.key.startsWith(`${anchor}:`))),
  );
};

// Closing-ceremony handoffs — open `plan:<name>:*` rows by anchor key, any
// kind. Handoff notes (`fael add note --key plan:<name>:chunk-N`) are the
// plan's unfinished work, but the pre-move check used to filter kind:"bug"
// only, so they never blocked. Consulted from the --all rows with closes
// applied locally (newest per key wins, closed ids out) instead of fael's
// open filter, which the anchor-only rows can slip out of.
export const openHandoffRowsFor = (planPath: string): MemRow[] => {
  const name = planKeyName(planPath);
  if (!name) return [];
  const prefix = `plan:${name}:`;
  const rows = allRows();
  const closed = new Set(
    rows.filter((r) => r.kind === "close" && r.ref).map((r) => r.ref as string),
  );
  const byKey = new Map<string, MemRow>();
  for (const r of rows) {
    if (!r.key?.startsWith(prefix)) continue;
    const cur = byKey.get(r.key);
    if (!cur || (r.ts ?? "") >= (cur.ts ?? "")) byKey.set(r.key, r);
  }
  return [...byKey.values()].filter(
    (r) => r.kind !== "close" && (r.id == null || !closed.has(r.id)),
  );
};

const SHIPPED = /^>\s*✅/m;
const FRONT = /^---\r?\n([\s\S]*?)\r?\n---/;
const HELD = /^status:\s*(blocked|superseded)\b/m;
const PLAN_REF_RE = /\bPLAN-[\w-]+\.md\b/g;

export type PlanFrontmatter = {
  status: string | null;
  kind: string | null;
  blockedByRaw: string | null;
  blocksRaw: string | null;
  supersededBy: string | null;
};

// frontmatter is the only dep-graph source — no new schema, parse what agents
// already write per templates/PLAN.md (keys EN, values EN). Sentence values
// ("waiting on support email") carry no PLAN-*.md token and are skipped by
// the file checks, never flagged.
export const parsePlanFrontmatter = (file: string): PlanFrontmatter => {
  const out: PlanFrontmatter = {
    status: null,
    kind: null,
    blockedByRaw: null,
    blocksRaw: null,
    supersededBy: null,
  };
  try {
    const head = readFileSync(file, "utf8").slice(0, 4096);
    const m = FRONT.exec(head);
    if (!m) return out;
    for (const line of m[1].split("\n")) {
      const kv =
        /^\s*(status|kind|blocked_by|blocks|superseded_by)\s*:\s*(.+?)\s*$/.exec(
          line,
        );
      if (!kv) continue;
      const v = kv[2].trim() || null;
      if (kv[1] === "status") out.status = v;
      else if (kv[1] === "kind") out.kind = v;
      else if (kv[1] === "blocked_by") out.blockedByRaw = v;
      else if (kv[1] === "blocks") out.blocksRaw = v;
      else out.supersededBy = v;
    }
  } catch {
    // unreadable file — callers treat nulls as "no frontmatter"
  }
  return out;
};

// every PLAN-*.md token inside the raw value (comma list or a sentence that
// names a plan). Deduped basenames — resolution tries planDir then doneDir.
export const extractPlanRefs = (raw: string | null): string[] => {
  if (!raw) return [];
  return [...new Set(raw.match(PLAN_REF_RE) ?? [])].map((p) => basename(p));
};

export const planLocation = (base: string): "plan" | "done" | null => {
  try {
    if (existsSync(join(planDir, base))) return "plan";
    if (existsSync(join(doneDir, base))) return "done";
  } catch {
    // planDir/doneDir uninitialised in unit context — treat as unknown
  }
  return null;
};

// checkbox tally of the first ## section only — same contract as kickoff's
// readPlanSectionItems (kept local: read.ts imports from this file, so an
// import back would be a cycle). Counts only, no text.
export const countFirstSection = (
  file: string,
): { checked: number; unchecked: number } => {
  try {
    const text = readFileSync(file, "utf8");
    const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---/, "");
    const start = body.search(/^##\s+/m);
    if (start < 0) return { checked: 0, unchecked: 0 };
    const rest = body.slice(start);
    const next = rest.slice(3).search(/^##\s+/m);
    const block = next < 0 ? rest : rest.slice(0, next + 3);
    let checked = 0;
    let unchecked = 0;
    for (const line of block.split("\n")) {
      if (/^\s*[-*]\s+\[\s\]\s+.+$/.test(line)) unchecked++;
      else if (/^\s*[-*]\s+\[[xX]\]\s+.+$/.test(line)) checked++;
    }
    return { checked, unchecked };
  } catch {
    return { checked: 0, unchecked: 0 };
  }
};

// dep-graph issues over active plan files: dangling blocked_by/blocks refs,
// "blocker shipped but dependent still blocked", and cycles. Pure (no
// console/exit) so tests call it directly; cmdPlanCheck prints what it returns.
export const collectDepIssues = (active: string[]): string[] => {
  const issues: string[] = [];
  const activeBases = new Set(active.map((f) => basename(f)));
  // waiter -> blocker edges among active files only (done/ blockers are the
  // unblocked-ready case above, not a cycle).
  const edges = new Map<string, string[]>();

  for (const f of active) {
    const relPath = relative(planBase, f);
    const fm = parsePlanFrontmatter(f);
    const base = basename(f);

    for (const ref of extractPlanRefs(fm.blockedByRaw)) {
      const loc = planLocation(ref);
      if (!loc) {
        issues.push(
          `${relPath} — blocked_by points at ${ref} but no such file is in plan/ or done/\n   fix: correct the filename or keep blocked_by as a plain sentence`,
        );
      } else if (loc === "done") {
        issues.push(
          `${relPath} — blocker ${ref} already shipped to done/ but this plan is still status:blocked\n   fix: clear status:blocked or tick the remaining chunk`,
        );
      }
      if (activeBases.has(ref)) {
        if (!edges.has(base)) edges.set(base, []);
        edges.get(base)?.push(ref);
      }
    }

    for (const ref of extractPlanRefs(fm.blocksRaw)) {
      const loc = planLocation(ref);
      if (!loc) {
        issues.push(
          `${relPath} — blocks points at ${ref} but no such file is in plan/ or done/\n   fix: correct the filename or drop it`,
        );
      }
      // "F blocks G" = G waits on F → edge G -> F for cycle detection.
      if (activeBases.has(ref)) {
        if (!edges.has(ref)) edges.set(ref, []);
        edges.get(ref)?.push(base);
      }
    }
  }

  // DFS cycle detection over the active-only edges.
  const state = new Map<string, number>(); // 1 = on stack, 2 = done
  const stack: string[] = [];
  const visit = (n: string) => {
    state.set(n, 1);
    stack.push(n);
    for (const t of edges.get(n) ?? []) {
      if (state.get(t) === 1) {
        const cyc = [...stack.slice(stack.indexOf(t)), t].join(" → ");
        issues.push(
          `cycle: ${cyc} — plans wait on each other, nothing can unblock\n   fix: drop one side of the blocked_by/blocks link`,
        );
        continue;
      }
      if (!state.get(t)) visit(t);
    }
    stack.pop();
    state.set(n, 2);
  };
  for (const n of edges.keys()) if (!state.get(n)) visit(n);

  return issues;
};

// W1: status header says not-started but chunks are ticked.
// W2: all chunks ticked but header never marked shipped.
// WARN-level only — counted separately from issues, never changes exit code.
//
// Vocab measured from .fapony/{plan,done}/*.md (2026-09-23):
//   in-progress 8 · done 4 · shipped/✅ shipped 6 · draft 1
//   frontmatter status: shipped 8 · blocked 2
const NOT_STARTED =
  /(?:^|\n)>\s*\*?\*?Status:?\*?\*?\s+.*(?:draft|drafted|not[\s-]started)/i;
const SHIPPED_RE =
  /(?:^|\n)>\s*✅|(?:^|\n)>\s*\*?\*?Status:?\*?\*?\s+.*(?:shipped|done)/i;
const FM_SHIPPED = /^status:\s*shipped\b/m;

export const collectDriftWarns = (active: string[]): string[] => {
  const warns: string[] = [];
  for (const f of active) {
    const fm = parsePlanFrontmatter(f);
    // Skip plans whose frontmatter already says shipped/blocked/superseded or
    // is a tracker — these have their own handling elsewhere.
    if (FM_SHIPPED.test("") && fm.status === "shipped") continue;
    if (fm.status === "blocked" || fm.status === "superseded") continue;
    if (fm.kind === "tracker") continue;
    // frontmatter status: shipped = already done
    if (fm.status === "shipped") continue;

    const text = readFileSync(f, "utf8");
    const relPath = relative(planBase, f);
    const { checked, unchecked } = countFirstSection(f);
    const total = checked + unchecked;
    if (total === 0) continue;

    // W1: header says not-started but chunks are ticked
    const head = text.slice(0, 2048);
    if (
      checked > 0 &&
      NOT_STARTED.test(head) &&
      !SHIPPED_RE.test(head) &&
      !FM_SHIPPED.test(text)
    ) {
      // Extract the status value for the message
      const statusMatch = />\s*\*?\*?Status:?\*?\*?\s+(.+)/i.exec(head);
      const statusVal = statusMatch?.[1]?.replace(/\*\*/g, "").trim() ?? "?";
      warns.push(
        `${relPath} — status header says "${statusVal}" but ${checked} chunk(s) are ticked\n   fix: update the header to 🚧 in-progress or ✅ shipped`,
      );
    }

    // W2: all chunks ticked but header never marked shipped
    if (
      checked > 0 &&
      unchecked === 0 &&
      !SHIPPED_RE.test(head) &&
      !FM_SHIPPED.test(text)
    ) {
      warns.push(
        `${relPath} — all ${checked} chunk(s) ticked but header never marked shipped\n   fix: add ✅ shipped to the header or run ${planSweepCmd} ${basename(f)} --apply`,
      );
    }
  }
  return warns;
};

// status:blocked with every first-section chunk ticked = deferred doc debt:
// the work reads done but the plan stays in plan/ forever (shippedNotMoved
// never lists it — HELD excludes it). Trackers never finish, so they are out.
export const collectBlockedTickedIssues = (active: string[]): string[] => {
  const issues: string[] = [];
  for (const f of active) {
    const fm = parsePlanFrontmatter(f);
    if (fm.status !== "blocked") continue;
    if (fm.kind === "tracker") continue;
    const { checked, unchecked } = countFirstSection(f);
    if (checked > 0 && unchecked === 0) {
      issues.push(
        `${relative(planBase, f)} — status:blocked but all ${checked} chunk(s) ticked (deferred doc debt?)\n   fix: ship via ${planSweepCmd} ${basename(f)} --apply or add the remaining chunk`,
      );
    }
  }
  return issues;
};

// the ✅ shipped header is no longer on the first line — the current plan format starts with frontmatter
// then `# title` (see templates/PLAN.md); check the file's head rather than a single first line
//
// frontmatter always beats the ✅ header: a plan that shipped some chunks and is waiting on externals (VPS, users,
// a decision) writes `status: blocked` = it is meant to stay in plan/, not forgotten to move
// if this is not checked, such plans show "shipped but never archived" forever, and people stop reading
// the whole list — the same symptom that kept done/ from ever moving in the first place
export const hasShippedHeader = (file: string): boolean => {
  const head = readFileSync(file, "utf8").slice(0, 2048);
  if (!SHIPPED.test(head)) return false;
  return !HELD.test(FRONT.exec(head)?.[1] ?? "");
};

// A non-PLAN doc sitting in plan/ with no adopted anchor — someone dropped a
// handoff/spec/todo straight into plan/ instead of `fapony plan adopt`, so it
// has no plan:<name> anchor for sweep's closing check to consult. Detect-only:
// WARN-level like drift warns, never changes the exit code.
export const collectUnadoptedDocWarns = (active: string[]): string[] => {
  const warns: string[] = [];
  for (const f of active) {
    const base = basename(f);
    if (/^PLAN-.*\.md$/i.test(base)) continue;
    const slug = slugify(base);
    if (!slug) continue;
    const anchor = `plan:${slug}`;
    let text: string;
    try {
      text = readFileSync(f, "utf8").toLowerCase();
    } catch {
      continue;
    }
    if (!text.includes(anchor)) {
      warns.push(
        `${relative(planBase, f)} — doc without adopted anchor — meant for \`fapony plan adopt\`?\n   fix: adopt it via \`fapony plan adopt ${base}\` or tag its fael rows with ${anchor}`,
      );
    }
  }
  return warns;
};

export const planSweepCmd = "fapony plan sweep";

const mdFiles = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? mdFiles(join(dir, e.name))
          : e.name.endsWith(".md")
            ? [join(dir, e.name)]
            : [],
      )
    : [];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// the file moved dir (same content) — an old markdown link meant the old path relative to oldDir, must re-relativize via newDir
// resolve from newDir (where the file is now) — if the target also moved to the same dir → plain filename,
// if the target stayed in oldDir → ../target (both correct)
//
// Runs on EVERY move, including the standard sibling layout (plan/ → done/ beside
// it): same depth is not the same directory, so a sibling link like
// [other](PLAN-other.md) breaks unless rewritten to ../plan/PLAN-other.md.
// Skipping this pass left exactly that dangling (mtjn3ldk).
// pass 1 only — fix only [text](target) markdown links, do not touch plain text
export const rewriteMovedFileLinks = (
  file: string,
  oldDir: string,
  newDir: string,
): number => {
  const src = readFileSync(file, "utf8");
  let n = 0;

  const out = src.replace(/\]\(([^)]+)\)/g, (m, t: string) => {
    const [target, anchor] = t.split("#");
    if (!target || /^(https?:|mailto:|\/)/.test(target)) return m;
    // resolve from where the file IS now (newDir); if target doesn't exist
    // there, fall back to oldDir (target stayed in original location).
    // If it exists in neither, the link is already broken — leave it for
    // plan-check instead of fabricating a new broken path.
    const inNew = resolve(newDir, target);
    const inOld = resolve(oldDir, target);
    const abs = existsSync(inNew) ? inNew : existsSync(inOld) ? inOld : null;
    if (!abs) return m;
    const next = `](${relative(newDir, abs) || "."}${anchor ? `#${anchor}` : ""})`;
    if (next === m) return m;
    n++;
    return next;
  });

  if (n) writeFileSync(file, out);
  return n;
};

// other files whose links point at the old path (oldAbs) → repoint them at the new path (newAbs)
// pass 1 only — fix only [text](target) markdown links, do not touch plain text
export const rewriteMarkdownLinks = (
  file: string,
  oldAbs: string,
  newAbs: string,
): number => {
  const src = readFileSync(file, "utf8");
  let n = 0;
  const newRel = relative(dirname(file), newAbs) || ".";

  const out = src.replace(/\]\(([^)]+)\)/g, (m, t: string) => {
    const [target, anchor] = t.split("#");
    if (!target || /^(https?:|mailto:|\/)/.test(target)) return m;
    if (resolve(dirname(file), target) !== oldAbs) return m;
    n++;
    return `](${newRel}${anchor ? `#${anchor}` : ""})`;
  });

  if (n) writeFileSync(file, out);
  return n;
};

// count plain-text mentions of the target filename in a file (detect-only, writes nothing)
// regex: not a markdown link [text](url) — catches both with/without the .md extension
// covers: prose, backtick code span, code fence — every context that is not a markdown link
//
// Fix (2026-09-02): strip the whole markdown link [text](target) first (both display text and
// target — not just target), then run the plain-text regex on the remainder, no longer needing
// lookbehind — the old lookbehind `(?<![/\[(])` was meant to stop markdown-link false-positives
// but its side effect was excluding every mention with a leading `/` too (e.g. `done/PLAN-x.md` or
// `apps/vela/plan/PLAN-x.md`) — the real false-negative that slipped through in 6e411042
// The first fix (stripping only `](target)`) missed — it left `[display-text]` unwrapped, making an already
// valid link like `[PLAN-x.md](../done/PLAN-x.md)` (the actual pattern throughout this file) get double-counted as a
// plain-text mention — strip the whole [..](..) block, not just the (..) part
export const countPlainTextMentions = (
  file: string,
  target: string,
): number => {
  const src = readFileSync(file, "utf8");
  const baseName = target.replace(/\.md$/, "");
  const withoutLinks = src.replace(/\[[^\]]*\]\([^)]+\)/g, "");
  const plainRe = new RegExp(
    `\\b${escapeRe(baseName)}(?:\\.md)?\\b(?!\\.\\w)`,
    "g",
  );
  let count = 0;

  while (plainRe.test(withoutLinks)) count++;
  return count;
};

// shared with the dashboard (now/kickoff) — plan/ files with a shipped header but not yet moved into done/
export const shippedNotMoved = (): string[] => {
  const dir = planDir;
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => e.name)
    .filter((name) => hasShippedHeader(join(dir, name)));
};

export const cmdPlanSweep = (a: string[]) => {
  const dir = planDir;
  if (!existsSync(dir)) {
    console.log(`no ${rel(dir)}/ — nothing to sweep`);
    return;
  }
  const candidates = shippedNotMoved();

  const target = a.find((x) => x.endsWith(".md"));
  const apply = a.includes("--apply");

  if (!target) {
    if (candidates.length) {
      console.log(
        `# plan-sweep — ${candidates.length} file(s) marked shipped but not archived\n`,
      );
      for (const name of candidates) {
        const spec = `${rel(dir)}/${name}`;
        const openBugs = openRowsFor(spec).filter(
          (r) => r.kind === "bug",
        ).length;
        const openHandoffs = openHandoffRowsFor(spec).length;
        const warn =
          openBugs + openHandoffs
            ? `  ⚠ ${openBugs} open issue(s) + ${openHandoffs} open handoff(s) (fael) — close before moving`
            : "";
        console.log(`- ${rel(dir)}/${name}${warn}`);
      }
      console.log(`\nmove: ${planSweepCmd} <file.md> --apply`);
    } else {
      console.log(
        `no PLAN with a ✅ shipped header is sitting outside ${rel(doneDir)}/`,
      );
    }
    // blocked plans are never move candidates (HELD excludes them from
    // shippedNotMoved) — list them with progress + open rows so the debt on
    // a waiting plan is visible instead of silent.
    const blocked = mdFiles(dir).filter(
      (f) => parsePlanFrontmatter(f).status === "blocked",
    );
    if (blocked.length) {
      console.log(
        `\n# blocked plans (${blocked.length}) — not move candidates\n`,
      );
      for (const f of blocked) {
        const { checked, unchecked } = countFirstSection(f);
        const spec = rel(f);
        const openN = openRowsFor(spec).length;
        const by = parsePlanFrontmatter(f).blockedByRaw ?? "?";
        console.log(
          `- ${spec} — ${checked}/${checked + unchecked} chunks · blocked_by: ${by}${openN ? ` · ⚠ ${openN} open row(s)` : ""}`,
        );
      }
    }
    return;
  }

  // target arrives as a bare name (PLAN-x.md, the SKILL form) or a repo-relative
  // path (.fapony/plan/PLAN-x.md, the example form) — both must resolve, so try
  // planDir first, then the repo root, then the bare basename as a last resort.
  const src = [
    join(dir, target),
    join(root, target),
    join(dir, basename(target)),
  ].find((p) => existsSync(p));
  if (!src) {
    console.error(`${target} not found (looked in ${rel(dir)}/ and repo root)`);
    process.exit(1);
  }
  const name = basename(src);
  const srcDir = dirname(src);
  const fm = parsePlanFrontmatter(src);
  // superseded = closed without shipping; done/ is where closed plans live
  const superseded = fm.status === "superseded";
  const shipped = hasShippedHeader(src) || superseded;
  if (!apply) {
    if (fm.status === "blocked") {
      console.log(
        `${target}: status:blocked (blocked_by: ${fm.blockedByRaw ?? "?"}) — not a move candidate, stays in plan/`,
      );
      return;
    }
    console.log(
      superseded
        ? `${target}: status:superseded — ready to move (add --apply)`
        : shipped
          ? `${target}: has a ✅ shipped header — ready to move (add --apply)`
          : `${target}: no ✅ shipped header at the top — check the whole file is actually done`,
    );
    return;
  }

  // ponytail: the old --apply enforced neither of these two conditions — you could pass the dry-run message
  // but then run --apply directly and skip everything → risky when an agent ships automatically with no human check, so hard block
  if (!shipped && !process.env.MEM_FORCE) {
    console.error(
      `${name}: no ✅ shipped header and not status:superseded — refusing to move (MEM_FORCE=1 to override)`,
    );
    process.exit(1);
  }
  // Notes and decisions are the plan's history and travel with it (basename
  // match survives the move); an open issue (MemRow kind "bug") is unfinished
  // work — and so is an open handoff row (`plan:<name>:chunk-N`, any kind),
  // which the old kind-only check let straight through to done/.
  const openBugs = openRowsFor(rel(src)).filter((r) => r.kind === "bug");
  const openHandoffs = openHandoffRowsFor(rel(src));
  if ((openBugs.length || openHandoffs.length) && !process.env.MEM_FORCE) {
    const lines = [
      ...openBugs.map((r) => `  [${r.id}] ${r.kind} ${r.text}`),
      ...openHandoffs.map((r) => `  [${r.id}] handoff ${r.key} ${r.text}`),
    ];
    console.error(
      `${name}: still has ${openBugs.length} open issue(s) + ${openHandoffs.length} open handoff(s) (fael) — close them first (MEM_FORCE=1 to override):\n` +
        lines.join("\n"),
    );
    process.exit(1);
  }

  const dst = join(doneDir, name);
  if (existsSync(dst)) {
    console.error(`${rel(dst)} already exists`);
    process.exit(1);
  }

  // ponytail: a file just written this round may not be git add'ed yet — `git mv` fails silently (exit 128, no throw)
  // then the next code hits ENOENT reading a dst that does not exist — always stage first (no-op if already tracked)
  mkdirSync(doneDir, { recursive: true });
  // a repo that gitignores .fapony/ (public repo, private plans) has nothing
  // for git to move — `git add` refuses an ignored path, so rename instead
  if (gitOk(["check-ignore", "-q", src], root)) {
    renameSync(src, dst);
    console.log(
      `${rel(src)} is not tracked by git — moved with a plain rename`,
    );
  } else {
    Bun.spawnSync(["git", "add", src]);
    const mv = Bun.spawnSync(["git", "mv", src, dst]);
    if (mv.exitCode !== 0) {
      console.error(
        `git mv failed (${mv.stderr.toString().trim()}) — not moved`,
      );
      process.exit(1);
    }
  }

  // own links always need re-relativizing — the file changed directory even in
  // the sibling layout (plan/ → done/ beside it), so sibling links dangle
  // unless rewritten (see rewriteMovedFileLinks).
  const ownLinks = rewriteMovedFileLinks(dst, srcDir, doneDir);

  // inbound: every .md under .fapony/ can link here — other active plans,
  // shipped plans in done/ (they reference each other), and specs. Scanning
  // plan/ only left done/+spec/ links dangling (mtl15q4y).
  let inbound = 0;
  let inboundFiles = 0;
  for (const f of mdFiles(planBase)) {
    if (f === dst) continue;
    const n = rewriteMarkdownLinks(f, src, dst);
    if (n) {
      inbound += n;
      inboundFiles++;
    }
  }

  console.log(`moved ${rel(src)} → ${rel(dst)}`);
  console.log(`links rewritten inside the file: ${ownLinks}`);
  console.log(
    `inbound links rewritten: ${inbound} in ${inboundFiles} file(s) (scanned ${rel(planBase)}/**)`,
  );

  // the ship may unblock waiting plans — the dep graph lives in frontmatter,
  // so say which active plans name this file as their blocker (or were named
  // in this file's own blocks:). Detect-only: the dependent keeps
  // status:blocked until its owner clears it (plan-check flags it meanwhile).
  const unblockedByName = mdFiles(dir).filter((f) =>
    extractPlanRefs(parsePlanFrontmatter(f).blockedByRaw).includes(name),
  );
  const unblockedByOwnBlocks = extractPlanRefs(
    parsePlanFrontmatter(dst).blocksRaw,
  ).filter((b) => existsSync(join(dir, b)));
  const unblocked = [
    ...new Set([
      ...unblockedByName.map((f) => basename(f)),
      ...unblockedByOwnBlocks,
    ]),
  ];
  if (unblocked.length) {
    console.log(
      `🔓 ${name} shipped — ${unblocked.join(", ")} list(s) it as blocker, clear status:blocked?`,
    );
  }

  // plain-text mention detection (detect-only, no auto-fix)
  let plainTextTotal = 0;
  const plainTextFiles: string[] = [];
  for (const f of mdFiles(planBase)) {
    if (f === dst) continue;
    const n = countPlainTextMentions(f, name);
    if (n) {
      plainTextTotal += n;
      plainTextFiles.push(f.replace(`${planBase}/`, ""));
    }
  }
  if (plainTextTotal > 0) {
    console.log(
      `⚠ ${plainTextTotal} plain-text mention(s) in ${plainTextFiles.length} file(s) under ${rel(planBase)}/ — grep and update the paths yourself:\n${plainTextFiles.join("\n")}`,
    );
  }

  // files outside .fapony/ that mention the filename — detect-only.
  // Everything under planBase/ was auto-fixed above, so what remains is repo
  // docs and prose (README, docs/, CLAUDE.md) with hand-written paths.
  // cwd: root — the pathspecs are root-relative no matter where fapony runs from.
  const grep = Bun.spawnSync(
    ["git", "grep", "-l", name, "--", ".", `:!${rel(planBase)}`],
    { cwd: root },
  )
    .stdout.toString()
    .trim();
  if (grep)
    console.log(
      `⚠ files outside ${rel(planBase)}/ still mention "${name}" — check them yourself (not auto-fixed):\n${grep}`,
    );
};

// plan-check — list active PLANs + detect shipped-not-moved + broken links
// + verify the commits ticked chunks cite (chunk 8, PLAN-seed-and-surface)
// + dep-graph (blocked_by/blocks: dangling, shipped-but-still-blocked, cycles)
// + blocked-with-all-chunks-ticked (deferred doc debt) + blocked view
// exit 0 = clean, 1 = issues found

// A ticked chunk cites the commit that closed it — a sha git cannot find on
// this HEAD means the "done" mark proves nothing. git is the judge, not the
// regex: a 7-hex word that is no object at all (deadbee) is a plain word,
// never an issue. A sha that IS an object but not a commit (blob/tree)
// counts as missing — "no such commit" is literally true for it.
// Standalone short shas only — lookarounds (not \b) so a 40-char sha never
// matches on its tail: git resolves leading prefixes, a trailing slice would
// false-positive as missing.
export const SHA_RE = /(?<![0-9a-f])[0-9a-f]{7,12}(?![0-9a-f])/g;

export const extractShas = (line: string): string[] => line.match(SHA_RE) ?? [];

const gitOk = (args: string[], cwd: string): boolean => {
  try {
    return (
      Bun.spawnSync(["git", ...args], {
        cwd,
        stdout: "ignore",
        stderr: "ignore",
      }).exitCode === 0
    );
  } catch {
    return false;
  }
};

export const isCommitObject = (sha: string, cwd: string): boolean =>
  gitOk(["cat-file", "-e", `${sha}^{commit}`], cwd);

const isAnyObject = (sha: string, cwd: string): boolean =>
  gitOk(["cat-file", "-e", sha], cwd);

export const isAncestorOfHead = (sha: string, cwd: string): boolean =>
  gitOk(["merge-base", "--is-ancestor", sha, "HEAD"], cwd);

// Per ticked line: which cited shas fail, plus how many shas the line cites
// at all (cited). A hex word git never heard of is a plain word (deadbee,
// the "feedbac" inside "feedback") — UNLESS it sits in a paren group with a
// sha git knows, in which case the author cited it as a commit: the fixture
// is (e898877 + e307fe6), where e898877 resolves to no object at all yet is
// unmistakably a citation, not prose.
export const checkTickedLine = (
  line: string,
  cwd: string,
): { missing: string[]; diverged: string[]; cited: number } => {
  const missing: string[] = [];
  const diverged: string[] = [];
  const status = new Map<string, "commit" | "object" | "word">();
  for (const sha of extractShas(line)) {
    if (!status.has(sha)) {
      status.set(
        sha,
        isCommitObject(sha, cwd)
          ? "commit"
          : isAnyObject(sha, cwd)
            ? "object"
            : "word",
      );
    }
  }
  const known = new Set(
    [...status].filter(([, s]) => s !== "word").map(([k]) => k),
  );
  const citedInGroup = new Set<string>();
  for (const g of line.match(/\([^)]*\)/g) ?? []) {
    const gs = extractShas(g);
    if (gs.some((s) => known.has(s))) for (const s of gs) citedInGroup.add(s);
  }
  let cited = 0;
  for (const [sha, st] of status) {
    if (st === "commit") {
      cited++;
      if (!isAncestorOfHead(sha, cwd)) diverged.push(sha);
    } else if (st === "object") {
      cited++;
      missing.push(sha);
    } else if (citedInGroup.has(sha)) {
      cited++;
      missing.push(sha);
    }
    // else: a plain word that happens to be hex — skip
  }
  return { missing, diverged, cited };
};
export const cmdPlanCheck = (a: string[]) => {
  const quiet = a.includes("--quiet");
  const dir = planDir;
  if (!existsSync(dir)) {
    if (!quiet) console.log(`no ${rel(dir)}/ — skip`);
    return;
  }

  const issues: string[] = [];

  // 1) List active PLANs
  const active = mdFiles(dir).filter((f) => !f.includes("/done/"));
  if (!quiet) {
    console.log(`${rel(dir)}/ — ${active.length} file(s) (active)\n`);
  }

  // 2) Shipped-not-moved check
  const shipped = shippedNotMoved();
  for (const name of shipped) {
    issues.push(
      `${name} — has a shipped header but was never archived\n   fix: ${planSweepCmd} ${name} --apply`,
    );
  }

  // 3) Broken link check — resolve [text](target) where target is in plan/**
  //    only check active files (not done/) — done/ files are historical snapshots with external refs
  const linkRe = /\]\(([^)]+)\)/g;
  for (const f of active) {
    // strip fenced blocks + inline code first (replace with spaces to preserve line offset) —
    // example links in code (e.g. this tool's own spec) must not be counted as real links
    const src = readFileSync(f, "utf8")
      .replace(/```[\s\S]*?```/g, (b) => b.replace(/[^\n]/g, " "))
      .replace(/`[^`\n]*`/g, (b) => " ".repeat(b.length));
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(src)) !== null) {
      const target = m[1];
      if (target?.startsWith("file://")) {
        // works on the machine that wrote it, nowhere else — name the
        // relative path instead of calling an existing file "broken"
        const [abs] = decodeURI(target.slice("file://".length)).split("#");
        const at = `${f.replace(`${dir}/`, "")}:${src.slice(0, m.index).split("\n").length}`;
        issues.push(
          abs && existsSync(abs)
            ? `${at} — absolute file:// link → ${target} (works on this machine only)\n   fix: use ${relative(realpathSync(dirname(f)), realpathSync(abs))}`
            : `${at} — broken link → ${target}\n   fix: correct the path or create the file it points at`,
        );
        continue;
      }
      if (!target || /^(https?:|mailto:|\/)/.test(target)) continue;
      const [pathPart] = target.split("#");
      if (!pathPart) continue;
      const resolved = resolve(dirname(f), pathPart);
      if (!resolved.startsWith(dir)) continue; // only check links within plan/
      if (!existsSync(resolved)) {
        const rel = f.replace(`${dir}/`, "");
        const line = src.slice(0, m.index).split("\n").length;
        issues.push(
          `${rel}:${line} — broken link → ${target} (no such file in plan/)\n   fix: correct the path or create the file it points at`,
        );
      }
    }
  }

  // 4) Ticked-chunk sha check — a ticked chunk that cites a commit must cite
  //    one git finds on this HEAD. Scans plan/ AND done/: done/ files are the
  //    shipped record, and the known-stale shas all live there — active-only
  //    would see zero. No sha = no check (chunks that close with "defer" have
  //    no commit); the summary line reports the ratio instead of flagging.
  let closed = 0;
  let citing = 0;
  let verified = 0;
  const shaFiles = [
    ...new Set([...active, ...(existsSync(doneDir) ? mdFiles(doneDir) : [])]),
  ];
  for (const f of shaFiles) {
    const relPath = relative(planBase, f);
    const lines = readFileSync(f, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!/^\s*-\s\[x\]/.test(line)) return;
      closed++;
      const { missing, diverged, cited } = checkTickedLine(line, root);
      if (cited > 0) {
        citing++;
        if (!missing.length && !diverged.length) verified++;
      }
      for (const sha of missing) {
        issues.push(
          `${relPath}:${i + 1} — ticked chunk cites ${sha} but git has no such commit\n   fix: correct the sha or leave the chunk unticked`,
        );
      }
      for (const sha of diverged) {
        issues.push(
          `${relPath}:${i + 1} — ticked chunk cites ${sha} which is not an ancestor of HEAD (rebased away?)\n   fix: point at the surviving commit or leave the chunk unticked`,
        );
      }
    });
  }

  // 5) Dep-graph check — frontmatter blocked_by/blocks already states the
  //    order, so verify it: dangling refs, blocker shipped but dependent still
  //    blocked, and waiter cycles. Sentence values carry no PLAN-*.md token
  //    and are skipped, never flagged.
  for (const issue of collectDepIssues(active)) issues.push(issue);

  // 6) Blocked-but-ticked check — status:blocked with every first-section
  //    chunk ticked is deferred doc debt: shippedNotMoved never lists it
  //    (HELD excludes it), so without this flag it sits in plan/ silently.
  for (const issue of collectBlockedTickedIssues(active)) issues.push(issue);

  // 7) Drift warns — W1 (not-started header + ticks) and W2 (all ticked +
  //    not shipped). WARN-only: counted separately, never changes exit code.
  //    Unadopted docs join them: a stray handoff in plan/ is a nudge, not a failure.
  const driftWarns = collectDriftWarns(active);
  driftWarns.push(...collectUnadoptedDocWarns(active));

  if (!quiet) {
    console.log(
      `closed chunks: ${closed} · citing a commit: ${citing} · verified: ${verified}`,
    );
    // blocked view: waiting plans are never move candidates, but their debt
    // (progress + open mem rows) must be visible somewhere — plan-check is it.
    const blocked = active.filter(
      (f) => parsePlanFrontmatter(f).status === "blocked",
    );
    if (blocked.length) {
      console.log(
        `\nblocked plans (${blocked.length}) — waiting, not candidates:`,
      );
      for (const f of blocked) {
        const { checked, unchecked } = countFirstSection(f);
        const spec = rel(f);
        const openN = openRowsFor(spec).length;
        const by = parsePlanFrontmatter(f).blockedByRaw ?? "?";
        console.log(
          `- ${spec} — ${checked}/${checked + unchecked} chunks · blocked_by: ${by}${openN ? ` · ⚠ ${openN} open row(s)` : ""}`,
        );
      }
    }
    if (driftWarns.length > 0) {
      console.log(`\n⚠ ${driftWarns.length} drift warning(s) (not blocking):`);
      for (const w of driftWarns) console.log(`- ${w}`);
    }
  }

  if (issues.length === 0) {
    if (!quiet) console.log("✅ clean");
    process.exit(0);
  }

  console.error(`🚨 ${issues.length} issue(s):\n`);
  for (let i = 0; i < issues.length; i++) {
    console.error(`${i + 1}. ${issues[i]}\n`);
  }
  process.exit(1);
};
