import { test } from "bun:test";
// test/plan-seed.test.ts — tests for `fapony plan-seed` (src/plan-seed.ts)

import assert from "node:assert";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdPlanSeed } from "../src/seed/plan-seed.js";
import { captureErrors, captureLogs } from "./helpers.js";

// Fixture with one module dir + one root file. The mem/ledger reads inside
// Context (fapony) tolerate any cwd (no log → empty block), so a plain temp
// dir is enough — no git repo needed.
function withFixture(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "fapony-plan-seed-"));
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(
      join(dir, "src", "calc.ts"),
      "export function add(a: number, b: number): number { return a + b; }\n",
    );
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// cmdPlanSeed resolves planDir/specDir against process.cwd() — run fn there.
function withCwd(dir: string, fn: () => void): void {
  const orig = process.cwd();
  process.chdir(dir);
  try {
    fn();
  } finally {
    process.chdir(orig);
  }
}

test("testPlanSeedWritesPlan", () => {
  withFixture((dir) => {
    withCwd(dir, () => {
      cmdPlanSeed(["foo"]);
      const planPath = join(dir, ".fapony", "plan", "PLAN-foo.md");
      assert.ok(existsSync(planPath), "PLAN-foo.md written");
      const body = readFileSync(planPath, "utf-8");
      // §2/§5 carry no seeded facts (2026-09-18) — measured 3-of-3 empty, so
      // they are judgment slots like every other section now
      assert.ok(!body.includes("(source scan)"), "§2 seeds nothing");
      assert.ok(!body.includes("(fapony analyze)"), "§5 seeds nothing");
      assert.match(body, /## 2\. Scope \(do \/ don't do\)/);
      assert.match(body, /## 5\. Risks & Escape hatches/);
      // judgment sections are agent slots, not pre-invented
      assert.match(body, /_\(agent fills in\)_/);
      // ledger context sits under the TL;DR, above §1 — below §8 nobody read it
      assert.ok(
        body.indexOf("## Context (fapony)") < body.indexOf("## 1. Goal"),
        "Context (fapony) is above the sections, not buried at the end",
      );
      // frontmatter (read by people since plan_list was removed)
      assert.match(body, /^---\nkind: unit\nstatus: active\n---/);
    });
  });
  console.log("  ✓ plan-seed writes PLAN with agent slots + ledger context");
});

test("testPlanSeedNoOverwrite", () => {
  withFixture((dir) => {
    withCwd(dir, () => {
      cmdPlanSeed(["foo"]);
      const planPath = join(dir, ".fapony", "plan", "PLAN-foo.md");
      const before = readFileSync(planPath, "utf-8");
      let code: number | null = null;
      const origExit = process.exit;
      const errs = captureErrors(() => {
        process.exit = ((c?: number) => {
          code = c ?? 0;
          throw new Error("__exit__");
        }) as never;
        try {
          cmdPlanSeed(["foo"]);
        } catch {
          // exit stub unwinds
        } finally {
          process.exit = origExit;
        }
      });
      assert.equal(code, 1);
      assert.match(errs, /already exists/);
      assert.equal(readFileSync(planPath, "utf-8"), before, "file untouched");
    });
  });
  console.log("  ✓ plan-seed refuses to overwrite an existing plan");
});

test("testPlanSeedSpecSignatures", () => {
  withFixture((dir) => {
    withCwd(dir, () => {
      cmdPlanSeed(["foo", "--spec"]);
      const specPath = join(dir, ".fapony", "spec", "SPEC-foo.md");
      const planPath = join(dir, ".fapony", "plan", "PLAN-foo.md");
      const spec = readFileSync(specPath, "utf-8");
      const plan = readFileSync(planPath, "utf-8");
      // chunk index links the module anchor
      assert.match(spec, /\[src\]\(#src\)/);
      assert.match(spec, /id="src"/);
      // signature matches the source declaration verbatim
      assert.match(
        spec,
        /`1`\s+fn\s+export function add\(a: number, b: number\): number/,
      );
      // plan links out to spec, holds no signatures itself
      assert.match(plan, /SPEC-foo\.md/);
      assert.doesNotMatch(plan, /export function add/);
      // spec backlinks the plan
      assert.match(spec, /Used by.*PLAN-foo/);
      // small fixture → no scope echo line, no cap markers
      assert.ok(!spec.includes("**Scope:**"), "no scope echo without --scope");
      assert.ok(!spec.includes("… +"), "caps stay silent on a small tree");
    });
  });
  console.log(
    "  ✓ plan-seed --spec writes chunked SPEC with verbatim signatures",
  );
});

test("testPlanSeedScopeFilters", () => {
  const dir = mkdtempSync(join(tmpdir(), "fapony-plan-seed-scope-"));
  try {
    const comp = join(dir, "apps", "vela", "src", "components");
    mkdirSync(comp, { recursive: true });
    mkdirSync(join(dir, "other"), { recursive: true });
    for (const name of ["User", "Order", "Date"]) {
      writeFileSync(
        join(comp, `format${name}.ts`),
        `export function format${name}(x: string): string { return x; }\n`,
      );
    }
    writeFileSync(
      join(dir, "other", "lonely.ts"),
      "export function lonelyThing(): void {}\n",
    );
    // §8 prior art: one shipped plan that names the scope, one that doesn't.
    mkdirSync(join(dir, ".fapony", "done"), { recursive: true });
    mkdirSync(join(dir, ".fapony", "spec"), { recursive: true });
    writeFileSync(
      join(dir, ".fapony", "done", "PLAN-formatters.md"),
      "# PLAN-formatters — money formatting\n\n> shipped 2026-01-02\n\ntouched apps/vela/src/components\n",
    );
    writeFileSync(
      join(dir, ".fapony", "done", "PLAN-elsewhere.md"),
      "# PLAN-elsewhere\n\nonly ever touched other/\n",
    );
    withCwd(dir, () => {
      // --scope value comes FIRST — it must never be mistaken for the name
      cmdPlanSeed(["--scope", "apps/vela/src/components", "scoped"]);
      const plan = readFileSync(
        join(dir, ".fapony", "plan", "PLAN-scoped.md"),
        "utf-8",
      );
      assert.ok(plan.includes("PLAN-scoped"), "--scope value is not the name");
      // §8 points at the shipped plan that already decided something here —
      // and never at the one that didn't (that list would match everything)
      assert.match(
        plan,
        // title keeps only what the filename doesn't already say
        /Already decided: \[PLAN-formatters\.md\]\(\.\.\/done\/PLAN-formatters\.md\) — money formatting \(shipped 2026-01-02\)/,
      );
      assert.ok(!plan.includes("PLAN-elsewhere"), "§8 stays inside the scope");

      // Same tree, no --scope → §8 goes quiet: every shipped plan matches, so a
      // list of everything would point at nothing
      cmdPlanSeed(["wide"]);
      const wide = readFileSync(
        join(dir, ".fapony", "plan", "PLAN-wide.md"),
        "utf-8",
      );
      assert.ok(
        !wide.includes("Already decided"),
        "§8 prior art needs a --scope to join on",
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log("  ✓ plan-seed --scope filters §8 and never eats the name");
});

test("testPlanSeedCapsHold", () => {
  const dir = mkdtempSync(join(tmpdir(), "fapony-plan-seed-caps-"));
  try {
    // 6 modules × 10 files × 4 exports — enough to trip the per-chunk cap,
    // the whole-SPEC cap, the §2 cluster cap and the §5 risks cap. The token
    // is keyed by FILE index, so each alpha<f> family appears in all 6
    // modules: 10 cross-directory clusters, over the 5 §2 shows.
    for (let m = 0; m < 6; m++) {
      const mod = join(dir, `mod${m}`);
      mkdirSync(mod, { recursive: true });
      for (let f = 0; f < 10; f++) {
        writeFileSync(
          join(mod, `file${f}.ts`),
          [
            `export function alpha${f}One(): void {}`,
            `export function alpha${f}Two(): void {}`,
            `export function alpha${f}Three(): void {}`,
            `export function beta${f}One(): void {}`,
            "",
          ].join("\n"),
        );
      }
    }
    withCwd(dir, () => {
      cmdPlanSeed(["big", "--spec"]);
      const plan = readFileSync(
        join(dir, ".fapony", "plan", "PLAN-big.md"),
        "utf-8",
      );
      const spec = readFileSync(
        join(dir, ".fapony", "spec", "SPEC-big.md"),
        "utf-8",
      );
      // Done criterion 1 (§3): PLAN ≤ 60, SPEC ≤ 200 — content lines
      // (a trailing newline is not a line).
      assert.ok(
        plan.replace(/\n$/, "").split("\n").length <= 60,
        `PLAN capped (got ${plan.split("\n").length})`,
      );
      assert.ok(
        spec.replace(/\n$/, "").split("\n").length <= 200,
        `SPEC capped (got ${spec.split("\n").length})`,
      );
      // Caps always say what was cut, never cut silently.
      assert.match(spec, /… \+\d+ more signatures/);
      assert.match(spec, /… \+\d+ more lines/);
      // The PLAN has no seeded sections left to cap — its ≤ 60 is structural.
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log("  ✓ plan-seed caps hold: PLAN ≤ 60 / SPEC ≤ 200 with markers");
});

test("testPlanSeedSingleFileScope", () => {
  const dir = mkdtempSync(join(tmpdir(), "fapony-plan-seed-file-"));
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(
      join(dir, "src", "util.ts"),
      [
        "export function fmt(x: string): string { return x; }",
        "export function parse(s: string): unknown { return s; }",
        "",
      ].join("\n"),
    );
    withCwd(dir, () => {
      cmdPlanSeed(["file", "--spec", "--scope", "src/util.ts"]);
      const spec = readFileSync(
        join(dir, ".fapony", "spec", "SPEC-file.md"),
        "utf-8",
      );
      // SPEC chunk index links the file
      assert.match(spec, /\[util\.ts\]\(#util-ts\)/);
      // Signatures are present
      assert.match(spec, /export function fmt/);
      assert.match(spec, /export function parse/);
      // Scope echo present in SPEC
      assert.match(spec, /\*\*Scope:\*\* src\/util\.ts/);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(
    "  ✓ plan-seed --scope <file> produces SPEC chunk with signatures",
  );
});

test("testPlanSeedOverlapScopeDedup", () => {
  const dir = mkdtempSync(join(tmpdir(), "fapony-plan-seed-overlap-"));
  try {
    mkdirSync(join(dir, "src", "utils"), { recursive: true });
    writeFileSync(join(dir, "src", "index.ts"), "export const a = 1;\n");
    writeFileSync(join(dir, "src", "utils", "b.ts"), "export const b = 2;\n");
    withCwd(dir, () => {
      cmdPlanSeed([
        "overlap",
        "--spec",
        "--scope",
        "src",
        "--scope",
        "src/utils",
      ]);
      const spec = readFileSync(
        join(dir, ".fapony", "spec", "SPEC-overlap.md"),
        "utf-8",
      );
      // src/utils is nested in src — each file appears once, not twice
      assert.strictEqual(
        spec.split("export const b = 2").length - 1,
        1,
        "nested --scope root does not duplicate a file",
      );
      assert.strictEqual(spec.split("export const a = 1").length - 1, 1);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(
    "  ✓ plan-seed prunes nested --scope roots to avoid double-count",
  );
});

test("testPlanSeedConfigFallback", () => {
  withFixture((dir) => {
    // planDir/specDir are hardcoded — not configurable (gitignored = private).
    // A broken config must fall back to defaults without throwing.
    writeFileSync(join(dir, "fapony.config.json"), "{broken json");
    withCwd(dir, () => {
      cmdPlanSeed(["baz"]);
      assert.ok(existsSync(join(dir, ".fapony", "plan", "PLAN-baz.md")));
    });
  });
  console.log(
    "  ✓ plan-seed: broken config falls back to defaults (planDir is hardcoded)",
  );
});

test("testPlanSeedStepSixPointsAtTheRuleInsteadOfCopyingIt", () => {
  withFixture((dir) => {
    withCwd(dir, () => {
      cmdPlanSeed(["Bar"]);
      const body = readFileSync(
        join(dir, ".fapony", "plan", "PLAN-Bar.md"),
        "utf-8",
      );
      const s6 = body.slice(body.indexOf("## 6."), body.indexOf("## 7."));
      // A copy baked in at seed time drifts (4 variants across 21 plans):
      // §6 names the command that prints the current rule, nothing more.
      assert.ok(
        s6.includes("`fapony plan PLAN-Bar.md` prints"),
        "§6 must point at the command that prints the rule",
      );
      assert.ok(!s6.includes("up to 3 chunks"), "no batching rule in §6");
      assert.ok(!s6.includes("fael add note"), "no closing recipe in §6");
      assert.ok(!s6.includes(".fapony/plan/PLAN-"), "no plan path in §6");
      assert.ok(s6.includes("- [ ] handoff:"), "Stop-hook opt-in box stays");
    });
  });
  console.log(
    "  ✓ plan-seed: §6 points at `fapony plan`, carries no rule copy",
  );
});

// Chunk 4 (PLAN-seed-and-surface): PLAN carries "Existing in scope" — one
// line per scope file naming its exports — inside the ≤ ~60 budget.
test("testPlanSeedExistingInScope", () => {
  const dir = mkdtempSync(join(tmpdir(), "fapony-plan-seed-existing-"));
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(
      join(dir, "src", "a.ts"),
      "export function alpha(): void {}\nexport const beta = 1;\n",
    );
    writeFileSync(join(dir, "src", "b.ts"), "export class Gamma {}\n");
    writeFileSync(join(dir, "src", "empty.ts"), "const local = 1;\n");
    withCwd(dir, () => {
      captureLogs(() => cmdPlanSeed(["scoped", "--scope", "src"]));
      const plan = readFileSync(
        join(dir, ".fapony", "plan", "PLAN-scoped.md"),
        "utf-8",
      );
      assert.match(plan, /### Existing in scope/);
      // real export names, fn with parens, file with no exports skipped
      assert.ok(plan.includes("src/a.ts — alpha() · beta"), "a.ts exports");
      assert.ok(plan.includes("src/b.ts — Gamma"), "b.ts exports");
      assert.ok(!plan.includes("empty.ts"), "export-less file skipped");
      assert.ok(
        plan.replace(/\n$/, "").split("\n").length <= 60,
        "scoped PLAN still fits the ≤ 60 contract",
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log("  ✓ plan-seed --scope lists existing exports in the PLAN");
});

test("testPlanSeedExistingInScopeListsRustPubItems", () => {
  // SPEC §5: a Rust scope lists its `pub` items (column 0 only); private items
  // and `impl` methods stay out, and a .rs file does not enter the import graph.
  const dir = mkdtempSync(join(tmpdir(), "fapony-plan-seed-rust-"));
  try {
    mkdirSync(join(dir, "core", "src"), { recursive: true });
    writeFileSync(
      join(dir, "core", "src", "lookup.rs"),
      [
        "pub fn resolve() {}",
        "pub(crate) struct KeyUse;",
        "pub async fn fetch() {}",
        "pub const MAX: usize = 3;",
        "pub use matching::glob;",
        "pub use compact::{Opts as CompactOpts, compact, self};",
        "pub(crate) use query::{",
        "    Filter, // the filter",
        "    nested::{deep, *},",
        "};",
        "fn private() {}",
        "impl KeyUse {",
        "    pub fn method(&self) {}",
        "}",
        "",
      ].join("\n"),
    );
    withCwd(dir, () => {
      captureLogs(() => cmdPlanSeed(["rs", "--scope", "core/src"]));
      const plan = readFileSync(
        join(dir, ".fapony", "plan", "PLAN-rs.md"),
        "utf-8",
      );
      assert.ok(
        plan.includes(
          "core/src/lookup.rs — resolve() · KeyUse · fetch() · MAX · glob · CompactOpts · compact · Filter · deep",
        ),
        plan,
      );
      assert.ok(!plan.includes("private") && !plan.includes("method"));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log("  ✓ plan-seed --scope lists Rust pub items");
});

test("testPlanSeedExistingInScopePlaceholders", () => {
  // No exports in scope → honest one-liner, not an empty heading.
  const dir = mkdtempSync(join(tmpdir(), "fapony-plan-seed-noexport-"));
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "empty.ts"), "const local = 1;\n");
    withCwd(dir, () => {
      captureLogs(() => cmdPlanSeed(["noexp", "--scope", "src"]));
      const plan = readFileSync(
        join(dir, ".fapony", "plan", "PLAN-noexp.md"),
        "utf-8",
      );
      assert.ok(plan.includes("_(no exports in scope)_"));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // No --scope → every file matches, so a list would point at nothing (§8
  // prior art goes quiet for the same reason).
  withFixture((dir) => {
    withCwd(dir, () => {
      captureLogs(() => cmdPlanSeed(["wide"]));
      const plan = readFileSync(
        join(dir, ".fapony", "plan", "PLAN-wide.md"),
        "utf-8",
      );
      assert.ok(plan.includes("re-seed with --scope <dir> to list exports"));
      assert.ok(
        plan.replace(/\n$/, "").split("\n").length <= 60,
        "unscoped PLAN fits the ≤ 60 contract",
      );
    });
  });
  console.log("  ✓ plan-seed Existing block degrades to a placeholder");
});

test("testPlanSeedExistingInScopeCap", () => {
  // 20 files with exports: the block caps at 15 lines, says what was cut,
  // and the whole file still fits ≤ 60.
  const dir = mkdtempSync(join(tmpdir(), "fapony-plan-seed-existing-cap-"));
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    for (let f = 0; f < 20; f++) {
      writeFileSync(
        join(dir, "src", `f${String(f).padStart(2, "0")}.ts`),
        `export function fn${f}(): void {}\n`,
      );
    }
    withCwd(dir, () => {
      captureLogs(() => cmdPlanSeed(["capped", "--scope", "src"]));
      const plan = readFileSync(
        join(dir, ".fapony", "plan", "PLAN-capped.md"),
        "utf-8",
      );
      const block = plan.slice(
        plan.indexOf("### Existing in scope"),
        plan.indexOf("## 1. Goal"),
      );
      // Both caps hold under pressure: the block never exceeds its own 15
      // (the ≤ 60 total may shrink it further via the budget backstop).
      const blockLines = block
        .split("\n")
        .filter((l) => l.startsWith("- src/") || l.startsWith("… +"));
      assert.ok(
        blockLines.length <= 15,
        `block capped (got ${blockLines.length})`,
      );
      assert.match(block, /… \+\d+ more files in scope/);
      assert.ok(
        plan.replace(/\n$/, "").split("\n").length <= 60,
        "over-cap scope still fits the ≤ 60 contract",
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log("  ✓ plan-seed Existing block caps at 15 with a marker");
});

// Chunk 5 (PLAN-seed-and-surface): stdout ends with the plans that already
// exist in planDir + doneDir (cap 10), minus the file just written.
test("testPlanSeedListsExistingPlans", () => {
  withFixture((dir) => {
    mkdirSync(join(dir, ".fapony", "done"), { recursive: true });
    writeFileSync(join(dir, ".fapony", "done", "PLAN-old.md"), "# PLAN-old\n");
    withCwd(dir, () => {
      const out = captureLogs(() => cmdPlanSeed(["fresh"]));
      assert.match(out, /wrote .*PLAN-fresh\.md/);
      assert.match(out, /Existing plans:/);
      assert.ok(out.includes("PLAN-old.md (done)"), "shipped plan listed");
      assert.ok(
        !out.includes("- PLAN-fresh.md (plan)"),
        "just-written file excluded from the list (not from the wrote line)",
      );
    });
  });
  console.log("  ✓ plan-seed stdout ends with existing plans");
});

test("testPlanSeedExistingPlansCap", () => {
  // 12 pre-existing plans: 10 listed, the cut counted, active first.
  const dir = mkdtempSync(join(tmpdir(), "fapony-plan-seed-planlist-"));
  try {
    mkdirSync(join(dir, ".fapony", "plan"), { recursive: true });
    mkdirSync(join(dir, ".fapony", "done"), { recursive: true });
    for (let i = 0; i < 7; i++) {
      writeFileSync(
        join(dir, ".fapony", "plan", `PLAN-p${i}.md`),
        `# PLAN-p${i}\n`,
      );
    }
    for (let i = 0; i < 5; i++) {
      writeFileSync(
        join(dir, ".fapony", "done", `PLAN-d${i}.md`),
        `# PLAN-d${i}\n`,
      );
    }
    withCwd(dir, () => {
      const out = captureLogs(() => cmdPlanSeed(["fresh2"]));
      const listed = out.split("\n").filter((l) => l.startsWith("- PLAN-"));
      // capLines keeps cap-1 + a marker that counts the cut (12 → 9 + marker).
      assert.equal(listed.length, 9);
      assert.match(out, /… \+3 more plans/);
      assert.ok(
        out.indexOf("PLAN-p0.md (plan)") < out.indexOf("PLAN-d0.md (done)"),
        "active plans sort before shipped ones",
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log("  ✓ plan-seed plan list caps at 10, active first");
});

test("testPlanSeedScopeCommaList", () => {
  // Agents type `--scope a,b,c` — the comma shape --files already accepts
  // (measured 3 failures in one session → 2d28ed7) — and `--scope a, b`
  // with the space. Splitting without trimming makes " b" a path that is
  // not (PLAN-comma-x).
  const dir = mkdtempSync(join(tmpdir(), "fapony-plan-seed-comma-"));
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "other"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(dir, "other", "b.ts"), "export const b = 1;\n");
    withCwd(dir, () => {
      cmdPlanSeed(["comma", "--scope", "src, other"]);
      const plan = readFileSync(
        join(dir, ".fapony", "plan", "PLAN-comma.md"),
        "utf-8",
      );
      assert.ok(
        plan.includes("src/a.ts") && plan.includes("other/b.ts"),
        "comma-separated --scope roots are all in scope",
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log("  ✓ plan-seed --scope accepts comma lists (space trimmed)");
});
