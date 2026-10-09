// src/update.ts — self-update by the channel fapony came from.
// git checkout: fetch, preview, then fast-forward to the previewed ref.
// bun/npm global: ask the registry for the latest version, then the package
// manager installs it. Either way the clients are refreshed after: skill links
// (a new skill linked, a removed one's dead link pruned) and OpenCode plugins.
// ROOT must be the repo root: import.meta.dir is src/, one level below it.

import { execFileSync, execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { opencodePluginFiles } from "./install/opencode.js";
import { refreshSkillLinks } from "./install/skills.js";
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
export function refreshArgv(): string[] {
  return [
    join(ROOT, "fapony.ts"),
    "install",
    "--platform",
    "opencode",
    // Plugins only: a refresh touches fapony-owned plugin files, never the
    // user's opencode.json (rule 6c).
    "--plugins-only",
  ];
}

/**
 * Refresh OpenCode's generated plugin bodies after the update.
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
function defaultRefreshPlugins(): boolean {
  const getHome = (): string => homedir();
  const files = opencodePluginFiles(getHome);
  if (files.length === 0) return false;
  console.log("\n  Refreshing OpenCode plugins...");
  const r = spawnSync(process.execPath, refreshArgv(), {
    stdio: "pipe",
    timeout: 30_000,
  });
  if (r.error || r.status !== 0) {
    console.log(
      "  ⚠  plugin refresh failed — run manually: fapony install --platform opencode --plugins-only",
    );
    return false;
  }
  return true;
}

const PACKAGE = "@zecalis/fapony";

/** How this fapony was installed — decides what `update` runs. Path first:
 *  a global package can sit inside a git repo (a dotfiles $HOME), and
 *  updating that repo instead would be wrong. */
export type Channel = "git" | "bun" | "npm";

export function detectChannel(root: string): Channel {
  if (/[\\/]\.bun[\\/]install[\\/]global[\\/]/.test(root)) return "bun";
  if (/[\\/]node_modules[\\/]/.test(root)) return "npm";
  return "git";
}

/** The package manager command that installs the latest release. */
export function channelCommand(ch: "bun" | "npm"): string[] {
  return ch === "bun"
    ? ["bun", "add", "-g", `${PACKAGE}@latest`]
    : ["npm", "i", "-g", `${PACKAGE}@latest`];
}

/** Latest published version, or null when the registry can't be reached. */
async function defaultLatest(): Promise<string | null> {
  try {
    const r = await fetch(`https://registry.npmjs.org/${PACKAGE}/latest`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return null;
    const v = ((await r.json()) as { version?: unknown }).version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

function defaultRun(cmd: string[]): void {
  execFileSync(cmd[0], cmd.slice(1), { stdio: "inherit", timeout: 300_000 });
}

/** Skill links, then OpenCode plugins. Skills run in-process: linkSkills
 *  reads the skill/ listing from disk, so it already sees the new release. */
function defaultRefresh(): boolean {
  const skills = refreshSkillLinks(homedir);
  return defaultRefreshPlugins() || skills;
}

/** Minimal seam for cmdUpdate — git runner (map args→result, throws on failure),
 *  prompt, exit, bun-install, and the post-pull OpenCode plugin refresh. Every
 *  field is used by both the default (production) path and the test path. */
export interface UpdateDeps {
  git?: (args: string) => string;
  install?: () => void;
  /** True only when skill links or plugins were refreshed (false = none installed, or failed). */
  refresh?: () => boolean;
  /** Install channel — defaults to detectChannel(ROOT). */
  channel?: Channel;
  /** Latest published version (bun/npm channel); null = unreachable. */
  latest?: () => Promise<string | null>;
  /** Run a package manager command (bun/npm channel); throws on failure. */
  run?: (cmd: string[]) => void;
  prompt?: (question: string, defaultVal?: string) => Promise<string>;
  exit?: (code: number) => never;
  /** Whether a human can answer a prompt — defaults to process.stdin.isTTY.
   *  Injectable so tests exercise the interactive path without a real TTY. */
  isTTY?: boolean;
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
  argv: string[] = [],
  deps: UpdateDeps = {},
): Promise<void> {
  const { dryRun, yes } = parseUpdateArgs(argv);
  const git = deps.git ?? defaultGit;
  const installFn = deps.install ?? defaultInstall;
  const refreshFn = deps.refresh ?? defaultRefresh;
  const promptFn = deps.prompt ?? defaultPrompt;
  const exitFn = deps.exit ?? ((code: number): never => process.exit(code));
  const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY);
  const gitQuiet = (args: string): string | null => {
    try {
      return git(args);
    } catch {
      return null;
    }
  };

  console.log("\n🔄 fapony update\n");

  const channel = deps.channel ?? detectChannel(ROOT);
  if (channel !== "git") {
    const cmd = channelCommand(channel);
    const oldVersion = readVersion();
    const latest = await (deps.latest ?? defaultLatest)();
    if (latest === null) {
      console.error(
        "❌ cannot reach the npm registry (offline?) — nothing changed.",
      );
      exitFn(1);
    }
    // Registry lag or a dev build can sit ahead of latest: never downgrade.
    if (Bun.semver.order(latest as string, oldVersion) <= 0) {
      console.log(`  ✓  Already up to date (${oldVersion}).`);
      if (!dryRun) refreshFn();
      return;
    }
    console.log(`  ${oldVersion} → ${latest} (${channel} global)`);
    console.log(`  runs: ${cmd.join(" ")}`);
    if (dryRun) {
      console.log("\n  dry run — nothing installed.");
      return;
    }
    if (!yes && isTTY) {
      const answer = await promptFn("   Upgrade fapony now? (y/n)", "Y");
      if (!isAffirmative(answer)) {
        console.log("\n  Upgrade cancelled.");
        return;
      }
    }
    try {
      (deps.run ?? defaultRun)(cmd);
    } catch {
      console.error(`\n❌ ${cmd.join(" ")} failed — nothing else changed.`);
      exitFn(1);
    }
    const refreshed = refreshFn();
    console.log(`\n  ✓  Updated ${oldVersion} → ${readVersion()}`);
    if (refreshed) console.log("    ✓ client skills/plugins refreshed");
    return;
  }

  // --- sanity: must be a git repo ---
  const isRepo = gitQuiet("rev-parse --is-inside-work-tree");
  if (isRepo !== "true") {
    console.error(`❌ ${ROOT} is not a git repo — cannot self-update.`);
    console.error(
      `   Installed another way? Run: npm i -g ${PACKAGE}@latest && fapony install`,
    );
    console.error(
      "   From source: git clone https://github.com/zecalis/fapony.git",
    );
    exitFn(1);
  }

  // --- check uncommitted changes (read-only; stashing waits for the confirm) ---
  // Tracked only: `stash push` leaves untracked files alone, so counting them
  // made a stash that was never created and a `stash pop` of someone else's.
  // An untracked file in the way of the merge makes git refuse, not clobber.
  const dirty = git("status --porcelain --untracked-files=no");
  const hasDirty = parseDirtyLines(dirty).length > 0;
  if (hasDirty) {
    console.log("⚠  You have uncommitted changes in the fapony repo:\n");
    console.log(formatDirtyBlock(dirty));
    console.log();
  }

  // --- capture old version + recent commits ---
  const oldVersion = readVersion();
  const oldSha = gitQuiet("rev-parse --short HEAD") ?? "unknown";

  // --- preview incoming (fetch never writes the worktree) ---
  // `@{u}` is unset on a detached HEAD — this repo's own worktree topology —
  // so fall back to the remote-tracking branch. Reading "no upstream" as
  // "nothing incoming" turned the whole preview into a silent no-op.
  // A failed fetch leaves stale refs, so a preview from them would lie.
  if (gitQuiet("fetch --quiet") === null) {
    console.error(
      "❌ git fetch failed (offline?) — cannot preview; nothing changed.",
    );
    exitFn(1);
  }
  const upstreamRefs = ["@{u}"];
  const remoteHead = gitQuiet("symbolic-ref --short refs/remotes/origin/HEAD");
  if (remoteHead) upstreamRefs.push(remoteHead);
  upstreamRefs.push("origin/main", "origin/master");
  let incomingLines: string[] = [];
  let comparedRef: string | null = null;
  for (const ref of upstreamRefs) {
    const out = gitQuiet(`log HEAD..${ref} --oneline --no-decorate`);
    if (out === null) continue;
    comparedRef = ref;
    incomingLines = out.split("\n").filter((l) => l.trim() !== "");
    break;
  }
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
    console.log(
      "\n  dry run — fetched remote refs only; your checkout is untouched.",
    );
    if (comparedRef === null) {
      console.log(
        "  ?  No upstream ref to compare against — update cannot run.",
      );
    } else if (incomingLines.length === 0) {
      console.log("  ✓  Already up to date — no changes to preview.");
    }
    console.log("  To preview client changes too: fapony install --dry-run");
    return;
  }

  if (comparedRef === null) {
    console.error(
      "❌ no upstream ref (tried @{u}, origin/HEAD, origin/main, origin/master) — cannot update.",
    );
    exitFn(1);
  }
  // exitFn returns never, but its type is inferred, so TS won't narrow on it.
  const targetRef = comparedRef as string;

  // Nothing incoming: no stash, no merge. The repo being current says nothing
  // about the generated plugin bodies — a user who pulled by hand, or installed
  // before the template changed, is exactly who needs the refresh.
  if (incomingLines.length === 0) {
    console.log(`\n  ✓  Already up to date (${oldVersion} @ ${oldSha}).`);
    refreshFn();
    return;
  }

  // --- confirm before anything mutates ---
  // This runs before the dirty-tree stash on purpose: asking to stash first
  // and then asking again stranded the auto-stash when the second answer was
  // "no". Non-TTY (cron/CI) proceeds like the pre-preview behaviour instead of
  // hanging on a readline that never returns; --yes skips the ask for scripts.
  if (!yes && isTTY) {
    const answer = await promptFn("   Upgrade fapony now? (y/n)", "Y");
    if (!isAffirmative(answer)) {
      console.log("\n  Upgrade cancelled.");
      return;
    }
  }

  // --- stash only now that we are committed to updating ---
  if (hasDirty) {
    if (yes) {
      git("stash push -m 'fapony auto-stash before update'");
      console.log("  ✓  Changes stashed (--yes).\n");
    } else if (!isTTY) {
      console.error(
        "  ❌ uncommitted changes and no terminal — commit or stash first, or re-run with --yes.",
      );
      exitFn(1);
    } else {
      const proceed = await promptFn(
        "   Stash changes and update anyway? (y/n)",
        "n",
      );
      if (!isAffirmative(proceed)) {
        console.log("\n  Update cancelled.");
        return;
      }
      git("stash push -m 'fapony auto-stash before update'");
      console.log("  ✓  Changes stashed.\n");
    }
  }

  // --- fast-forward to exactly what was previewed ---
  // Not `pull`: it fetches again (unpreviewed commits) and fails outright on
  // the detached HEAD / no-upstream states the preview falls back for.
  console.log(`  Fast-forwarding to ${targetRef}...`);
  if (gitQuiet(`merge --ff-only ${targetRef}`) === null) {
    console.error(`\n❌ git merge --ff-only ${targetRef} failed (diverged?).`);
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
  const refreshed = refreshFn();

  console.log(`\n  What's installed now:`);
  console.log(`    ✓ fapony ${newVersion} @ ${newSha}`);
  if (refreshed) console.log(`    ✓ client skills/plugins refreshed`);
  console.log(
    `    → run "fapony install --dry-run" to preview remaining client changes`,
  );
  console.log(`\n  ✓  Update complete! Run "bun run test" to verify.`);
}
