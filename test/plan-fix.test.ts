import { test } from "bun:test";
// test/plan-fix.test.ts — fael-boundary chunk 5: `plan check --fix` repairs
// only what has exactly one answer; plain `plan check` never writes.

import assert from "node:assert";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withTempRepo } from "./helpers.js";

const FAPONY = join(import.meta.dir, "..", "fapony.ts");
const git = (dir: string, cmd: string): string =>
  execSync(`git ${cmd}`, { cwd: dir }).toString().trim();

const check = (dir: string, ...args: string[]) => {
  const p = Bun.spawnSync(["bun", FAPONY, "plan", "check", ...args], {
    cwd: dir,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
};

// feature branch commit F, squash-merged onto the default branch as
// "<subject> (#12)", branch deleted → F is held by no ref.
function squashed(
  dir: string,
  subject = "feat: x",
  keepBranch = false,
): { f: string; sq: string } {
  const base = git(dir, "branch --show-current");
  git(dir, "switch -c feat");
  writeFileSync(join(dir, "x.txt"), "x\n");
  git(dir, "add x.txt");
  git(dir, `commit -m "${subject}"`);
  const f = git(dir, "rev-parse --short=7 HEAD");
  git(dir, `switch ${base}`);
  git(dir, "merge --squash feat");
  git(dir, `commit -m "${subject} (#12)"`);
  if (!keepBranch) git(dir, "branch -D feat");
  return { f, sq: git(dir, "rev-parse --short=7 HEAD") };
}

const writePlan = (dir: string, tick: string): string => {
  mkdirSync(join(dir, ".fapony/plan"), { recursive: true });
  mkdirSync(join(dir, ".fapony/done"), { recursive: true });
  const file = join(dir, ".fapony/plan/PLAN-a.md");
  writeFileSync(file, `# A\n\n## TL;DR\n- [ ] chunk 2 — b\n${tick}\n`);
  return file;
};

test("testFixRepointsSquashedTickOnlyWithFlag", () => {
  withTempRepo((dir) => {
    const { f, sq } = squashed(dir);
    const file = writePlan(dir, `- [x] chunk 1 — a (${f})`);
    const before = readFileSync(file, "utf8");
    const plain = check(dir);
    assert.equal(plain.code, 1);
    assert.match(plain.out, /no branch holds/);
    assert.equal(
      readFileSync(file, "utf8"),
      before,
      "plain check is read-only",
    );
    const fixed = check(dir, "--fix");
    assert.match(fixed.out, new RegExp(`tick ${f} → ${sq}`));
    assert.equal(readFileSync(file, "utf8"), before.replace(f, sq));
    assert.equal(check(dir).code, 0, "clean after --fix");
  });
  console.log("  ✓ --fix repoints a squashed tick; plain check never writes");
});

test("testFixLeavesUnmatchedTickAlone", () => {
  withTempRepo((dir) => {
    const { f } = squashed(dir);
    // a commit whose subject and patch match nothing on the default branch
    const base = git(dir, "branch --show-current");
    git(dir, "switch -c other");
    writeFileSync(join(dir, "y.txt"), "y\n");
    git(dir, "add y.txt");
    git(dir, 'commit -m "unrelated"');
    const lost = git(dir, "rev-parse --short=7 HEAD");
    git(dir, `switch ${base}`);
    git(dir, "branch -D other");
    const file = writePlan(dir, `- [x] chunk 1 — a (${lost})`);
    const before = readFileSync(file, "utf8");
    const r = check(dir, "--fix");
    assert.match(r.out, /no commit on the default branch matches/);
    assert.equal(readFileSync(file, "utf8"), before);
    assert.notEqual(f, lost);
  });
  console.log("  ✓ --fix reports, never guesses, when nothing matches");
});

test("testFixRepointsLinkToMovedPlanOutsideCode", () => {
  withTempRepo((dir) => {
    const file = writePlan(dir, "");
    writeFileSync(join(dir, ".fapony/done/PLAN-b.md"), "# B\n");
    const body = "[b](PLAN-b.md)\n\n```\n[b](PLAN-b.md)\n```\n";
    writeFileSync(file, `# A\n\n## TL;DR\n- [ ] chunk 1 — a\n\n${body}`);
    check(dir, "--fix");
    const out = readFileSync(file, "utf8");
    assert.match(out, /^\[b\]\(\.\.\/done\/PLAN-b\.md\)$/m);
    assert.match(
      out,
      /```\n\[b\]\(PLAN-b\.md\)\n```/,
      "fenced example untouched",
    );
  });
  console.log("  ✓ --fix repoints a moved-plan link, skips code fences");
});

test("testFixRepointsSquashedTickWhoseBranchStillLives", () => {
  withTempRepo((dir) => {
    // squash-merged, but the worktree branch was never pruned: the tick is
    // held (check is clean) yet not on the default branch (never "ready")
    const { f, sq } = squashed(dir, "feat: x", true);
    const file = writePlan(dir, `- [x] chunk 1 — a (${f})`);
    assert.equal(check(dir).code, 0);
    assert.match(check(dir, "--fix").out, new RegExp(`tick ${f} → ${sq}`));
    assert.match(readFileSync(file, "utf8"), new RegExp(`\\(${sq}\\)`));
    // a live branch commit with no successor is work in flight: left, silent
    const base = git(dir, "branch --show-current");
    git(dir, "switch -c wip");
    writeFileSync(join(dir, "w.txt"), "w\n");
    git(dir, "add w.txt");
    git(dir, 'commit -m "wip"');
    const wip = git(dir, "rev-parse --short=7 HEAD");
    git(dir, `switch ${base}`);
    const before = writePlan(dir, `- [x] chunk 1 — a (${wip})`);
    const text = readFileSync(before, "utf8");
    const r = check(dir, "--fix");
    assert.match(r.out, /nothing to repair/);
    assert.equal(readFileSync(before, "utf8"), text);
  });
  console.log("  ✓ --fix repoints a squashed tick even while its branch lives");
});

test("testFixSkipsLiveBranchNamesakeOfOlderSquash", () => {
  withTempRepo((dir) => {
    squashed(dir, "chore: lint"); // main: "chore: lint (#12)"
    const base = git(dir, "branch --show-current");
    git(dir, "switch -c feat2");
    writeFileSync(join(dir, "z.txt"), "z\n");
    git(dir, "add z.txt");
    git(dir, 'commit -m "chore: lint"');
    const mine = git(dir, "rev-parse --short=7 HEAD");
    git(dir, `switch ${base}`);
    const file = writePlan(dir, `- [x] chunk 1 — a (${mine})`);
    const before = readFileSync(file, "utf8");
    assert.match(check(dir, "--fix").out, /nothing to repair/);
    assert.equal(readFileSync(file, "utf8"), before);
  });
  console.log("  ✓ --fix never repoints in-flight work to an older namesake");
});

test("testCapitalXTickIsCheckedAndFixed", () => {
  withTempRepo((dir) => {
    const { f, sq } = squashed(dir);
    writePlan(dir, `- [X] chunk 1 — a (${f})`);
    assert.match(check(dir).out, /no branch holds/);
    assert.match(check(dir, "--fix").out, new RegExp(`tick ${f} → ${sq}`));
  });
  console.log("  ✓ `- [X]` ticks are checked and fixed like `- [x]`");
});
