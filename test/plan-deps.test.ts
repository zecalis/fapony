import { test } from "bun:test";
// test/plan-deps.test.ts — dep-graph + blocked views (PLAN-doc-chain/ship-gate slot):
// frontmatter blocked_by/blocks is already written by agents but no tool read
// it — plan-check now flags dangling refs, shipped-but-still-blocked, cycles,
// and blocked-with-all-chunks-ticked; plan-sweep reports blocked files and
// prints an unblock hint on --apply.

import assert from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initPlanStore } from "../src/plan/store.js";
import {
  cmdPlanSweep,
  collectBlockedTickedIssues,
  collectDepIssues,
  countFirstSection,
  extractPlanRefs,
  parsePlanFrontmatter,
} from "../src/plan/sweep.js";
import { captureLogs, withTempRepo } from "./helpers.js";

const FAPONY = join(import.meta.dir, "..", "fapony.ts");

function setup(dir: string, plans: Record<string, string>): void {
  mkdirSync(join(dir, ".fapony", "plan"), { recursive: true });
  mkdirSync(join(dir, ".fapony", "done"), { recursive: true });
  for (const [name, body] of Object.entries(plans))
    writeFileSync(join(dir, ".fapony", "plan", name), body);
}

function inRepo(dir: string, fn: () => void): void {
  const prev = process.cwd();
  process.chdir(dir);
  try {
    initPlanStore(dir);
    fn();
  } finally {
    process.chdir(prev);
  }
}

const activeBody = (fm: string, chunks = "- [ ] chunk 1 — next\n"): string =>
  `${fm}\n\n# T\n\n## TL;DR\n${chunks}`;

test("testParseFrontmatterAndRefs", () => {
  withTempRepo((dir) => {
    setup(dir, {
      "PLAN-a.md": activeBody(
        "---\nstatus: blocked\nblocked_by: PLAN-ship-gate.md\nblocks: PLAN-x.md, PLAN-y.md\n---",
      ),
      "PLAN-s.md": activeBody(
        "---\nstatus: blocked\nblocked_by: waiting on support email wording\n---",
      ),
    });
    inRepo(dir, () => {
      const fm = parsePlanFrontmatter(
        join(dir, ".fapony", "plan", "PLAN-a.md"),
      );
      assert.equal(fm.status, "blocked");
      assert.deepEqual(extractPlanRefs(fm.blockedByRaw), ["PLAN-ship-gate.md"]);
      assert.deepEqual(extractPlanRefs(fm.blocksRaw), [
        "PLAN-x.md",
        "PLAN-y.md",
      ]);
      // sentence value carries no PLAN token — never a file ref
      const fs = parsePlanFrontmatter(
        join(dir, ".fapony", "plan", "PLAN-s.md"),
      );
      assert.deepEqual(extractPlanRefs(fs.blockedByRaw), []);
    });
  });
  console.log("  ✓ parsePlanFrontmatter: refs extracted, sentences skipped");
});

test("testDepIssuesDanglingAndUnblocked", () => {
  withTempRepo((dir) => {
    setup(dir, {
      "PLAN-doc-chain.md": activeBody(
        "---\nstatus: blocked\nblocked_by: PLAN-ship-gate.md\n---",
      ),
      "PLAN-dangle.md": activeBody(
        "---\nstatus: blocked\nblocked_by: PLAN-nope.md\n---",
      ),
      "PLAN-ship-gate.md": activeBody("---\nstatus: active\n---"),
    });
    // blocker ships to done/ → dependent must flag as unblock-ready
    mkdirSync(join(dir, ".fapony", "done"), { recursive: true });
    writeFileSync(join(dir, ".fapony", "done", "PLAN-old-gate.md"), "# OLD\n");
    writeFileSync(
      join(dir, ".fapony", "plan", "PLAN-wait-old.md"),
      activeBody("---\nstatus: blocked\nblocked_by: PLAN-old-gate.md\n---"),
    );
    inRepo(dir, () => {
      const active = [
        join(dir, ".fapony", "plan", "PLAN-doc-chain.md"),
        join(dir, ".fapony", "plan", "PLAN-dangle.md"),
        join(dir, ".fapony", "plan", "PLAN-ship-gate.md"),
        join(dir, ".fapony", "plan", "PLAN-wait-old.md"),
      ];
      const issues = collectDepIssues(active);
      assert.ok(
        issues.some(
          (i) => i.includes("PLAN-nope.md") && i.includes("no such file"),
        ),
        `dangling ref flagged:\n${issues.join("\n")}`,
      );
      assert.ok(
        issues.some(
          (i) =>
            i.includes("PLAN-old-gate.md") && i.includes("already shipped"),
        ),
        `shipped-but-still-blocked flagged:\n${issues.join("\n")}`,
      );
      // live waiter (ship-gate still in plan/) is not an issue
      assert.ok(
        !issues.some(
          (i) => i.includes("PLAN-doc-chain") && i.includes("already shipped"),
        ),
        "live blocker stays silent",
      );
    });
  });
  console.log("  ✓ dep issues: dangling + shipped-but-still-blocked");
});

test("testDepIssuesCycle", () => {
  withTempRepo((dir) => {
    setup(dir, {
      "PLAN-a.md": activeBody(
        "---\nstatus: blocked\nblocked_by: PLAN-b.md\n---",
      ),
      "PLAN-b.md": activeBody(
        "---\nstatus: blocked\nblocked_by: PLAN-a.md\n---",
      ),
    });
    inRepo(dir, () => {
      const issues = collectDepIssues([
        join(dir, ".fapony", "plan", "PLAN-a.md"),
        join(dir, ".fapony", "plan", "PLAN-b.md"),
      ]);
      assert.ok(
        issues.some((i) => i.startsWith("cycle:")),
        `cycle flagged:\n${issues.join("\n")}`,
      );
    });
  });
  console.log("  ✓ dep issues: waiter cycle flagged");
});

test("testBlockedTickedIsDeferredDebt", () => {
  withTempRepo((dir) => {
    setup(dir, {
      "PLAN-done-waiting.md": activeBody(
        "---\nstatus: blocked\nblocked_by: waiting on VPS\n---",
        "- [x] chunk 1 — landed\n- [x] chunk 2 — landed\n",
      ),
      "PLAN-half.md": activeBody(
        "---\nstatus: blocked\nblocked_by: waiting on VPS\n---",
        "- [x] chunk 1 — landed\n- [ ] chunk 2 — next\n",
      ),
      "PLAN-track.md": activeBody(
        "---\nkind: tracker\nstatus: blocked\nblocked_by: waiting on VPS\n---",
        "- [x] item 1\n- [x] item 2\n",
      ),
    });
    inRepo(dir, () => {
      const active = [
        join(dir, ".fapony", "plan", "PLAN-done-waiting.md"),
        join(dir, ".fapony", "plan", "PLAN-half.md"),
        join(dir, ".fapony", "plan", "PLAN-track.md"),
      ];
      assert.deepEqual(countFirstSection(active[0]), {
        checked: 2,
        unchecked: 0,
      });
      const issues = collectBlockedTickedIssues(active);
      assert.equal(
        issues.length,
        1,
        `only the all-ticked unit flags:\n${issues.join("\n")}`,
      );
      assert.match(issues[0], /PLAN-done-waiting\.md/);
    });
  });
  console.log("  ✓ blocked+ticked flags deferred debt, tracker excluded");
});

test("testPlanCheckEndToEndDepGraph", () => {
  withTempRepo((dir) => {
    setup(dir, {
      "PLAN-doc-chain.md": activeBody(
        "---\nstatus: blocked\nblocked_by: PLAN-ship-gate.md\n---",
        "- [x] chunk 1 — landed\n- [x] chunk 2 — landed\n",
      ),
    });
    const proc = Bun.spawnSync(["bun", FAPONY, "plan", "check"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = proc.stdout.toString();
    const err = proc.stderr.toString();
    // dangling (ship-gate nowhere) + blocked+ticked (all chunks ticked)
    assert.equal(proc.exitCode, 1, `plan-check must fail:\n${out}\n${err}`);
    assert.match(err, /blocked_by points at PLAN-ship-gate\.md/);
    assert.match(err, /all 2 chunk\(s\) ticked/);
    assert.match(out, /blocked plans \(1\)/);
  });
  console.log("  ✓ plan-check e2e: dep + ticked issues, blocked view shown");
});

test("testPlanSweepBlockedViewAndUnblockHint", () => {
  withTempRepo((dir) => {
    setup(dir, {
      "PLAN-ship-gate.md":
        "---\nstatus: active\nblocks: PLAN-doc-chain.md\n---\n\n# G\n\n> ✅ **shipped 2026-09-22** (abc1234)\n",
      "PLAN-doc-chain.md": activeBody(
        "---\nstatus: blocked\nblocked_by: PLAN-ship-gate.md\n---",
      ),
    });
    inRepo(dir, () => {
      // report-only names the blocked file even with a ship candidate present
      const out = captureLogs(() => cmdPlanSweep([]));
      assert.match(out, /blocked plans \(1\)/, `blocked view shown:\n${out}`);
      assert.match(out, /PLAN-doc-chain\.md/, "blocked file named");
      // single-file dry run says blocked, not "no shipped header"
      const one = captureLogs(() => cmdPlanSweep(["PLAN-doc-chain.md"]));
      assert.match(one, /status:blocked/, `dry run says blocked:\n${one}`);
    });
    // --apply through the real CLI prints the 🔓 unblock hint
    const proc = Bun.spawnSync(
      ["bun", FAPONY, "plan", "sweep", "PLAN-ship-gate.md", "--apply"],
      { cwd: dir, env: process.env, stdout: "pipe", stderr: "pipe" },
    );
    const out2 = proc.stdout.toString() + proc.stderr.toString();
    assert.equal(proc.exitCode, 0, `plan-sweep --apply must succeed:\n${out2}`);
    assert.match(
      out2,
      /🔓 PLAN-ship-gate\.md shipped — PLAN-doc-chain\.md list\(s\) it as blocker/,
      `unblock hint printed:\n${out2}`,
    );
  });
  console.log("  ✓ plan-sweep: blocked view + 🔓 unblock hint on ship");
});
