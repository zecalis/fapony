// src/install/skills.ts — skill symlink logic for install
//
// A copied skill goes stale the moment fapony updates, and every client would
// need its own copy to refresh. Symlinking the directory means `fapony update`
// (a git pull in INSTALL_ROOT) reaches every client at once. The <name>/SKILL.md
// layout is what Claude Code expects, so the link is directory-to-directory.
//
// OpenCode reads ~/.claude/skills too, so linking once covers both.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { INSTALL_ROOT, type SkillLinkResult } from "./types.js";

export function claudeSkillsDir(getHome: () => string): string {
  return join(getHome(), ".claude", "skills");
}

export function agentsSkillsDir(getHome: () => string): string {
  return join(getHome(), ".agents", "skills");
}

/**
 * A symlink target counts as "ours" when it points at some fapony checkout's
 * skill dir for the same skill name — `<anywhere>/skill/<name>`. Switching
 * checkouts (e.g. `bun link` → npm) otherwise leaves a link `fapony install`
 * refuses to touch ("not a fapony link"), forcing a hand `find -lname -delete`.
 */
export function isFaponySkillLink(target: string, name: string): boolean {
  if (!target) return false;
  const clean = target.replace(/\/+$/, "");
  return basename(clean) === name && basename(dirname(clean)) === "skill";
}

/** Names in `skillsDir` that are fapony skill links (dangling ones too). */
function faponyLinks(skillsDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(skillsDir);
  } catch {
    return [];
  }
  return entries.filter((name) => {
    try {
      const p = join(skillsDir, name);
      return (
        lstatSync(p).isSymbolicLink() &&
        isFaponySkillLink(readlinkSync(p), name)
      );
    } catch {
      return false;
    }
  });
}

/**
 * Link every skill/<name>/ into `skillsDir`.
 *
 * Never overwrites: a destination that already exists and is not already our
 * link is reported as `conflict` and left alone — it may be the user's own
 * skill, or another tool's, and clobbering it is not ours to decide.
 *
 * Exception: a symlink pointing at another fapony checkout's `skill/<name>`
 * counts as ours and is replaced with this checkout's link.
 *
 * A fapony link whose skill no longer ships (its target is gone) is removed
 * as `pruned` — only a dangling link of fapony's shape, so nothing that
 * still resolves, and nothing that isn't ours, is ever touched.
 */
export function linkSkills(
  skillsDir: string,
  dryRun: boolean,
): SkillLinkResult[] {
  const srcRoot = join(INSTALL_ROOT, "skill");
  if (!existsSync(srcRoot)) return [];

  const names = readdirSync(srcRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  const out: SkillLinkResult[] = [];
  for (const name of faponyLinks(skillsDir)) {
    const dest = join(skillsDir, name);
    // A name that still ships is re-linked by the loop below.
    if (names.includes(name) || existsSync(dest)) continue;
    if (!dryRun) unlinkSync(dest);
    out.push({ name, action: "pruned" });
  }
  for (const name of names) {
    const src = join(srcRoot, name);
    const dest = join(skillsDir, name);

    // null = nothing there; "" = exists but not a symlink; else = link target.
    let existing: string | null;
    try {
      existing = lstatSync(dest).isSymbolicLink() ? readlinkSync(dest) : "";
    } catch {
      existing = null;
    }

    if (existing === src) {
      out.push({ name, action: "already" });
      continue;
    }
    if (
      existing !== null &&
      existing !== "" &&
      isFaponySkillLink(existing, name)
    ) {
      if (!dryRun) {
        mkdirSync(skillsDir, { recursive: true });
        unlinkSync(dest);
        symlinkSync(src, dest);
      }
      out.push({ name, action: "linked" });
      continue;
    }
    if (existing !== null) {
      out.push({ name, action: "conflict" });
      continue;
    }
    if (!dryRun) {
      mkdirSync(skillsDir, { recursive: true });
      symlinkSync(src, dest);
    }
    out.push({ name, action: "linked" });
  }
  return out;
}

export function reportSkills(
  results: SkillLinkResult[],
  skillsDir: string,
  dryRun: boolean,
): void {
  if (results.length === 0) return;

  const linked = results.filter((r) => r.action === "linked").length;
  const already = results.filter((r) => r.action === "already").length;
  const conflicts = results.filter((r) => r.action === "conflict");
  const pruned = results.filter((r) => r.action === "pruned");

  if (linked > 0) {
    const verb = dryRun ? "would link" : "linked";
    console.error(
      `✓ ${verb} ${linked} skill${linked === 1 ? "" : "s"} → ${skillsDir}`,
    );
  }
  if (already > 0) {
    console.error(`  ${already} already linked — no change`);
  }
  if (pruned.length > 0) {
    const verb = dryRun ? "would remove" : "removed";
    console.error(
      `✓ ${verb} ${pruned.length} link${pruned.length === 1 ? "" : "s"} to skills fapony no longer ships: ${pruned.map((r) => r.name).join(", ")}`,
    );
  }
  for (const c of conflicts) {
    console.error(
      `  ! ${c.name} already exists and is not a fapony link — not overwriting`,
    );
    console.error(
      `    to replace: rm -r ${join(skillsDir, c.name)} && ln -s ${join(INSTALL_ROOT, "skill", c.name)} ${join(skillsDir, c.name)}`,
    );
  }
}

/**
 * Re-link skills in every skills dir fapony already linked into — after an
 * update a new skill gets its link and a removed one loses its dead link.
 * A dir with no fapony link is skipped: the user never installed there.
 * Returns whether any dir was refreshed.
 */
export function refreshSkillLinks(getHome: () => string): boolean {
  const dirs = [claudeSkillsDir(getHome), agentsSkillsDir(getHome)].filter(
    (d) => faponyLinks(d).length > 0,
  );
  for (const d of dirs) reportSkills(linkSkills(d, false), d, false);
  return dirs.length > 0;
}
