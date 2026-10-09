import { test } from "bun:test";
// test/plan-deps.test.ts — dep-graph + blocked views (PLAN-doc-chain/ship-gate slot):
// frontmatter blocked_by/blocks is already written by agents but no tool read
// it — plan-check now flags dangling refs, shipped-but-still-blocked, cycles,
// and blocked-with-all-chunks-ticked; plan-sweep reports blocked files and
// prints an unblock hint on --apply.

import assert from "node:assert";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initPlanStore } from "../src/plan/store.js";
import {
  cmdPlanSweep,
  collectBlockedTickedIssues,
  collectClosedBlockerWarns,
  collectDepIssues,
  collectPlaceholderWarns,
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
    // done/ is the status now — `status: active` is dropped, `blocks:` kept
    const done = readFileSync(
      join(dir, ".fapony", "done", "PLAN-ship-gate.md"),
      "utf8",
    );
    assert.ok(!/status:\s*active/.test(done), done);
    assert.match(done, /^---\nblocks: PLAN-doc-chain\.md\n---/);
  });
  console.log("  ✓ plan-sweep: blocked view + 🔓 unblock hint on ship");
});

test("testClosedBlockerWarnsOnlyOnEvidence", () => {
  withTempRepo((dir) => {
    setup(dir, {
      "PLAN-base.md": activeBody(
        "---\nkind: unit\n---",
        "- [x] chunk 1 — a\n- [x] chunk 2a — b\n- [x] chunk 2b — c\n- [x] m2 — d\n- [ ] m2b — left from m2\n- [x] chunk 3a — e\n- [ ] chunk 3b — f\n- [ ] chunk 4 — g\n",
      ),
      "PLAN-done-all.md": activeBody(
        "---\nkind: unit\n---",
        "- [x] chunk 1 — a\n",
      ),
      // ticked label · split siblings all closed · exact line beats a leftover
      "PLAN-w1.md": activeBody(
        "---\nblocked_by: PLAN-base.md chunk 1 (schema) + PLAN-base.md chunk 2, PLAN-base.md m2\n---",
      ),
      // whole-plan ref, every chunk closed
      "PLAN-w2.md": activeBody("---\nblocked_by: PLAN-done-all.md\n---"),
      // open chunk · split with an open part · sentence · other repo · missing label
      "PLAN-q.md": activeBody(
        "---\nstatus: blocked\nblocked_by: PLAN-base.md chunk 4 · PLAN-base.md chunk 3 · waiting on byyeah forms · fael PLAN-x.md chunk 1 · PLAN-base.md chunk 9\n---",
      ),
    });
    inRepo(dir, () => {
      const p = (n: string) => join(dir, ".fapony", "plan", n);
      const w = collectClosedBlockerWarns(
        ["PLAN-w1.md", "PLAN-w2.md", "PLAN-q.md"].map(p),
      ).map((l) => l.split(", which")[0]);
      assert.deepEqual(w, [
        "plan/PLAN-w1.md — blocked_by names PLAN-base.md chunk 1",
        "plan/PLAN-w1.md — blocked_by names PLAN-base.md chunk 2",
        "plan/PLAN-w1.md — blocked_by names PLAN-base.md chunk m2",
        "plan/PLAN-w2.md — blocked_by names PLAN-done-all.md",
      ]);
      // warn only — the frontmatter is never touched
      assert.match(readFileSync(p("PLAN-q.md"), "utf8"), /status: blocked/);
    });
  });
});

test("testPlaceholderWarnsInPlanAndCitedSpec", () => {
  withTempRepo((dir) => {
    setup(dir, {
      "PLAN-a.md": activeBody(
        "---\nspec: SPEC-a.md\n---",
        "- [ ] chunk 1 — (agent fills in)\n",
      ),
      "PLAN-b.md": activeBody(
        "---\nspec: SPEC-a.md\n---",
        "- [ ] chunk 1 — quotes `(agent fills in` only\n",
      ),
    });
    mkdirSync(join(dir, ".fapony", "spec"), { recursive: true });
    writeFileSync(
      join(dir, ".fapony", "spec", "SPEC-a.md"),
      "# SPEC-a — (agent fills in a title)\n\n```\n(agent fills in)\n```\n## (agent fills in — shapes)\n~~~\n(agent fills in)\n~~~\n",
    );
    inRepo(dir, () => {
      const w = collectPlaceholderWarns(
        ["PLAN-a.md", "PLAN-b.md"].map((n) => join(dir, ".fapony", "plan", n)),
      ).map((l) => l.split(" — ")[0]);
      // spec cited twice is read once; the fenced line is not counted
      assert.deepEqual(w, ["plan/PLAN-a.md:8", "spec/SPEC-a.md:1, 6"]);
    });
  });
});

test("testShippedBlockerMessageFollowsStatus", () => {
  withTempRepo((dir) => {
    setup(dir, {
      "PLAN-held.md": activeBody(
        "---\nstatus: blocked\nblocked_by: PLAN-gate.md\n---",
      ),
      "PLAN-free.md": activeBody("---\nblocked_by: PLAN-gate.md\n---"),
    });
    writeFileSync(join(dir, ".fapony", "done", "PLAN-gate.md"), "# G\n");
    inRepo(dir, () => {
      const [held, free] = collectDepIssues(
        ["PLAN-held.md", "PLAN-free.md"].map((n) =>
          join(dir, ".fapony", "plan", n),
        ),
      );
      assert.match(held, /PLAN-held\.md .* still status:blocked/);
      // a plan that never said status:blocked is not told it still does
      assert.doesNotMatch(free, /status:blocked/);
      assert.match(free, /fix: drop PLAN-gate\.md from blocked_by/);
    });
  });
});
