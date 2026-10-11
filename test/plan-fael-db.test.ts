import { test } from "bun:test";
// test/plan-fael-db.test.ts — a plan cut over to fael (its TL;DR is fael's
// read-only mirror) offers no chunk and prints no md closing rules: fael's
// `chunk done` text is the hand-off, a handoff note would write it twice.
import assert from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cmdPlanNext } from "../src/plan/next.js";
import { initPlanStore } from "../src/plan/store.js";
import { captureLogs, withFakeFael, withTempRepo } from "./helpers.js";

test("testCutOverPlanPointsAtFael", () => {
  withFakeFael(() =>
    withTempRepo((dir) => {
      const p = join(dir, ".fapony", "plan");
      mkdirSync(p, { recursive: true });
      writeFileSync(
        join(p, "PLAN-x.md"),
        "---\nkind: unit\n---\n\n# X\n\n## TL;DR\n- chunks live in fael — `fael board`, `fael plan export x` (mirror: edits here change nothing)\n- [x] c1 — done\n- [ ] c2 — open\n",
      );
      const prev = process.cwd();
      process.chdir(dir);
      try {
        initPlanStore(dir);
        const out = captureLogs(() => cmdPlanNext(["PLAN-x.md"]));
        assert.match(out, /chunks live in fael \(/);
        assert.match(out, /fael chunk done <uid>/);
        assert.doesNotMatch(out, /## closing/);
        assert.doesNotMatch(out, /--key plan:x:handoff/);
      } finally {
        process.chdir(prev);
      }
    }),
  );
});
