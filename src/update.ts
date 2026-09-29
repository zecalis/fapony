// src/update.ts — self-update via git pull.
// ROOT must be the repo root: import.meta.dir is src/, one level below it.
// Shows old → new version, recent commits, and warns if uncommitted changes.

import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { opencodePluginFiles } from "./install/opencode.js";
import { isAffirmative } from "./util.js";

/** Repo root (parent of src/) — where package.json and bun.lock live.
 *  Exported for the tripwire test in test/update.test.ts. */
export const ROOT = join(import.meta.dir, "..");

function defaultGit(args: string): string {
  return execSync(`git ${args}`, {
    encoding: "utf-8",
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 15_000,
  }).trim();
}

function defaultInstall(): void {
  // Generous cap vs the 15s git calls — bun install legitimately takes longer,
  // but must not wedge `fapony update` forever on a hung registry.
  execSync("bun install", { cwd: ROOT, stdio: "pipe", timeout: 300_000 });
}

/** argv for the spawned plugin refresh — exported so tests can pin the flags:
 *  a wrong flag fails silently (the child would just do a full install and
 *  rewrite opencode.json, the exact bug `--plugins-only` exists to prevent). */
export function refreshArgv(files: string[]): string[] {
  const argv = [
    join(ROOT, "fapony.ts"),
    "install",
    "--platform",
    "opencode",
    // Plugins only: a refresh touches fapony-owned plugin files, never the
    // user's opencode.json (rule 6c).
    "--plugins-only",
  ];
  // Opt-in plugin: refresh it when the user installed it, never create it.
  if (files.includes("fapony-git-autonomy.ts")) argv.push("--git-autonomy");
  return argv;
}

/**
 * Refresh OpenCode's generated plugin bodies after the pull.
 *
 * OpenCode is the only client whose hooks are baked files — every other client
 * writes a `fapony hook-*` command resolved at run time, so a pull alone keeps
 * them current. Spawning a *fresh* process is the whole point: this one already
 * loaded the pre-pull templates, so calling the installer in-process would
 * rewrite the old body — the exact bug this exists to fix. `process.execPath`
 * is the bun running fapony, so no PATH dependency. Runs `--plugins-only`, so
 * the refresh never reads or writes opencode.json or the skills symlink.
 * Best-effort: a refresh must never fail an update.
 */
function defaultRefreshPlugins(): void {
  const getHome = (): string => homedir();
  const files = opencodePluginFiles(getHome);
  if (files.length === 0) return;
  console.log("\n  Refreshing OpenCode plugins...");
  const r = spawnSync(process.execPath, refreshArgv(files), {
    stdio: "pipe",
    timeout: 30_000,
  });
  if (r.error || r.status !== 0) {
    console.log(
      "  ⚠  plugin refresh failed — run manually: fapony install --platform opencode --plugins-only",
    );
  }
}

/** Minimal seam for cmdUpdate — git runner (map args→result, throws on failure),
 *  prompt, exit, bun-install, and the post-pull OpenCode plugin refresh. Every
 *  field is used by both the default (production) path and the test path. */
export interface UpdateDeps {
  git?: (args: string) => string;
  install?: () => void;
  refresh?: () => void;
  prompt?: (question: string, defaultVal?: string) => Promise<string>;
  exit?: (code: number) => never;
}

export interface UpdateArgs {
  dryRun: boolean;
  yes: boolean;
}

/** Parse `fapony update|upgrade` flags — exported for tests. */
export function parseUpdateArgs(argv: string[] = []): UpdateArgs {
  return {
    dryRun: argv.includes("--dry-run"),
    yes: argv.includes("--yes") || argv.includes("-y"),
  };
}

/** Only an affirmative answer upgrades after the preview. */
export function shouldUpgrade(answer: string): boolean {
  return isAffirmative(answer);
}

/** Repo package.json version — exported for tests (reads the real ROOT). */
export function readVersion(): string {
  const pkgPath = join(ROOT, "package.json");
  if (!existsSync(pkgPath)) return "unknown";
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** Split `git status --porcelain` output into non-empty lines. Empty = clean. */
export function parseDirtyLines(porcelain: string): string[] {
  return porcelain.split("\n").filter((l) => l.trim() !== "");
}

/** The indented dirty-file block cmdUpdate prints before asking to proceed. */
export function formatDirtyBlock(porcelain: string): string {
  return parseDirtyLines(porcelain)
    .map((l) => `   ${l}`)
    .join("\n");
}

/** Only an affirmative answer proceeds past the dirty-tree warning. */
export function shouldProceedAfterDirty(answer: string): boolean {
  return isAffirmative(answer);
}

/** Same SHA before/after pull = already up to date. */
export function isUpToDate(oldSha: string, newSha: string): boolean {
  return oldSha === newSha;
}

function defaultPrompt(question: string, defaultVal?: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const suffix = defaultVal !== undefined ? ` (${defaultVal})` : "";
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultVal || "");
    });
  });
}

export async function cmdUpdate(
  first: UpdateDeps | string[] = {},
  second: string[] | UpdateDeps = [],
): Promise<void> {
  const deps: UpdateDeps = Array.isArray(first)
    ? ((second as UpdateDeps) ?? {})
    : first;
  const argv: string[] = Array.isArray(first)
    ? first
    : ((second as string[]) ?? []);
  const { dryRun, yes } = parseUpdateArgs(argv);
  const git = deps.git ?? defaultGit;
  const installFn = deps.install ?? defaultInstall;
  const refreshFn = deps.refresh ?? defaultRefreshPlugins;
  const promptFn = deps.prompt ?? defaultPrompt;
  const exitFn = deps.exit ?? ((code: number): never => process.exit(code));
  const gitQuiet = (args: string): string | null => {
    try {
      return git(args);
    } catch {
      return null;
    }
  };

  console.log("\n🔄 fapony update\n");

  // --- sanity: must be a git repo ---
  const isRepo = gitQuiet("rev-parse --is-inside-work-tree");
  if (isRepo !== "true") {
    console.error(`❌ ${ROOT} is not a git repo — cannot self-update.`);
    console.error(
      "   Reinstall via: git clone https://github.com/zecalis/fapony.git",
    );
    exitFn(1);
  }

  // --- check uncommitted changes ---
  const dirty = git("status --porcelain");
  const hasDirty = parseDirtyLines(dirty).length > 0;
  if (hasDirty) {
    console.log("⚠  You have uncommitted changes in the fapony repo:\n");
    console.log(formatDirtyBlock(dirty));
    console.log();
    if (dryRun) {
      console.log("  dry run — nothing is stashed or pulled.");
    } else {
      const proceed = await promptFn(
        "   Stash changes and pull anyway? (y/n)",
        "n",
      );
      if (!shouldProceedAfterDirty(proceed)) {
        console.log("\n  Update cancelled.");
        return;
      }
      git("stash push -m 'fapony auto-stash before update'");
      console.log("  ✓  Changes stashed.\n");
    }
  }

  // --- preview incoming (fetch never writes the worktree) ---
  gitQuiet("fetch --quiet");
  const incoming = gitQuiet("log HEAD..@{u} --oneline --no-decorate");
  const incomingLines = (incoming ?? "")
    .split("\n")
    .filter((l) => l.trim() !== "");
  if (incomingLines.length > 0) {
    console.log("\n  What's coming:\n");
    for (const line of incomingLines.slice(0, 10)) {
      console.log(`    ${line}`);
    }
    if (incomingLines.length > 10) {
      console.log(`    ... and ${incomingLines.length - 10} more`);
    }
  }

  if (dryRun) {
    console.log("\n  dry run — nothing is pulled or written.");
    if (incomingLines.length === 0 && !hasDirty) {
      console.log("  ✓  Already up to date — no changes to preview.");
    }
    console.log("  To preview client changes too: fapony install --dry-run");
    return;
  }

  // Single confirm before the pull — only when something is incoming.
  // Up-to-date stays silent (no useless prompt); --yes skips for scripts.
  if (incomingLines.length > 0 && !yes) {
    const answer = await promptFn("   Upgrade fapony now? (y/n)", "Y");
    if (!shouldUpgrade(answer)) {
      console.log("\n  Upgrade cancelled.");
      return;
    }
  }

  // --- capture old version + recent commits ---
  const oldVersion = readVersion();
  const oldSha = gitQuiet("rev-parse --short HEAD") ?? "unknown";

  // --- pull ---
  console.log("  Pulling latest changes...");
  const pullOutput = gitQuiet("pull --ff-only");
  if (pullOutput === null) {
    console.error("\n❌ git pull failed (non-fast-forward?).");
    console.error("   Resolve manually, then run: fapony update");
    if (hasDirty) {
      const popResult = gitQuiet("stash pop");
      if (popResult === null) {
        console.error(
          "\n⚠  Your changes are still stashed (auto-restore failed, conflict likely).",
        );
        console.error(
          "   Run `git stash pop` manually to get them back — do NOT `git stash drop`.",
        );
      } else {
        console.error("   ✓  Your stashed changes were restored.");
      }
    }
    exitFn(1);
  }

  // --- capture new version ---
  const newVersion = readVersion();
  const newSha = gitQuiet("rev-parse --short HEAD") ?? "unknown";

  // --- restore stashed changes ---
  if (hasDirty) {
    const popResult = gitQuiet("stash pop");
    if (popResult === null) {
      console.log(
        "\n  ⚠  Could not auto-restore your stashed changes — run `git stash pop` manually (conflict likely).",
      );
    } else {
      console.log("  ✓  Restored your stashed changes.");
    }
  }

  // --- show what changed ---
  if (isUpToDate(oldSha, newSha)) {
    console.log(`\n  ✓  Already up to date (${oldVersion} @ ${oldSha}).`);
    // The repo being current says nothing about the generated plugin bodies —
    // a user who pulled by hand, or installed before the template changed, is
    // exactly who needs this. Refresh is a no-op when nothing is stale.
    refreshFn();
    return;
  }

  console.log(
    `\n  ✓  Updated ${oldVersion}@${oldSha} → ${newVersion}@${newSha}`,
  );

  // --- recent commits since old SHA ---
  const logRange = gitQuiet(`log ${oldSha}..HEAD --oneline --no-decorate`);
  if (logRange) {
    console.log("\n  What's new:\n");
    for (const line of logRange.split("\n").slice(0, 10)) {
      console.log(`    ${line}`);
    }
  }

  // --- re-install dev deps if lockfile changed ---
  const lockChanged = gitQuiet("diff --name-only HEAD@{1} HEAD -- bun.lock");
  if (lockChanged) {
    console.log("\n  Lockfile changed — running bun install...");
    try {
      installFn();
      console.log("  ✓  Dependencies updated.");
    } catch {
      console.log("  ⚠  bun install failed — run manually: bun install");
    }
  }

  // --- refresh generated plugin bodies (after deps — the fresh process needs them) ---
  refreshFn();

  console.log(`\n  What's installed now:`);
  console.log(`    ✓ fapony ${newVersion} @ ${newSha}`);
  console.log(`    ✓ client plugins refreshed`);
  console.log(
    `    → run "fapony install --dry-run" to preview remaining client changes`,
  );
  console.log(`\n  ✓  Update complete! Run "bun run test" to verify.`);
}
