// src/setup.ts — interactive wizard: config + scaffold in one step.
// Replaces the manual cp + edit + init flow.

import { execSync } from "node:child_process";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { CONFIG_FILENAME, FAPONY_DIR } from "./core/config.js";
import { initProject } from "./init.js";
import { isAffirmative } from "./util.js";

export function ask(
  rl: ReturnType<typeof createInterface>,
  question: string,
  defaultVal?: string,
): Promise<string> {
  return new Promise((resolve) => {
    const suffix = defaultVal !== undefined ? ` (${defaultVal})` : "";
    rl.question(`  ${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultVal || "");
    });
  });
}

function defaultDetectGitRoot(): string | null {
  try {
    const root = execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 15_000,
    }).trim();
    return root;
  } catch {
    return null;
  }
}

export function defaultCheckCmd(cmd: string): boolean {
  // Allowlist first: cmd names are hardcoded at every call site, so anything
  // outside [word chars, dot, dash] is rejected before touching a shell.
  if (!/^[A-Za-z0-9_.-]+$/.test(cmd)) return false;
  try {
    execSync(`command -v ${cmd}`, { stdio: "pipe", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

/** Minimal seam for cmdSetup — only the I/O cmdSetup calls directly (the
 *  prerequisites check, git-root detection, prompting, and exit). fs/cwd stay
 *  real: tests run against a temp dir. Every field is used by both the
 *  default (production) path and the test path. */
export interface SetupDeps {
  checkCmd?: (cmd: string) => boolean;
  detectGitRoot?: () => string | null;
  ask?: (question: string, defaultVal?: string) => Promise<string>;
  exit?: (code: number) => never;
}

export interface SetupAnswers {
  worktreeName: string;
  worktreePath: string;
}

/** Pure config builder — the config-write path of cmdSetup, minus prompting.
 *  No executor/gate/auto-loop keys — nothing spawns agents anymore, the CLI
 *  loop was removed in Wave 2. Remaining advanced/optional keys are left for
 *  the user to hand-edit — see
 *  fapony.config.example.json. */
export function buildSetupConfig(a: SetupAnswers): Record<string, unknown> {
  const config: Record<string, unknown> = {
    worktrees: { [a.worktreeName]: a.worktreePath },
    review: { maxRounds: 2 },
    memory: null,
  };

  return config;
}

/** Null = path usable; otherwise the error message cmdSetup prints. */
export function validateWorktreePath(worktreePath: string): string | null {
  if (!worktreePath) return "Path must not be empty.";
  if (!existsSync(worktreePath)) return `Path does not exist: ${worktreePath}`;
  try {
    if (!statSync(worktreePath).isDirectory())
      return `Path is not a directory: ${worktreePath}`;
  } catch (e) {
    return `Cannot stat path: ${(e as Error).message}`;
  }
  return null;
}

/** Overwrite guard — only an affirmative answer proceeds with the write. */
export function shouldOverwriteConfig(answer: string): boolean {
  return isAffirmative(answer);
}

export async function cmdSetup(deps: SetupDeps = {}): Promise<void> {
  console.log("\n🔧 fapony setup — interactive wizard\n");

  const checkCmdFn = deps.checkCmd ?? defaultCheckCmd;
  const detectGitRootFn = deps.detectGitRoot ?? defaultDetectGitRoot;
  const exitFn = deps.exit ?? ((code: number): never => process.exit(code));
  /** Log + exit. Throws if a custom exit() ever returns instead of
   *  terminating (production process.exit never returns; without this,
   *  execution would fall through with git/bun missing). */
  const fail = (msg: string): never => {
    console.error(msg);
    exitFn(1);
    throw new Error("unreachable: exit() returned");
  };
  // Real readline only exists on the default path — injected ask (tests)
  // never touches stdin.
  const rl = deps.ask
    ? null
    : createInterface({ input: process.stdin, output: process.stdout });
  const askFn =
    deps.ask ??
    ((question: string, defaultVal?: string) => ask(rl!, question, defaultVal));

  try {
    // --- prerequisites ---
    if (!checkCmdFn("git")) {
      fail("❌ git is required but not found on PATH.");
    }
    if (!checkCmdFn("bun")) {
      fail(
        "❌ bun is required but not found on PATH.\n" +
          "   Install: curl -fsSL https://bun.sh/install | bash",
      );
    }

    // --- worktree path ---
    const gitRoot = detectGitRootFn();
    const defaultPath = gitRoot || process.cwd();
    const worktreePath = resolve(await askFn("Worktree path", defaultPath));

    const pathError = validateWorktreePath(worktreePath);
    if (pathError) {
      fail(`❌ ${pathError}`);
    }

    // --- worktree name ---
    const defaultName = worktreePath.split("/").pop() || "myapp";
    const worktreeName = await askFn(
      "Worktree name (key for CLI)",
      defaultName,
    );

    // --- write config ---
    // loadConfig() resolves to FAPONY_CONFIG or cwd/fapony.config.json, so a
    // cwd write is consistent — but warn when cwd isn't a fapony checkout,
    // or the config lands in a worktree where agents can see it.
    if (!existsSync(join(process.cwd(), "fapony.ts"))) {
      console.error(
        "⚠  cwd doesn't look like a fapony checkout (no fapony.ts) — " +
          "fapony.config.json will be written here. " +
          "Run setup from the fapony repo root if that's not what you want.",
      );
    }
    const config = buildSetupConfig({
      worktreeName,
      worktreePath,
    });

    const configPath = join(process.cwd(), CONFIG_FILENAME);
    if (existsSync(configPath)) {
      const overwrite = await askFn(
        "⚠  fapony.config.json already exists. Overwrite? (y/n)",
        "n",
      );
      if (!shouldOverwriteConfig(overwrite)) {
        console.log("\n  Skipped config write. Existing file kept.");
        return;
      }
    }

    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`\n  ✓  Wrote ${configPath}`);

    // --- scaffold worktree ---
    const faponyDir = join(worktreePath, FAPONY_DIR);
    if (!existsSync(faponyDir)) {
      try {
        initProject(worktreePath);
        console.log(`  ✓  Scaffolded .fapony/ in ${worktreePath}`);
      } catch (e) {
        console.log(`  ⚠  Scaffold skipped: ${(e as Error).message}`);
      }
    } else {
      console.log(`  ✓  .fapony/ already exists in ${worktreePath}`);
    }

    // --- done ---
    console.log(`
  ┌─────────────────────────────────────────┐
  │  Setup complete! Next steps:            │
  │                                         │
  │  1. Wire fapony into your clients:      │
  │     fapony install                      │
  │                                         │
  │  2. See where your plans stand:         │
  │     fapony plan                         │
  │                                         │
  │  3. Read a run's report:                │
  │     fapony report <run-id>              │
  └─────────────────────────────────────────┘
`);
  } finally {
    rl?.close();
  }
}
