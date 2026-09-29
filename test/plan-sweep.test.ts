import { test } from "bun:test";
// test/plan-sweep.test.ts — plan-sweep --apply link rewrite.
//
// Two fixed rounds of dangling links (mem mtjn3ldk, mtl15q4y):
//  1. own-file links were skipped in the sibling layout (plan/ → done/ beside
//     it) under "same depth, existing links still resolve" — same depth is not
//     the same directory, so [other](PLAN-other.md) dangled at done/PLAN-other.md.
//  2. inbound rewrite scanned plan/ only — links from done/ (shipped plans
//     reference each other) and spec/ were left pointing at the old path.

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
import { initPlanStore } from "../src/plan/store.js";
import {
  cmdPlanSweep,
  rewriteMarkdownLinks,
  rewriteMovedFileLinks,
} from "../src/plan/sweep.js";
import { withFakeFael, withTempRepo } from "./helpers.js";

const FAPONY = join(import.meta.dir, "..", "fapony.ts");

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "fapony-sweep-"));
  mkdirSync(join(d, "plan"), { recursive: true });
  mkdirSync(join(d, "done"), { recursive: true });
  mkdirSync(join(d, "spec"), { recursive: true });
  return d;
}

test("testRewriteMovedFileLinksSiblingLayout", () => {
  const d = tmp();
  try {
    const oldDir = join(d, "plan");
    const newDir = join(d, "done");
    writeFileSync(join(oldDir, "PLAN-b.md"), "# B\n");
    writeFileSync(join(d, "spec", "SPEC-x.md"), "# X\n");
    const file = join(newDir, "PLAN-a.md");
    writeFileSync(
      file,
      `# A\n\n[b](PLAN-b.md)\n[anch](PLAN-b.md#s1)\n[spec](../spec/SPEC-x.md)\n[broken](NOPE.md)\n[ext](https://x.test)\n[frag](#top)\n`,
    );
    const n = rewriteMovedFileLinks(file, oldDir, newDir);
    assert.equal(n, 2, "only the two sibling links change");
    const out = readFileSync(file, "utf8");
    assert.ok(out.includes("[b](../plan/PLAN-b.md)"), "sibling re-relativized");
    assert.ok(out.includes("[anch](../plan/PLAN-b.md#s1)"), "anchor survives");
    assert.ok(out.includes("[spec](../spec/SPEC-x.md)"), "spec link untouched");
    assert.ok(
      out.includes("[broken](NOPE.md)"),
      "broken link left for plan-check",
    );
    assert.ok(out.includes("[ext](https://x.test)"), "external untouched");
    assert.ok(out.includes("[frag](#top)"), "fragment untouched");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
  console.log(
    "  ✓ rewriteMovedFileLinks re-relativizes sibling links, ignores the rest",
  );
});

test("testRewriteMovedFileLinksNestedLayout", () => {
  const d = tmp();
  try {
    // legacy layout: done/ one level under plan/
    const oldDir = join(d, "plan");
    const newDir = join(d, "plan", "done");
    mkdirSync(newDir, { recursive: true });
    writeFileSync(join(oldDir, "PLAN-b.md"), "# B\n");
    const file = join(newDir, "PLAN-a.md");
    writeFileSync(file, `# A\n\n[b](PLAN-b.md)\n`);
    const n = rewriteMovedFileLinks(file, oldDir, newDir);
    assert.equal(n, 1);
    assert.ok(
      readFileSync(file, "utf8").includes("[b](../PLAN-b.md)"),
      "one level up from the nested done/",
    );
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
  console.log("  ✓ rewriteMovedFileLinks handles the nested plan/done/ layout");
});

test("testRewriteMarkdownLinksInbound", () => {
  const d = tmp();
  try {
    const oldAbs = join(d, "plan", "PLAN-a.md");
    const newAbs = join(d, "done", "PLAN-a.md");
    const f = join(d, "done", "PLAN-old.md");
    writeFileSync(
      f,
      `# OLD\n\n[a](../plan/PLAN-a.md)\n[a2](../plan/PLAN-a.md#s1)\n[other](PLAN-b.md)\n`,
    );
    const n = rewriteMarkdownLinks(f, oldAbs, newAbs);
    assert.equal(n, 2);
    const out = readFileSync(f, "utf8");
    assert.ok(out.includes("[a](PLAN-a.md)"), "same-dir after the move");
    assert.ok(out.includes("[a2](PLAN-a.md#s1)"), "anchor survives");
    assert.ok(out.includes("[other](PLAN-b.md)"), "unrelated link untouched");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
  console.log("  ✓ rewriteMarkdownLinks repoints inbound links, keeps anchors");
});

// End to end through the real CLI: sibling layout, inbound from plan/ + done/ +
// spec/, and a tracked doc outside .fapony/ that must be reported, not fixed.
test("testPlanSweepApplyEndToEnd", () => {
  withTempRepo((dir) => {
    mkdirSync(join(dir, ".fapony", "plan"), { recursive: true });
    mkdirSync(join(dir, ".fapony", "done"), { recursive: true });
    mkdirSync(join(dir, ".fapony", "spec"), { recursive: true });
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(
      join(dir, ".fapony/plan/PLAN-a.md"),
      `# A\n> ✅ **shipped 2026-09-22** (abc1234)\n\n[b](PLAN-b.md)\n[spec](../spec/SPEC-x.md)\n`,
    );
    writeFileSync(
      join(dir, ".fapony/plan/PLAN-b.md"),
      `# B\n\n[a](PLAN-a.md)\n`,
    );
    writeFileSync(
      join(dir, ".fapony/done/PLAN-old.md"),
      `# OLD\n\n[a](../plan/PLAN-a.md)\n`,
    );
    writeFileSync(
      join(dir, ".fapony/spec/SPEC-x.md"),
      `# X\n\n[a](../plan/PLAN-a.md)\n`,
    );
    writeFileSync(
      join(dir, "docs/NOTE.md"),
      `# note\n\nsee .fapony/plan/PLAN-a.md\n`,
    );
    execSync("git add .", { cwd: dir, stdio: "ignore" });
    execSync('git commit -m "plans"', { cwd: dir, stdio: "ignore" });

    const proc = Bun.spawnSync(
      ["bun", FAPONY, "plan", "sweep", "PLAN-a.md", "--apply"],
      { cwd: dir, stdout: "pipe", stderr: "pipe" },
    );
    const out = proc.stdout.toString() + proc.stderr.toString();
    assert.equal(proc.exitCode, 0, `plan-sweep must succeed:\n${out}`);

    const read = (p: string) => readFileSync(join(dir, p), "utf8");
    assert.ok(
      read(".fapony/done/PLAN-a.md").includes("[b](../plan/PLAN-b.md)"),
      "own sibling link re-relativized",
    );
    assert.ok(
      read(".fapony/done/PLAN-a.md").includes("[spec](../spec/SPEC-x.md)"),
      "own spec link untouched",
    );
    assert.ok(
      read(".fapony/plan/PLAN-b.md").includes("[a](../done/PLAN-a.md)"),
      "inbound from plan/ fixed",
    );
    assert.ok(
      read(".fapony/done/PLAN-old.md").includes("[a](PLAN-a.md)"),
      "inbound from done/ fixed",
    );
    assert.ok(
      read(".fapony/spec/SPEC-x.md").includes("[a](../done/PLAN-a.md)"),
      "inbound from spec/ fixed",
    );
    assert.ok(
      read("docs/NOTE.md").includes(".fapony/plan/PLAN-a.md"),
      "outside files are detect-only, never rewritten",
    );
    assert.match(
      out,
      /files outside .* still mention/,
      "outside mention is reported",
    );
  });
  console.log(
    "  ✓ plan-sweep --apply fixes own + plan/done/spec inbound, reports the rest",
  );
});

// The SKILL example passes the repo-relative path — it must resolve, not "not found".
test("testPlanSweepAcceptsRepoRelativePath", () => {
  withTempRepo((dir) => {
    mkdirSync(join(dir, ".fapony", "plan"), { recursive: true });
    mkdirSync(join(dir, ".fapony", "done"), { recursive: true });
    writeFileSync(
      join(dir, ".fapony/plan/PLAN-a.md"),
      `# A\n> ✅ **shipped 2026-09-22** (abc1234)\n`,
    );
    const proc = Bun.spawnSync(
      ["bun", FAPONY, "plan", "sweep", ".fapony/plan/PLAN-a.md", "--apply"],
      { cwd: dir, stdout: "pipe", stderr: "pipe" },
    );
    const out = proc.stdout.toString() + proc.stderr.toString();
    assert.equal(proc.exitCode, 0, `repo-relative path must resolve:\n${out}`);
    assert.match(out, /moved .*PLAN-a\.md → .*PLAN-a\.md/);
  });
  console.log("  ✓ plan-sweep --apply accepts the repo-relative path form");
});

// The in-process entry — guards the target-resolution fallback without spawning bun.
test("testCmdPlanSweepInProcess", () => {
  withTempRepo((dir) => {
    mkdirSync(join(dir, ".fapony", "plan"), { recursive: true });
    mkdirSync(join(dir, ".fapony", "done"), { recursive: true });
    writeFileSync(
      join(dir, ".fapony/plan/PLAN-a.md"),
      `# A\n> ✅ **shipped 2026-09-22** (abc1234)\n`,
    );
    const prev = process.cwd();
    process.chdir(dir);
    try {
      initPlanStore(dir);
      cmdPlanSweep(["PLAN-a.md", "--apply"]);
    } finally {
      process.chdir(prev);
    }
    assert.ok(
      readFileSync(join(dir, ".fapony/done/PLAN-a.md"), "utf8").includes(
        "shipped",
      ),
      "file moved to done/",
    );
  });
  console.log("  ✓ cmdPlanSweep moves the file in-process");
});

// A repo that keeps .fapony/ out of git (public repo, private plans) and a
// plan closed as superseded rather than shipped: both used to refuse, so the
// archive was a hand mv + hand link fixes every time (mudzqnpu, 2026-09-25).
test("testPlanSweepSupersededUntrackedPlan", () => {
  withTempRepo((dir) => {
    mkdirSync(join(dir, ".fapony", "plan"), { recursive: true });
    mkdirSync(join(dir, ".fapony", "done"), { recursive: true });
    writeFileSync(join(dir, ".gitignore"), ".fapony/\n");
    writeFileSync(
      join(dir, ".fapony/plan/PLAN-a.md"),
      `---\nstatus: superseded\nsuperseded_by: fael\n---\n# A\n\n[b](PLAN-b.md)\n`,
    );
    writeFileSync(
      join(dir, ".fapony/plan/PLAN-b.md"),
      `# B\n\n[a](PLAN-a.md)\n`,
    );
    const sweep = (...args: string[]) => {
      const p = Bun.spawnSync(["bun", FAPONY, "plan", "sweep", ...args], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      });
      return {
        code: p.exitCode,
        out: p.stdout.toString() + p.stderr.toString(),
      };
    };
    assert.match(sweep("PLAN-a.md").out, /superseded — ready to move/);
    const { code, out } = sweep("PLAN-a.md", "--apply");
    assert.equal(code, 0, `superseded + untracked must move:\n${out}`);
    assert.match(out, /not tracked by git — moved with a plain rename/);
    const read = (p: string) => readFileSync(join(dir, p), "utf8");
    assert.ok(
      read(".fapony/done/PLAN-a.md").includes("[b](../plan/PLAN-b.md)"),
    );
    assert.ok(
      read(".fapony/plan/PLAN-b.md").includes("[a](../done/PLAN-a.md)"),
    );
  });
  console.log(
    "  ✓ plan-sweep --apply archives a superseded plan in an untracked .fapony/",
  );
});

// Handoff notes and decisions about a plan are its history — they travel with
// it (basename match survives the move). Only an open issue is unfinished work.
// Closing PLAN-convention-debt took 4 hand-closed notes + MEM_FORCE (2026-09-26).
test("testPlanSweepBlocksOnOpenIssuesOnly", () => {
  withTempRepo((dir) => {
    mkdirSync(join(dir, ".fapony", "plan"), { recursive: true });
    mkdirSync(join(dir, ".fapony", "done"), { recursive: true });
    const plan = (n: string) =>
      writeFileSync(
        join(dir, `.fapony/plan/${n}`),
        `# ${n}\n> ✅ **shipped 2026-09-26** (abc1234)\n`,
      );
    plan("PLAN-a.md");
    plan("PLAN-b.md");
    const files = (n: string) => [`.fapony/plan/${n}`];
    const sweep = (n: string) =>
      Bun.spawnSync(["bun", FAPONY, "plan", "sweep", n, "--apply"], {
        cwd: dir,
        env: process.env, // the fake fael lives on the live PATH
        stdout: "pipe",
        stderr: "pipe",
      });
    withFakeFael((setRows) => {
      setRows([
        {
          id: "n1",
          ts: "2026-09-26T00:00:00Z",
          kind: "note",
          text: "handoff",
          files: files("PLAN-a.md"),
        },
        {
          id: "d1",
          ts: "2026-09-26T00:00:00Z",
          kind: "decision",
          text: "why",
          files: files("PLAN-a.md"),
        },
        {
          id: "i1",
          ts: "2026-09-26T00:00:00Z",
          kind: "issue",
          text: "still broken",
          files: files("PLAN-b.md"),
        },
      ]);
      const a = sweep("PLAN-a.md");
      assert.equal(
        a.exitCode,
        0,
        `notes/decisions must not block:\n${a.stderr}`,
      );
      const b = sweep("PLAN-b.md");
      assert.equal(b.exitCode, 1, "an open issue blocks");
      assert.match(b.stderr.toString(), /open issue.*\n.*\[i1\]/);
    });
  });
  console.log(
    "  ✓ plan-sweep --apply blocks on open issues, not notes/decisions",
  );
});

// Closing ceremony (PLAN-plan-adopt chunk 3): a sole-key `plan:<name>:chunk-N`
// row names the plan with no files[] at all, and a files[] entry of the same
// anchor-prefixed shape does too — both must block the sweep like a path row.
test("testPlanSweepBlocksOnAnchorPrefixedRows", () => {
  withTempRepo((dir) => {
    mkdirSync(join(dir, ".fapony", "plan"), { recursive: true });
    mkdirSync(join(dir, ".fapony", "done"), { recursive: true });
    const plan = (n: string) =>
      writeFileSync(
        join(dir, `.fapony/plan/${n}`),
        `# ${n}\n> ✅ **shipped 2026-09-29** (abc1234)\n`,
      );
    plan("PLAN-a.md");
    plan("PLAN-b.md");
    plan("PLAN-c.md");
    const sweep = (n: string) =>
      Bun.spawnSync(["bun", FAPONY, "plan", "sweep", n, "--apply"], {
        cwd: dir,
        env: process.env, // the fake fael lives on the live PATH
        stdout: "pipe",
        stderr: "pipe",
      });
    withFakeFael((setRows) => {
      setRows([
        {
          id: "k1",
          ts: "2026-09-29T00:00:00Z",
          kind: "issue",
          text: "handoff still open",
          key: "plan:b:chunk-1",
        },
        {
          id: "f1",
          ts: "2026-09-29T00:00:00Z",
          kind: "issue",
          text: "handoff still open",
          files: ["plan:c:chunk-2"],
        },
        {
          id: "u1",
          ts: "2026-09-29T00:00:00Z",
          kind: "issue",
          text: "some other plan",
          key: "plan:unrelated:chunk-1",
        },
      ]);
      const a = sweep("PLAN-a.md");
      assert.equal(
        a.exitCode,
        0,
        `an unrelated anchor must not block:\n${a.stderr}`,
      );
      const b = sweep("PLAN-b.md");
      assert.equal(b.exitCode, 1, "a sole-key plan:b:chunk-1 row blocks");
      assert.match(b.stderr.toString(), /open issue.*\n.*\[k1\]/);
      const c = sweep("PLAN-c.md");
      assert.equal(c.exitCode, 1, "a files[] plan:c:chunk-2 row blocks");
      assert.match(c.stderr.toString(), /open issue.*\n.*\[f1\]/);
    });
  });
  console.log(
    "  ✓ plan-sweep --apply blocks on anchor-prefixed key/files rows",
  );
});

// An editor/agent that pastes file:///abs/path links writes a link that works
// on one machine only. plan check used to call it "broken … no such file in
// plan/" even when the file existed; it now names the relative path to use.
test("testPlanCheckFileUrlLinkSuggestsRelativePath", () => {
  withTempRepo((dir) => {
    mkdirSync(join(dir, ".fapony", "plan"), { recursive: true });
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/x.ts"), "export {};\n");
    writeFileSync(
      join(dir, ".fapony/plan/PLAN-a.md"),
      `# A\n\n- [x](file://${dir}/src/x.ts)\n- [gone](file://${dir}/src/gone.ts)\n`,
    );
    const p = Bun.spawnSync(["bun", FAPONY, "plan", "check"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const err = p.stderr.toString();
    assert.equal(p.exitCode, 1, err);
    assert.match(
      err,
      /PLAN-a\.md:3 — absolute file:\/\/ link.*\n.*use \.\.\/\.\.\/src\/x\.ts/,
    );
    assert.match(err, /PLAN-a\.md:4 — broken link → file:\/\/.*gone\.ts/);
    assert.doesNotMatch(err, /no such file in plan\//);
  });
  console.log("  ✓ plan check turns a file:// link into its relative path");
});
