import { test } from "bun:test";
import assert from "node:assert";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cmdPlanSeed, renderKnownTraps } from "../src/seed/plan-seed.js";
import {
  captureLogs,
  type FaelFixtureRow,
  withFakeFael,
  withTempRepo,
} from "./helpers.js";

// --- helpers ---

// Rows the fake `fael` prints — reset per test by withFaelRepo.
let fixture: FaelFixtureRow[] = [];
let publish: (rows: FaelFixtureRow[]) => void = () => {};

function writeMemRow(
  _dir: string,
  id: string,
  kind: string,
  text: string,
  files?: string[],
): void {
  fixture.push({
    id,
    ts: "2026-09-22T12:00:00.000Z",
    kind: kind === "bug" ? "issue" : kind,
    text,
    ...(files ? { files } : {}),
  });
  publish(fixture);
}

function withFaelRepo(fn: (dir: string) => void): void {
  withFakeFael((setRows) => {
    fixture = [];
    publish = setRows;
    withTempRepo(fn);
  });
}

function writeFixture(dir: string): void {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "src", "calc.ts"),
    "export function add(a: number, b: number): number { return a + b; }\n",
  );
}

// --- renderKnownTraps unit tests ---

test("testKnownTrapsInjectsRowsMatchingScope", () => {
  withFaelRepo((dir) => {
    writeFixture(dir);
    writeMemRow(dir, "t1", "bug", "fix crash in add", ["src/calc.ts"]);
    writeMemRow(dir, "t2", "decision", "use no new deps", ["src/other.ts"]);
    writeMemRow(dir, "t3", "bug", "typed loosely in src/", []); // fallback row, no files[], text contains scope key "src"
    writeMemRow(dir, "t4", "decision", "limit scope", ["src/calc.ts"]);
    writeMemRow(dir, "t5", "note", "about calc.ts", ["src/calc.ts"]); // kind:note excluded

    const result = renderKnownTraps(dir, dir, [join(dir, "src")], true);
    // matched: t1 (bug, files), t3 (bug, fallback via text "src"), t4 (decision, files) = 3
    assert.equal(result.matched, 3, "bug + fallback bug + decision = 3");
    assert.equal(result.lacked, 1, "t3 has empty files[]");
    const spec = result.lines.join("\n");
    assert.match(spec, /### Known traps \(fael\)/);
    assert.match(
      spec,
      /3 relevant row\(s\) on this scope \(1 lacked files\[\] — matched via text\)/,
    );
    assert.match(spec, /typed loosely in src/); // fallback row present
    assert.match(spec, /\(src\/calc\.ts\)/); // file shown for rows with files[]
  });
  console.log("  ✓ known traps: scoped match injects correct rows");
});

test("testKnownTrapsBugBeforeDecision", () => {
  withFaelRepo((dir) => {
    writeFixture(dir);
    writeMemRow(dir, "d1", "decision", "old decision", ["src/calc.ts"]);
    writeMemRow(dir, "b1", "bug", "new bug", ["src/calc.ts"]);
    const result = renderKnownTraps(dir, dir, [join(dir, "src")], true);
    assert.equal(result.matched, 2);
    const bugIdx = result.lines.findIndex((l) => l.includes("bug"));
    const decIdx = result.lines.findIndex((l) => l.includes("decision"));
    assert.ok(bugIdx < decIdx, "bug must come before decision");
  });
  console.log("  ✓ known traps: bug rows sort before decision rows");
});

test("testKnownTrapsSilentWhenNoMemLog", () => {
  withFaelRepo((dir) => {
    writeFixture(dir);
    const result = renderKnownTraps(dir, dir, [join(dir, "src")], true);
    assert.equal(result.matched, 0);
    assert.deepEqual(result.lines, []);
  });
  console.log("  ✓ known traps: silent when no mem log");
});

test("testKnownTrapsSilentWhenNoMatch", () => {
  withFaelRepo((dir) => {
    writeFixture(dir);
    writeMemRow(dir, "z1", "bug", "about unrelated", ["src/nope.ts"]);
    const result = renderKnownTraps(dir, dir, [join(dir, "src")], true);
    assert.equal(result.matched, 0);
    assert.deepEqual(result.lines, []);
  });
  console.log("  ✓ known traps: silent when no rows match the scope");
});

test("testKnownTrapsCapFive", () => {
  withFaelRepo((dir) => {
    writeFixture(dir);
    for (let i = 0; i < 8; i++) {
      writeMemRow(dir, `b${i}`, "bug", `crash ${i}`, ["src/calc.ts"]);
    }
    const result = renderKnownTraps(dir, dir, [join(dir, "src")], true);
    assert.equal(result.matched, 8);
    assert.ok(
      result.lines.length > 4,
      "has heading + count + at least 5 rows + cut line",
    );
    const cut = result.lines.find((l) => l.includes("… +3 more"));
    assert.ok(cut, "cut line counts the overflow");
    assert.ok(!cut?.includes("120"), "cut line is not inside a text trim");
  });
  console.log("  ✓ known traps: caps at 5 rows, overflow line present");
});

test("testKnownTrapsSilentWhenUnscoped", () => {
  withFaelRepo((dir) => {
    writeFixture(dir);
    writeMemRow(dir, "b1", "bug", "about calc", ["src/calc.ts"]);
    // unscoped: scoped=false → whole repo; scopeFiles should be all source files,
    // and fallback is off (needs scoped=true) but files[] match still fires.
    const result = renderKnownTraps(dir, dir, [join(dir, "src")], false);
    assert.equal(result.matched, 1, "files[] match works unscoped");
    assert.equal(result.lacked, 0, "fallback off when unscoped");
  });
  console.log("  ✓ known traps: files[] match works unscoped, fallback off");
});

test("testKnownTrapsFallbackOnlyForEmptyFiles", () => {
  withFaelRepo((dir) => {
    writeFixture(dir);
    // Row WITH files[] — should NOT fall back to text match
    writeMemRow(dir, "f1", "bug", "about calc", ["src/calc.ts"]);
    // Row WITHOUT files[] that mentions src/calc.ts in text — should fallback match
    writeMemRow(dir, "f2", "bug", "fix calc path src/calc.ts", []);
    // Row WITH files[] that does NOT match scope — should NOT match even though text has src/
    writeMemRow(dir, "f3", "bug", "about src/calc.ts", ["src/other.ts"]);

    const result = renderKnownTraps(dir, dir, [join(dir, "src")], true);
    assert.equal(result.matched, 2, "f1 (files match) + f2 (fallback) = 2");
    assert.equal(result.lacked, 1, "f2 has empty files[]");
    assert.ok(
      !result.lines.some((l) => l.includes("f3")),
      "f3 is NOT matched (files[] present but wrong)",
    );
  });
  console.log(
    "  ✓ known traps: fallback only fires for rows with empty files[]",
  );
});

// --- e2e: traps land in the PLAN, never the SPEC ---

test("testPlanSeedInjectsTrapsIntoPlan", () => {
  withFaelRepo((dir) => {
    writeFixture(dir);
    writeMemRow(dir, "t1", "bug", "fix crash in add()", ["src/calc.ts"]);
    writeMemRow(dir, "t2", "decision", "use no deps", ["src/calc.ts"]);
    mkdirSync(join(dir, ".fapony", "plan"), { recursive: true });
    const orig = process.cwd();
    process.chdir(dir);
    try {
      const out = captureLogs(() =>
        cmdPlanSeed(["traps-test", "--spec", "--scope", "src"]),
      );
      assert.match(
        out,
        /Known traps: 2 row\(s\) injected \(0 lacked files\[\]\)/,
        "stdout reports trap count",
      );
      const plan = readFileSync(
        join(dir, ".fapony", "plan", "PLAN-traps-test.md"),
        "utf-8",
      );
      const ctx = plan.indexOf("## Context (fapony)");
      const traps = plan.indexOf("### Known traps (fael)");
      assert.ok(ctx >= 0 && ctx < traps, "traps sit inside Context (fapony)");
      assert.ok(
        traps < plan.indexOf("### Existing in scope"),
        "traps before the export list",
      );
      assert.match(plan, /2 relevant row\(s\) on this scope/);
      assert.ok(
        !plan.includes("Decisions on record"),
        "no unscoped recent-decision line",
      );
      const spec = readFileSync(
        join(dir, ".fapony", "spec", "SPEC-traps-test.md"),
        "utf-8",
      );
      assert.ok(!spec.includes("Known traps"), "SPEC stays signatures only");
    } finally {
      process.chdir(orig);
    }
  });
  console.log("  ✓ plan-seed puts Known traps in the PLAN Context");
});

test("testPlanSeedNoTrapsWhenNoMatch", () => {
  withFaelRepo((dir) => {
    writeFixture(dir);
    mkdirSync(join(dir, ".fapony", "plan"), { recursive: true });
    const orig = process.cwd();
    process.chdir(dir);
    try {
      const out = captureLogs(() =>
        cmdPlanSeed(["empty-traps", "--scope", "src"]),
      );
      assert.ok(
        !out.includes("Known traps"),
        "no traps line in stdout when 0 match",
      );
      const plan = readFileSync(
        join(dir, ".fapony", "plan", "PLAN-empty-traps.md"),
        "utf-8",
      );
      assert.ok(!plan.includes("Known traps"), "no traps block when 0 match");
    } finally {
      process.chdir(orig);
    }
  });
  console.log("  ✓ plan-seed: no traps block when 0 match");
});
