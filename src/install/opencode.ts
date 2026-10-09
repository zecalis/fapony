// src/install/opencode.ts — OpenCode install provider
//
// Removes fapony's retired plugins from ~/.config/opencode/plugins and
// symlinks skills. Memory (MCP, commit hint,
// session start, per-file read context) moved to fael — `fael install`.

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeSkillsDir, linkSkills, reportSkills } from "./skills.js";
import type { InstallDeps } from "./types.js";

export function findOpencodeConfig(getHome: () => string): string | null {
  const dir = join(getHome(), ".config", "opencode");
  for (const name of ["opencode.json", "opencode.jsonc"]) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

export interface OpencodeInstallOpts {
  /** Refresh only the generated plugin bodies — skip the opencode.json write
   *  and the skills symlink entirely. This is `fapony update`'s post-pull
   *  refresh: it must touch only fapony-owned plugin files, never the user's
   *  config (rule 6c — overwriting what exists = ask first, or refuse). */
  pluginsOnly?: boolean;
}

export function cmdInstallOpencode(
  dryRun: boolean,
  deps: InstallDeps = {},
  opts: OpencodeInstallOpts = {},
): void {
  const getHome = deps.homedir ?? homedir;

  if (!opts.pluginsOnly) {
    const skillsDir = claudeSkillsDir(getHome);
    reportSkills(linkSkills(skillsDir, dryRun), skillsDir, dryRun);
  }
  for (const [fileName, ownedName] of RETIRED_PLUGINS) {
    removeRetiredPlugin(dryRun, getHome, fileName, ownedName);
  }
}

/** Plugins fapony used to write — memory hints (now fael's), the edit hint
 *  (cut 2026-09-26) and git-autonomy (cut 2026-10-09). Their bodies import exports src/hook.ts no longer has, so
 *  a leftover copy would fail to load inside OpenCode: remove ours (by owned
 *  name), never a foreign file. */
const RETIRED_PLUGINS: [string, string][] = [
  ["fapony-read-hint.ts", "FaponyReadHint"],
  ["fapony-commit-hint.ts", "FaponyCommitHint"],
  ["fapony-session-start.ts", "FaponySessionStart"],
  ["fapony-edit-hint.ts", "FaponyEditHint"],
  ["fapony-git-autonomy.ts", "FaponyGitAutonomy"],
];

function removeRetiredPlugin(
  dryRun: boolean,
  getHome: () => string,
  fileName: string,
  ownedName: string,
): void {
  const pluginPath = join(
    getHome(),
    ".config",
    "opencode",
    "plugins",
    fileName,
  );
  let current: string;
  try {
    current = readFileSync(pluginPath, "utf-8");
  } catch {
    return;
  }
  if (!current.includes(ownedName)) return;
  if (!dryRun) {
    try {
      rmSync(pluginPath);
    } catch (e) {
      console.error(
        `  ${fileName}: failed to remove — ${(e as Error).message}`,
      );
      return;
    }
  }
  console.error(
    `  ${fileName}: ${dryRun ? "would remove" : "removed"} (retired plugin)`,
  );
}

/** The fapony-generated plugin files present in an OpenCode install. Empty =
 *  OpenCode has none, so `fapony update` must not install into a client the user
 *  never opted into. */
export function opencodePluginFiles(getHome: () => string = homedir): string[] {
  const pluginsDir = join(getHome(), ".config", "opencode", "plugins");
  try {
    return readdirSync(pluginsDir).filter(
      (f) => f.startsWith("fapony-") && f.endsWith(".ts"),
    );
  } catch {
    return [];
  }
}
