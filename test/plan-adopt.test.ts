import { test } from "bun:test";
// test/plan-adopt.test.ts — `fapony plan adopt <any-doc.md>` (src/plan/adopt.ts)
//
// Sync-only by scope: unique PLAN name, frontmatter + TL;DR prepend, verbatim
// doc body, refusal on collision, anchor echo. No LLM and no chunk-cutting.

import assert from "node:assert";
import { execSync } from "node:child_process";
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
import { cmdPlanAdopt } from "../src/plan/adopt.js";
import { initPlanStore } from "../src/plan/store.js";

// cmdPlanAdopt resolves via initPlanStore(cwd) — run fn inside that dir.
// A plain temp dir is enough: adopt never reads git or fael.
function withFixture(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "fapony-plan-adopt-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function withCwd(dir: string, fn: () => void): void {
  const orig = process.cwd();
  process.chdir(dir);
  try {
    fn();
  } finally {
    process.chdir(orig);
  }
}

/** Run adopt under captured stdout/stderr + exit stub; returns all three. */
function runAdopt(argv: string[]): {
  logs: string;
  errs: string;
  code: number | null;
} {
  let code: number | null = null;
  const origExit = process.exit;
  process.exit = ((c?: number) => {
    code = c ?? 0;
    throw new Error("__exit__");
  }) as never;
  // exit stub innermost (its throw unwinds past the captures), captures restore
  // in finally-style wrappers the same way test/plan-seed.ts does it manually
  const origLog = console.log;
  const origErr = console.error;
  const logLines: string[] = [];
  const errLines: string[] = [];
  console.log = (...a: unknown[]) => {
    logLines.push(a.map(String).join(" "));
  };
  console.error = (...a: unknown[]) => {
    errLines.push(a.map(String).join(" "));
  };
  try {
    cmdPlanAdopt(argv);
  } catch {
    // exit stub unwinds
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.exit = origExit;
  }
  return { logs: logLines.join("\n"), errs: errLines.join("\n"), code };
}

const DOC = `# Handoff from the ops team

The billing webhook drops events when Stripe retries overlap.
Please add an idempotency key per delivery and a replay endpoint.
`;

test("testPlanAdoptWritesPlanWithVerbatimBody", () => {
  withFixture((dir) => {
    mkdirSync(join(dir, "inbox"));
    const src = join(dir, "inbox", "billing-handoff.md");
    writeFileSync(src, DOC);
    withCwd(dir, () => {
      initPlanStore(dir);
      const { logs, code } = runAdopt([src]);
      assert.equal(code, null, "exits normally");
      const planPath = join(dir, ".fapony", "plan", "PLAN-billing-handoff.md");
      assert.ok(existsSync(planPath), "PLAN-billing-handoff.md written");
      const body = readFileSync(planPath, "utf-8");
      // frontmatter + TL;DR prepended
      assert.match(body, /^---\nkind: unit\nstatus: active\n---/);
      assert.match(body, /## TL;DR/);
      // one unchecked chunk — never a pre-ticked box, nothing pre-invented
      assert.match(body, /- \[ \] chunk 1/);
      assert.ok(!body.includes("- [x]"), "adopt never pre-ticks");
      // doc body kept verbatim, labelled as input not agreement
      assert.ok(
        body.includes(DOC.trimEnd()),
        "original doc body survives byte-for-byte",
      );
      assert.match(body, /## Context \(adopted from billing-handoff\.md\)/);
      // anchor echo on stdout
      assert.match(logs, /plan:billing-handoff/);
      // the source file is untouched
      assert.equal(readFileSync(src, "utf8"), DOC, "source doc untouched");
    });
  });
  console.log("  ✓ plan adopt writes a PLAN wrapping the doc verbatim");
});

test("testPlanAdoptUniqueNameUnderCollision", () => {
  withFixture((dir) => {
    const src = join(dir, "handoff.md");
    writeFileSync(src, DOC);
    mkdirSync(join(dir, ".fapony", "plan"), { recursive: true });
    writeFileSync(join(dir, ".fapony", "plan", "PLAN-handoff.md"), "existing");
    withCwd(dir, () => {
      initPlanStore(dir);
      const { logs, code } = runAdopt([src]);
      assert.equal(code, null);
      // the pre-existing file is not touched (no-overwrite rule)
      assert.equal(
        readFileSync(join(dir, ".fapony", "plan", "PLAN-handoff.md"), "utf-8"),
        "existing",
      );
      const planPath = join(dir, ".fapony", "plan", "PLAN-handoff-2.md");
      assert.ok(existsSync(planPath), "collision resolved to PLAN-handoff-2");
      assert.match(logs, /PLAN-handoff-2\.md/);
    });
  });
  console.log("  ✓ plan adopt picks a unique name instead of overwriting");
});

// A shipped PLAN-<slug>.md in done/ must not make the same-named doc
// unadoptable forever — done/ is part of the collision set, so the name rolls
// to -2 like a live plan/ collision does.
test("testPlanAdoptUniqueNameUnderDoneCollision", () => {
  withFixture((dir) => {
    const src = join(dir, "handoff.md");
    writeFileSync(src, DOC);
    mkdirSync(join(dir, ".fapony", "done"), { recursive: true });
    writeFileSync(join(dir, ".fapony", "done", "PLAN-handoff.md"), "shipped");
    withCwd(dir, () => {
      initPlanStore(dir);
      const { logs, code } = runAdopt([src]);
      assert.equal(code, null, "a done/ collision must not refuse");
      assert.ok(
        existsSync(join(dir, ".fapony", "plan", "PLAN-handoff-2.md")),
        "collision with done/ resolved to PLAN-handoff-2",
      );
      assert.match(logs, /PLAN-handoff-2\.md/);
    });
  });
  console.log("  ✓ plan adopt rolls past a shipped done/ name too");
});

test("testPlanAdoptRefusesWithoutTarget", () => {
  withFixture((dir) => {
    withCwd(dir, () => {
      initPlanStore(dir);
      const { errs, code } = runAdopt([]);
      assert.equal(code, 1);
      assert.match(errs, /usage: fapony plan adopt/);
    });
  });
  console.log("  ✓ plan adopt without a file arg prints usage and exits 1");
});

test("testPlanAdoptRefusesMissingFile", () => {
  withFixture((dir) => {
    withCwd(dir, () => {
      initPlanStore(dir);
      const { errs, code } = runAdopt([join(dir, "nope.md")]);
      assert.equal(code, 1);
      assert.match(errs, /not found/);
    });
  });
  console.log("  ✓ plan adopt refuses a nonexistent doc");
});

test("testPlanAdoptRefusesPlanShapedSource", () => {
  withFixture((dir) => {
    mkdirSync(join(dir, ".fapony", "plan"), { recursive: true });
    const src = join(dir, ".fapony", "plan", "PLAN-native.md");
    writeFileSync(src, "---\nkind: unit\n---\n");
    withCwd(dir, () => {
      initPlanStore(dir);
      const { errs, code } = runAdopt([src]);
      assert.equal(code, 1);
      assert.match(errs, /already looks like a PLAN/);
      // nothing was written
      assert.ok(!existsSync(join(dir, ".fapony", "plan", "PLAN-native-2.md")));
    });
  });
  console.log("  ✓ plan adopt refuses a file that is already a PLAN");
});

test("testPlanAdoptResolvesAgainstCwdFirst", () => {
  withFixture((dir) => {
    execSync("git init -q", { cwd: dir });
    mkdirSync(join(dir, "apps", "x"), { recursive: true });
    writeFileSync(join(dir, "apps", "x", "notes.md"), DOC);
    const sub = join(dir, "apps", "x");
    withCwd(sub, () => {
      initPlanStore(sub);
      const { errs, code } = runAdopt(["notes.md"]);
      assert.equal(code, null, errs);
    });
  });
  console.log("  ✓ plan adopt resolves a relative doc against cwd first");
});
