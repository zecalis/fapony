import { test } from "bun:test";
// test/plan-next.test.ts — `fapony plan [<PLAN.md>]`
import assert from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cmdPlanNext } from "../src/plan/next.js";
import { initPlanStore } from "../src/plan/store.js";
import { openRowsFor } from "../src/plan/sweep.js";
import { captureLogs, withFakeFael, withTempRepo } from "./helpers.js";

const plan = (title: string, fm: string, ticks: string): string =>
  `---\nkind: unit\n${fm}---\n\n# ${title}\n\n## TL;DR\n${ticks}\n`;

function run(dir: string, args: string[]): string {
  const prev = process.cwd();
  process.chdir(dir);
  try {
    initPlanStore(dir);
    return captureLogs(() => cmdPlanNext(args));
  } finally {
    process.chdir(prev);
  }
}

test("testPlanListsActivePlansPriorityFirst", () => {
  withTempRepo((dir) => {
    const p = join(dir, ".fapony", "plan");
    mkdirSync(p, { recursive: true });
    writeFileSync(
      join(p, "PLAN-a.md"),
      plan("A", "", "- [x] chunk 1 — x\n- [ ] chunk 2 — do a"),
    );
    writeFileSync(
      join(p, "PLAN-b.md"),
      plan("B", "priority: high\n", "- [ ] chunk 1 — do b"),
    );
    writeFileSync(join(p, "PLAN-c.md"), "# C\n> ✅ **shipped 2026-09-01**\n");
    const out = run(dir, []);
    assert.ok(out.indexOf("PLAN-b.md") < out.indexOf("PLAN-a.md"), out);
    assert.match(out, /PLAN-a\.md — 1\/2 chunks\n {2}next: chunk 2 — do a/);
    assert.match(
      out,
      /shipped but not archived into done\/ \(1\)\n- PLAN-c\.md/,
    );
  });
});

test("testPlanShowsFaelHandoffRows", () => {
  withFakeFael((setRows) =>
    withTempRepo((dir) => {
      const p = join(dir, ".fapony", "plan");
      mkdirSync(p, { recursive: true });
      writeFileSync(join(p, "PLAN-x.md"), plan("X", "", "- [ ] chunk 1 — go"));
      setRows([
        {
          id: "n1",
          ts: "2026-09-25T00:00:00Z",
          kind: "note",
          text: "chunk 1 must know Y",
          files: ["src/a.ts", ".fapony/plan/PLAN-x.md"],
        },
        // imported rows carry the plan as spec only
        {
          id: "n2",
          ts: "2026-09-24T00:00:00Z",
          kind: "decision",
          text: "old spec-only row",
          spec: ".fapony/plan/PLAN-x.md",
        },
        {
          id: "n3",
          ts: "2026-09-24T00:00:00Z",
          kind: "note",
          text: "other plan",
          files: [".fapony/plan/PLAN-y.md"],
        },
      ]);
      const out = run(dir, ["PLAN-x"]);
      assert.match(out, /## unchecked\n- \[ \] chunk 1 — go/);
      assert.match(out, /## open in fael \(2\)/);
      assert.match(out, /note \[n1\] chunk 1 must know Y/);
      assert.match(out, /decision \[n2\] old spec-only row/);
      assert.ok(!out.includes("other plan"));
    }),
  );
});

test("testOpenRowsForMatchesPathAnchorAndKey", () => {
  withFakeFael((setRows) =>
    withTempRepo((dir) => {
      const p = join(dir, ".fapony", "plan");
      mkdirSync(p, { recursive: true });
      writeFileSync(
        join(p, "PLAN-Cal.md"),
        plan("Cal", "", "- [ ] chunk 1 — go"),
      );
      setRows([
        {
          id: "a",
          ts: "2026-09-25T00:00:00Z",
          kind: "note",
          text: "by path",
          files: ["src/a.ts", ".fapony/plan/PLAN-Cal.md"],
        },
        {
          id: "b",
          ts: "2026-09-25T00:00:00Z",
          kind: "note",
          text: "by anchor",
          files: ["src/a.ts", "plan:cal"],
        },
        {
          id: "c",
          ts: "2026-09-25T00:00:00Z",
          kind: "note",
          text: "by key",
          files: ["src/b.ts"],
          key: "plan:cal:chunk-2",
        },
        {
          id: "d",
          ts: "2026-09-25T00:00:00Z",
          kind: "decision",
          text: "bare key",
          key: "plan:cal",
        },
        // near misses: another plan whose name shares a prefix
        {
          id: "e",
          ts: "2026-09-25T00:00:00Z",
          kind: "note",
          text: "not mine anchor",
          files: ["plan:calendar"],
        },
        {
          id: "f",
          ts: "2026-09-25T00:00:00Z",
          kind: "note",
          text: "not mine key",
          key: "plan:calendar:chunk-1",
        },
      ]);
      const prev = process.cwd();
      process.chdir(dir);
      try {
        initPlanStore(dir);
        const ids = openRowsFor(join(p, "PLAN-Cal.md")).map((r) => r.id);
        assert.deepStrictEqual(ids.sort(), ["a", "b", "c", "d"]);
      } finally {
        process.chdir(prev);
      }
    }),
  );
});

test("testOpenRowsForSurvivesMoveToDone", () => {
  withFakeFael((setRows) =>
    withTempRepo((dir) => {
      const d = join(dir, ".fapony", "done");
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "PLAN-x.md"), "# X\n> ✅ **shipped 2026-09-01**\n");
      setRows([
        // written while the plan still lived in plan/
        {
          id: "a",
          ts: "2026-09-25T00:00:00Z",
          kind: "issue",
          text: "old path",
          files: [".fapony/plan/PLAN-x.md"],
        },
        {
          id: "b",
          ts: "2026-09-25T00:00:00Z",
          kind: "issue",
          text: "anchor",
          files: ["plan:x"],
        },
        {
          id: "c",
          ts: "2026-09-25T00:00:00Z",
          kind: "note",
          text: "key",
          key: "plan:x:chunk-3",
        },
      ]);
      const prev = process.cwd();
      process.chdir(dir);
      try {
        initPlanStore(dir);
        const ids = openRowsFor(join(d, "PLAN-x.md")).map((r) => r.id);
        assert.deepStrictEqual(ids.sort(), ["a", "b", "c"]);
      } finally {
        process.chdir(prev);
      }
    }),
  );
});

test("testPlanShowsNextChunkRowsFirst", () => {
  withFakeFael((setRows) =>
    withTempRepo((dir) => {
      const p = join(dir, ".fapony", "plan");
      mkdirSync(p, { recursive: true });
      writeFileSync(
        join(p, "PLAN-x.md"),
        plan(
          "X",
          "",
          "- [x] chunk 1 — done\n- [ ] chunk 2 — next\n- [ ] chunk 3 — later",
        ),
      );
      setRows([
        {
          id: "new",
          ts: "2026-09-26T00:00:00Z",
          kind: "note",
          text: "newest, other chunk",
          files: ["plan:x"],
          key: "plan:x:chunk-3",
        },
        {
          id: "hand",
          ts: "2026-09-24T00:00:00Z",
          kind: "note",
          text: "chunk 2 must know Y",
          files: ["src/a.ts", "plan:x"],
          key: "plan:x:chunk-2",
        },
        {
          id: "old",
          ts: "2026-09-25T00:00:00Z",
          kind: "note",
          text: "path row",
          files: [".fapony/plan/PLAN-x.md"],
        },
      ]);
      const out = run(dir, ["PLAN-x"]);
      assert.match(
        out,
        /## open in fael \(3\)\n- \S+ note \[hand\] plan:x:chunk-2 chunk 2 must know Y\n- \S+ note \[new\]/,
      );
      assert.ok(out.indexOf("[new]") < out.indexOf("[old]"), out);
    }),
  );
});

test("testPlanNextChunkLeadsWhenTheLabelIsBold", () => {
  withFakeFael((setRows) =>
    withTempRepo((dir) => {
      const p = join(dir, ".fapony", "plan");
      mkdirSync(p, { recursive: true });
      writeFileSync(
        join(p, "PLAN-x.md"),
        plan("X", "", "- [x] **chunk 1** — done\n- [ ] **chunk 2** — next"),
      );
      setRows([
        {
          id: "new",
          ts: "2026-09-26T00:00:00Z",
          kind: "note",
          text: "newest, no chunk",
          files: ["plan:x"],
        },
        {
          id: "hand",
          ts: "2026-09-24T00:00:00Z",
          kind: "note",
          text: "chunk 2 must know Y",
          files: ["src/a.ts", "plan:x"],
          key: "plan:x:chunk-2",
        },
      ]);
      const out = run(dir, ["PLAN-x"]);
      assert.ok(out.indexOf("[hand]") < out.indexOf("[new]"), out);
    }),
  );
});

test("testPlanOverflowNamesAnchorAndKeyCalls", () => {
  withFakeFael((setRows) =>
    withTempRepo((dir) => {
      const p = join(dir, ".fapony", "plan");
      mkdirSync(p, { recursive: true });
      writeFileSync(join(p, "PLAN-x.md"), plan("X", "", "- [ ] chunk 1 — go"));
      setRows(
        [1, 2, 3, 4, 5, 6].map((i) => ({
          id: `r${i}`,
          ts: `2026-09-2${i}T00:00:00Z`,
          kind: "note",
          text: `row ${i}`,
          files: ["src/a.ts"],
          key: `plan:x:chunk-${i}`,
        })),
      );
      const out = run(dir, ["PLAN-x"]);
      assert.match(
        out,
        /… \+1 more — fael find --files plan:x · fael find --key 'plan:x:\*'/,
      );
    }),
  );
});
