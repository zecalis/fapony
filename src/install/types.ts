// src/install/types.ts — shared types + constants for install providers

import { join } from "node:path";

/** Repo root (parent of src/) — absolute path to this fapony checkout,
 *  so hook commands work even before `bun link`. Same pattern as src/update.ts.
 *  Note: this file lives in src/install/, so ../.. reaches the repo root. */
export const INSTALL_ROOT = join(import.meta.dir, "..", "..");

export interface InstallDeps {
  exit?: (code: number) => never;
  /** Override os.homedir() for tests. */
  homedir?: () => string;
  /** Prompt the user (question → answer). Injected in tests; when absent,
   *  detect/prompt path prints results and exits instead of asking. */
  ask?: (question: string, defaultVal?: string) => Promise<string>;
  /** Check if a command is on PATH. Defaults to `command -v` with allowlist. */
  checkCmd?: (cmd: string) => boolean;
}

/** Default process exit. Shared by all providers — do not duplicate. */
export function defaultExit(code: number): never {
  return process.exit(code);
}

export type SkillLinkAction = "linked" | "already" | "conflict" | "pruned";

export interface SkillLinkResult {
  name: string;
  action: SkillLinkAction;
}
