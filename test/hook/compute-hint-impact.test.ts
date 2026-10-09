import { test } from "bun:test";
// test/hook/compute-hint-impact.test.ts — hint-impact counts over the
// hint-fire log (digest reads it).
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeHintImpact, recordHintFire } from "../../src/hook.js";
import { withTempRepo } from "./helpers.js";

// --- Hint impact ---

test("testComputeHintImpact", () => {
  withTempRepo((dir) => {
    process.env.FAPONY_STATE_DIR = dir;
    try {
      for (const surface of ["read", "mem", "mem"] as const) {
        recordHintFire({
          ts: new Date().toISOString(),
          worktree: dir,
          surface,
          file: "src/a.ts",
          count: 1,
        });
      }
      const impact = computeHintImpact();
      assert.equal(impact.fired, 3);
      assert.equal(impact.by_surface.read, 1);
      assert.equal(impact.by_surface.mem, 2);
    } finally {
      delete process.env.FAPONY_STATE_DIR;
    }
  });
  console.log("  ✓ computeHintImpact: counts fires per surface");
});

test("testComputeHintImpactNoLog", () => {
  process.env.FAPONY_STATE_DIR = mkdtempSync(join(tmpdir(), "fapony-no-log-"));
  try {
    const impact = computeHintImpact();
    assert.equal(impact.fired, 0);
  } finally {
    delete process.env.FAPONY_STATE_DIR;
  }
  console.log("  ✓ computeHintImpact: no log → zero counts, no error");
});
