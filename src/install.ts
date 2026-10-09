// src/install.ts — `fapony install --platform antigravity|agy|opencode|claude|zcode|codex` command.
// Every platform gets skill/<name>/ symlinked (claude/opencode → ~/.claude/skills,
// zcode/codex/antigravity → ~/.agents/skills). claude also gets the plan-mv
// guard. Memory — MCP, Stop, SessionStart — moved to fael (`fael install`).
// All platforms are idempotent + support --dry-run.

import { createInterface } from "node:readline";
import { cmdInstallAntigravity } from "./install/antigravity.js";
import { cmdInstallClaude } from "./install/claude.js";
import { cmdInstallCodex } from "./install/codex.js";
import { detectClients } from "./install/detect.js";
import { cmdInstallOpencode } from "./install/opencode.js";
import { defaultExit, type InstallDeps } from "./install/types.js";
import { cmdInstallZcode } from "./install/zcode.js";
import { ask } from "./setup.js";
import { isAffirmative } from "./util.js";

export { cmdInstallAntigravity } from "./install/antigravity.js";
export { cmdInstallClaude } from "./install/claude.js";
export { cmdInstallCodex } from "./install/codex.js";
export { detectClients } from "./install/detect.js";
export {
  cmdInstallOpencode,
  type OpencodeInstallOpts,
  opencodePluginFiles,
} from "./install/opencode.js";
export {
  agentsSkillsDir,
  claudeSkillsDir,
  linkSkills,
} from "./install/skills.js";
export {
  INSTALL_ROOT,
  type InstallDeps,
} from "./install/types.js";
export { cmdInstallZcode } from "./install/zcode.js";

export async function cmdInstall(
  args: string[],
  deps: InstallDeps = {},
): Promise<void> {
  const platformArg = args.find((a) => !a.startsWith("--"));
  // `agy` = Antigravity's CLI name — alias, same provider.
  const platform = platformArg === "agy" ? "antigravity" : platformArg;
  const dryRun = args.includes("--dry-run");
  const installAll = args.includes("--all");
  // Refresh-only seam for `fapony update`: plugin bodies, never opencode.json.
  const pluginsOnly = args.includes("--plugins-only");

  // --- explicit platform: original behavior, unchanged ---
  if (platform === "antigravity") {
    cmdInstallAntigravity(dryRun, deps);
    return;
  }
  if (platform === "claude") {
    cmdInstallClaude(dryRun, deps);
    return;
  }
  if (platform === "zcode") {
    cmdInstallZcode(dryRun, deps);
    return;
  }
  if (platform === "codex") {
    cmdInstallCodex(dryRun, deps);
    return;
  }
  if (platform === "opencode") {
    cmdInstallOpencode(dryRun, deps, { pluginsOnly });
    return;
  }
  if (platform !== undefined) {
    console.error(
      `usage: fapony install --platform antigravity|agy|opencode|claude|zcode|codex [--dry-run] [--plugins-only]`,
    );
    console.error(
      `  supported platforms: antigravity (agy), opencode, claude, zcode, codex`,
    );
    (deps.exit ?? defaultExit)(1);
    return;
  }

  // --- no platform: detect + list + prompt ---
  const detected = detectClients(deps);
  const found = detected.filter((d) => d.installed);
  const notFound = detected.filter((d) => !d.installed);

  for (const d of found) {
    console.error(`  ✓ ${d.platform} — ${d.why}`);
  }
  for (const d of notFound) {
    console.error(`  · ${d.platform} — not found (${d.why})`);
  }
  console.error(
    `  (not found = no config file yet — or, for claude, the CLI is not on PATH.`,
  );
  console.error(`   open the app once, or force with --platform <name>)`);

  if (found.length === 0) {
    console.error();
    console.error(
      `  no agent client found (looked for claude on PATH; config files for antigravity, opencode, zcode, codex).`,
    );
    console.error(
      `  open the app once, then re-run — or force with: fapony install --platform <name>`,
    );
    return;
  }

  // --dry-run: preview only — list above + per-client preview, never prompt.
  // A dry run answers "what would change", so asking y/n here is the exact
  // confusion this exists to fix.
  if (dryRun) {
    console.error("\n  dry run — nothing is written");
    for (const client of found) {
      console.error(`\n  ${client.platform}`);
      installPlatform(client.platform, dryRun, deps, { pluginsOnly });
    }
    console.error(
      `\n  dry run complete — re-run without --dry-run to apply (or add --all to skip the prompt)`,
    );
    return;
  }

  // --all: install everything detected without prompting (works in CI/non-TTY).
  if (installAll) {
    console.error();
    for (const client of found) {
      console.error(`${client.platform}`);
      installPlatform(client.platform, dryRun, deps, { pluginsOnly });
    }
    return;
  }

  // Non-TTY without --all: print results + hint, don't install anything.
  if (!process.stdin.isTTY) {
    console.error();
    console.error(
      `  stdin is not a terminal — re-run with --all, or --platform <name>`,
    );
    return;
  }

  // Build the ask function: injected (tests) or real readline (production).
  // Mirrors cmdSetup's seam — one readline for the whole loop, closed after.
  const rl = deps.ask
    ? null
    : createInterface({ input: process.stdin, output: process.stdout });
  const askFn =
    deps.ask ??
    ((question: string, defaultVal?: string) => ask(rl!, question, defaultVal));

  // Prompt each detected client.
  try {
    console.error();
    for (const client of found) {
      const answer = await askFn(`install into ${client.platform}?`, "Y");
      if (isAffirmative(answer)) {
        console.error(`${client.platform}`);
        installPlatform(client.platform, dryRun, deps, { pluginsOnly });
      }
    }
  } finally {
    rl?.close();
  }
}

function installPlatform(
  platform: string,
  dryRun: boolean,
  deps: InstallDeps,
  opts: { pluginsOnly?: boolean } = {},
): void {
  switch (platform) {
    case "antigravity":
      cmdInstallAntigravity(dryRun, deps);
      break;
    case "claude":
      cmdInstallClaude(dryRun, deps);
      break;
    case "opencode":
      cmdInstallOpencode(dryRun, deps, opts);
      break;
    case "zcode":
      cmdInstallZcode(dryRun, deps);
      break;
    case "codex":
      cmdInstallCodex(dryRun, deps);
      break;
  }
}
