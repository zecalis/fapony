import { test } from "bun:test";
// test/cli-list-flags.test.ts — PLAN-comma-x chunk 3: the contract, one table.
//
// A flag whose value is a SET must parse all four input shapes into the same
// set of items: `a,b` · `a, b` · `a,,b` · the flag repeated. Measured habit
// (mudqc686: 3 `--scope a,b` failures in one session) + the docs already
// teaching `,` make every unlisted shape a break of the product's own syntax.
//
// No shared parser (rule 1) — each command keeps its own argv loop; THIS
// table is the enforcement (rule 9: enforcing works, asking doesn't). The
// per-flag unit tests in each command's own file pin the fix details; this
// file pins the cross-command contract so a new list flag or a parse
// regression fails one obvious place.

import assert from "node:assert";
import { execSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdPlanSeed } from "../src/seed/plan-seed.js";
import { renderSeed } from "../src/seed/review-seed.js";
import { captureLogs, withTempRepo, withTmpDb } from "./helpers.js";

const root = join(import.meta.dir, "..");
const read = (rel: string): string => readFileSync(join(root, rel), "utf8");

/** The list flags of PLAN-comma-x §2 — the closed inventory (the 3 mem
 *  flags left with `fapony mem` when memory moved to fael). */
const TABLE: Record<string, { flag: string; a: string; b: string }> = {
  "review-seed --files": {
    flag: "--files",
    a: "src/multi.ts",
    b: "src/user.ts",
  },
  "review-seed --body": { flag: "--body", a: "alpha", b: "beta" },
  "review-seed --callers": { flag: "--callers", a: "alpha", b: "beta" },
  "plan-seed --scope": { flag: "--scope", a: "src", b: "other" },
};

const SHAPES = ["comma", "space", "empty", "repeat"] as const;
type Shape = (typeof SHAPES)[number];

/** The argv fragment that presents items a,b to `flag` in the given shape. */
function shapeArgs(flag: string, a: string, b: string, shape: Shape): string[] {
  if (shape === "repeat") return [flag, a, flag, b];
  const sep = shape === "space" ? ", " : shape === "empty" ? ",," : ",";
  return [flag, `${a}${sep}${b}`];
}

test("testCliListFlagTableIsTheFourFlags", () => {
  // The table IS the scope (§2). A tenth row needs a measured failure, not
  // a guess — a single-value flag in here would fake a contract it never had.
  assert.deepEqual(Object.keys(TABLE).sort(), [
    "plan-seed --scope",
    "review-seed --body",
    "review-seed --callers",
    "review-seed --files",
  ]);
  assert.equal(SHAPES.length, 4);
  console.log("  ✓ contract table = the 4 list flags × 4 shapes");
});

// --- review-seed --files / --body / --callers: one git fixture ---

/**
 * git repo with two commits: root (README) then sources — src/multi.ts
 * exporting alpha (line 1) + beta (line 4), src/user.ts importing both, and
 * a plan file for the scalar --plan contract below.
 */
function withSeedFixture(
  fn: (dir: string, shas: { root: string; head: string }) => void,
): void {
  const dir = mkdtempSync(join(tmpdir(), "fapony-cli-list-"));
  try {
    execSync("git init", { cwd: dir, stdio: "ignore" });
    execSync("git config user.email 'test@test.com'", {
      cwd: dir,
      stdio: "ignore",
    });
    execSync("git config user.name 'Test'", { cwd: dir, stdio: "ignore" });
    writeFileSync(join(dir, "README.md"), "# test repo\n");
    execSync("git add .", { cwd: dir, stdio: "ignore" });
    execSync('git commit -m "init"', { cwd: dir, stdio: "ignore" });
    const rootSha = execSync("git rev-parse HEAD", {
      cwd: dir,
      encoding: "utf-8",
    }).trim();

    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, ".fapony", "plan"), { recursive: true });
    writeFileSync(
      join(dir, "src", "multi.ts"),
      [
        "export function alpha(): number {",
        "  return 1;",
        "}",
        "export function beta(): number {",
        "  return 2;",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "src", "user.ts"),
      'import { alpha, beta } from "./multi.js";\nconsole.log(alpha(1), beta(2));\n',
    );
    writeFileSync(
      join(dir, ".fapony", "plan", "PLAN-contract.md"),
      "# PLAN-contract\n",
    );
    execSync("git add .", { cwd: dir, stdio: "ignore" });
    execSync('git commit -m "sources"', { cwd: dir, stdio: "ignore" });
    const headSha = execSync("git rev-parse HEAD", {
      cwd: dir,
      encoding: "utf-8",
    }).trim();

    fn(dir, { root: rootSha, head: headSha });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("testCliListFlagReviewSeedLookup", () => {
  withSeedFixture((dir) => {
    const filesSpec = TABLE["review-seed --files"];
    const bodySpec = TABLE["review-seed --body"];
    const callersSpec = TABLE["review-seed --callers"];
    for (const shape of SHAPES) {
      // --files: both paths land in the scope, counted as 2
      const files = renderSeed(
        shapeArgs(filesSpec.flag, filesSpec.a, filesSpec.b, shape),
        dir,
      );
      assert.match(files, /changed \(2\):/, `--files ${shape}:\n${files}`);
      assert.ok(files.includes("src/multi.ts"), files);
      assert.ok(files.includes("src/user.ts"), files);

      // --body: one declaration slice per symbol
      const body = renderSeed(
        [
          "--files",
          "src/multi.ts",
          ...shapeArgs(bodySpec.flag, bodySpec.a, bodySpec.b, shape),
        ],
        dir,
      );
      assert.ok(
        body.includes("src/multi.ts:1 alpha"),
        `--body ${shape} alpha:\n${body}`,
      );
      assert.ok(
        body.includes("src/multi.ts:4 beta"),
        `--body ${shape} beta:\n${body}`,
      );

      // --callers: a section per symbol, each with its own importer lines
      const callers = renderSeed(
        [
          "--files",
          "src/multi.ts",
          ...shapeArgs(callersSpec.flag, callersSpec.a, callersSpec.b, shape),
        ],
        dir,
      );
      assert.ok(
        callers.includes("callers of alpha"),
        `--callers ${shape} alpha:\n${callers}`,
      );
      assert.ok(
        callers.includes("callers of beta"),
        `--callers ${shape} beta:\n${callers}`,
      );
      const hitLines = callers
        .split("\n")
        .filter((l) => l.includes("src/user.ts:"));
      assert.equal(
        hitLines.length,
        2,
        `--callers ${shape} — one importer line per section:\n${callers}`,
      );
    }
  });
  console.log("  ✓ review-seed --files/--body/--callers × 4 shapes → same set");
});

// --- plan-seed --scope: writes only its own PLAN file (rule 6b), temp cwd ---

test("testCliListFlagPlanSeedScope", () => {
  const dir = mkdtempSync(join(tmpdir(), "fapony-cli-list-scope-"));
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "other"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(dir, "other", "b.ts"), "export const b = 1;\n");
    const t = TABLE["plan-seed --scope"];
    const prev = process.cwd();
    process.chdir(dir);
    try {
      let i = 0;
      for (const shape of SHAPES) {
        // plan-seed never overwrites — one throwaway name per shape.
        const name = `shape-${i++}`;
        captureLogs(() =>
          cmdPlanSeed([name, ...shapeArgs(t.flag, t.a, t.b, shape)]),
        );
        const plan = readFileSync(
          join(dir, ".fapony", "plan", `PLAN-${name}.md`),
          "utf8",
        );
        assert.ok(
          plan.includes("src/a.ts") && plan.includes("other/b.ts"),
          `plan-seed --scope ${shape} — both roots in scope:\n${plan}`,
        );
      }
    } finally {
      process.chdir(prev);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log("  ✓ plan-seed --scope × 4 shapes → both roots in scope");
});

// --- review-seed scalar flags: NOT list flags — conflict on different, ---

// equal is idempotent (chunk 2). staged (idempotent) and files (merge) have
// their own shape, pinned in test/review-seed.test.ts; the scalar half of
// the contract lives here beside the list table.
test("testCliListFlagScalarRepeatContract", () => {
  withSeedFixture((dir, shas) => {
    // equal repeat renders, never errors
    const okCommit = renderSeed(
      ["--commit", shas.root, "--commit", shas.root],
      dir,
    );
    assert.ok(okCommit.includes("README.md"), `equal --commit:\n${okCommit}`);
    const planRel = ".fapony/plan/PLAN-contract.md";
    const okPlan = renderSeed(["--plan", planRel, "--plan", planRel], dir);
    assert.match(okPlan, /worktree:/, `equal --plan:\n${okPlan}`);

    // different values → loud conflict, never last-wins
    assert.throws(
      () => renderSeed(["--commit", shas.root, "--commit", shas.head], dir),
      /given twice with different values/,
      "--commit with different shas must conflict",
    );
    assert.throws(
      () =>
        renderSeed(
          [
            "--range",
            `${shas.root}...${shas.head}`,
            "--range",
            `${shas.head}...${shas.root}`,
          ],
          dir,
        ),
      /given twice with different values/,
      "--range with different exprs must conflict",
    );
    assert.throws(
      () =>
        renderSeed(
          ["--plan", planRel, "--plan", ".fapony/plan/PLAN-other.md"],
          dir,
        ),
      /given twice with different values/,
      "--plan with different paths must conflict",
    );
  });
  console.log(
    "  ✓ review-seed scalar repeats: equal idempotent, different conflicts",
  );
});

// --- docs: the grep of done-criterion 7, mechanized (rule 9) ---

test("testCliListFlagDocsShowCommaShape", () => {
  // Every list flag printed in the CLI fences carries the comma shape — a
  // doc that teaches only one of the two accepted shapes is how the habit
  // (mudqc686) keeps hitting flags that "don't support commas".
  // README only — CLAUDE.md / AGENTS.md are local agent rules, not in git
  const readme = read("README.md");
  for (const literal of [
    "--files f1,f2",
    "[--scope <path>[,<path>]]...",
    "--body sym[,sym]",
    "--callers sym[,sym]",
  ]) {
    assert.ok(
      readme.includes(literal),
      `README.md must print the comma shape \`${literal}\` (PLAN-comma-x)`,
    );
  }
  // the installed skills teach the same shapes (chunk-3 note: skill/ sweep)
  const lookup = read("skill/lookup-before-edit/SKILL.md");
  assert.ok(lookup.includes("--body <sym>[,<sym>]"), "lookup-before-edit body");
  assert.ok(
    lookup.includes("--callers <sym>[,<sym>]"),
    "lookup-before-edit callers",
  );
  const pony = read("skill/review-pony/SKILL.md");
  assert.ok(pony.includes("--body <sym>[,<sym>]"), "review-pony body");
  assert.ok(pony.includes("--callers <sym>[,<sym>]"), "review-pony callers");
  console.log("  ✓ docs + skills print the comma shape for every list flag");
});
