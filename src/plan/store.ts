// src/plan/store.ts — where plans live, resolved once per `fapony plan` run.
//
// plan/ and done/ sit side by side under the repo's `.fapony/` (nearest one
// walking up from cwd — app-scoped in a monorepo). done/ can be moved with
// paths.doneDir in fapony.config.json; a legacy plan/done/ is honoured.
// parked/ (beside plan/) holds plans set aside, not shipped — `plan park`.

import {
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { CONFIG_FILENAME, FAPONY_DIR } from "../core/config.js";
import { faponyDirFrom, repoRootOf } from "../core/fapony-dir.js";

export let root = "";
export let planBase = "";
export let planDir = "";
export let doneDir = "";
export let parkedDir = "";

export function initPlanStore(cwd: string = process.cwd()): void {
  root = repoRootOf(cwd) ?? cwd;
  planBase = faponyDirFrom(cwd);
  planDir = join(planBase, "plan");
  parkedDir = join(planBase, "parked");

  const configDir =
    planBase === join(root, FAPONY_DIR) ? root : dirname(planBase);
  let doneFromConfig: string | null = null;
  try {
    const paths = JSON.parse(
      readFileSync(join(configDir, CONFIG_FILENAME), "utf8"),
    )?.paths;
    if (typeof paths?.doneDir === "string")
      doneFromConfig = join(configDir, paths.doneDir);
  } catch {
    // no config — defaults below
  }
  doneDir =
    doneFromConfig ??
    (!existsSync(join(planBase, "done")) && existsSync(join(planDir, "done"))
      ? join(planDir, "done")
      : join(planBase, "done"));
}

export const rel = (p: string): string => relative(root, p) || ".";

/** Every dir a plan file can sit in — one list, so a new dir can't be missed. */
export const planDirs = (): string[] => [planDir, parkedDir, doneDir];
/** "plan/, parked/, done/" (repo-relative) for messages. */
export const planDirsText = (): string =>
  planDirs()
    .map((d) => `${rel(d)}/`)
    .join(", ");

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p; // dir not created yet
  }
};

/** `file` sits directly in `dir`, however it is spelt (symlinked .fapony/, ../). */
export const isIn = (file: string, dir: string): boolean =>
  real(dirname(file)) === real(dir);

// tmp-then-rename: two agents share one .fapony/, a reader never sees half a file
export const writeAtomic = (file: string, text: string): void => {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
};
